import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { acquireManagedBrowser, assertManagedBrowserAvailable, inspectManagedBrowser, MANAGED_BROWSER_LOCK_KIND, MANAGED_BROWSER_USER_KIND, managedChromeArgs, releaseManagedBrowser } from "./managed-browser-helpers.mjs";
import { isProcessAlive } from "./process-helpers.mjs";
import { withStateLock, writeStateLeaseMetadata } from "./state-coordination-helpers.mjs";

const IDLE_MS = 300;

// Chrome's contract as measured on Chrome 153: a second launch on a held profile hands off and exits 0,
// SingletonLock names the holder, DevToolsActivePort outlives the process, and SIGTERM is a clean quit.
const FAKE_CHROME = `#!${process.execPath}
const { appendFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { hostname } = require("node:os");
const { join } = require("node:path");
const dir = process.argv.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
appendFileSync(join(dir, "launches.log"), process.argv.slice(2).join(" ") + "\\n");
const lock = join(dir, "SingletonLock");
try { process.kill(Number(readlinkSync(lock).split("-").pop()), 0); process.exit(0); } catch {}
rmSync(lock, { force: true });
symlinkSync(hostname() + "-" + process.pid, lock);
const id = randomUUID();
const pages = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/json/version") return response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:" + server.address().port + "/devtools/browser/" + id }));
  if (url.pathname === "/json/list") return response.end(JSON.stringify(pages));
  if (url.pathname === "/json/new") { const page = { id: randomUUID(), type: "page", url: url.search.slice(1) }; pages.push(page); return response.end(JSON.stringify(page)); }
  if (url.pathname.startsWith("/json/close/")) { pages.splice(pages.findIndex((page) => page.id === url.pathname.slice(12)), 1); return response.end("{}"); }
  response.statusCode = 404;
  response.end("{}");
});
server.listen(0, "127.0.0.1", () => writeFileSync(join(dir, "DevToolsActivePort"), server.address().port + "\\n/devtools/browser/" + id));
process.on("SIGTERM", () => { rmSync(lock, { force: true }); process.exit(0); });
`;

/** @param {import("node:test").TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "oracle-managed-browser-"));
  const profileDir = join(root, "profile");
  const stateDir = join(root, "state");
  const executablePath = join(root, "chrome");
  await mkdir(profileDir);
  await writeFile(executablePath, FAKE_CHROME);
  await chmod(executablePath, 0o700);
  const previous = { state: process.env.PI_ORACLE_STATE_DIR, idle: process.env.PI_ORACLE_MANAGED_BROWSER_IDLE_MS };
  // The keeper inherits these: the same state dir as the caller, and a test-sized idle grace.
  process.env.PI_ORACLE_STATE_DIR = stateDir;
  process.env.PI_ORACLE_MANAGED_BROWSER_IDLE_MS = String(IDLE_MS);
  t.after(async () => {
    const holder = holderPid(profileDir);
    if (holder && holder !== process.pid) process.kill(holder, "SIGKILL");
    for (const [name, value] of [["PI_ORACLE_STATE_DIR", previous.state], ["PI_ORACLE_MANAGED_BROWSER_IDLE_MS", previous.idle]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // The keeper logs and releases the profile lock as its Chrome exits, racing this removal.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { profileDir, stateDir, executablePath };
}

/** @param {string} profileDir */
function holderPid(profileDir) {
  try {
    return Number(readlinkSync(join(profileDir, "SingletonLock")).split("-").pop());
  } catch {
    return undefined;
  }
}

/** @param {string} profileDir */
function launchCount(profileDir) {
  const log = join(profileDir, "launches.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
}

/** @param {() => boolean | Promise<boolean>} predicate */
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

test("concurrent jobs share one Oracle-launched browser, which quits only after the last lease and page are gone", { skip: process.platform === "win32" }, async (t) => {
  const { profileDir, stateDir, executablePath } = await fixture(t);
  const attach = (owner) => acquireManagedBrowser({ stateDir, profileDir, executablePath, owner });
  const [first, second] = await Promise.all([attach("job:a"), attach("job:b")]);
  assert.deepEqual([first.launched, second.launched].sort(), [false, true], "exactly one attach launches Chrome");
  assert.equal(first.browserUrl, second.browserUrl);
  assert.equal(launchCount(profileDir), 1);
  const chromePid = holderPid(profileDir);
  assert.ok(chromePid && isProcessAlive(chromePid));

  await releaseManagedBrowser(stateDir, first.leaseKey);
  await sleep(IDLE_MS * 3);
  assert.ok(isProcessAlive(chromePid), "a live lease keeps the browser open past the idle grace");

  const signIn = await (await fetch(`${first.endpoint}/json/new?https://chatgpt.com/`, { method: "PUT" })).json();
  await releaseManagedBrowser(stateDir, second.leaseKey);
  await sleep(IDLE_MS * 3);
  assert.ok(isProcessAlive(chromePid), "a page someone opened keeps the browser open with no lease left");

  await fetch(`${first.endpoint}/json/close/${signIn.id}`);
  assert.ok(await waitFor(() => !isProcessAlive(chromePid)), "the keeper quits its browser once nothing uses it");
  assert.equal((await inspectManagedBrowser(profileDir)).state, "stopped", "the DevToolsActivePort left behind is not a running browser");

  const reopened = await attach("job:c");
  assert.equal(reopened.launched, true, "the next job reopens the profile");
  assert.notEqual(reopened.browserUrl, first.browserUrl);
  await releaseManagedBrowser(stateDir, reopened.leaseKey);
});

test("a browser Oracle did not launch is reused and never quit", { skip: process.platform === "win32" }, async (t) => {
  const { profileDir, stateDir, executablePath } = await fixture(t);
  const external = spawn(executablePath, managedChromeArgs(profileDir), { stdio: "ignore" });
  t.after(() => external.kill("SIGKILL"));
  assert.ok(await waitFor(async () => (await inspectManagedBrowser(profileDir)).state === "running"));

  const attached = await acquireManagedBrowser({ stateDir, profileDir, executablePath, owner: "job:a" });
  assert.equal(attached.launched, false);
  await releaseManagedBrowser(stateDir, attached.leaseKey);
  await sleep(IDLE_MS * 4);
  assert.equal(external.exitCode, null, "no keeper exists for a browser Oracle found running");
  assert.equal(launchCount(profileDir), 1, "Oracle never launched a second Chrome");
});

test("a job that attaches while the idle keeper waits for the profile lock keeps the browser", { skip: process.platform === "win32" }, async (t) => {
  const { profileDir, stateDir, executablePath } = await fixture(t);
  const launched = await acquireManagedBrowser({ stateDir, profileDir, executablePath, owner: "job:a" });
  const chromePid = holderPid(profileDir);
  // Hold the profile lock across the idle grace, as an attach in progress does, so the keeper
  // decides to quit, then blocks on the lock while the attach writes its lease.
  await withStateLock(stateDir, MANAGED_BROWSER_LOCK_KIND, profileDir, { processPid: process.pid }, async () => {
    await releaseManagedBrowser(stateDir, launched.leaseKey);
    await sleep(IDLE_MS * 3);
    await writeStateLeaseMetadata(stateDir, MANAGED_BROWSER_USER_KIND, "job:b", { leaseKey: "job:b", profileDir, owner: "job:b", processPid: process.pid, createdAt: new Date().toISOString() });
  });
  await sleep(IDLE_MS * 2);
  assert.ok(isProcessAlive(chromePid), "the keeper re-checks under the lock and keeps a browser a job just attached to");
  await releaseManagedBrowser(stateDir, "job:b");
  assert.ok(await waitFor(() => !isProcessAlive(chromePid)), "the browser still quits once that job is done");
});

test("a profile held without a DevTools endpoint blocks attach and readiness instead of launching", { skip: process.platform === "win32" }, async (t) => {
  const { profileDir, stateDir, executablePath } = await fixture(t);
  // A live local process holds the profile lock and no endpoint exists: Chrome opened without port 0.
  symlinkSync(`${hostname()}-${process.pid}`, join(profileDir, "SingletonLock"));
  await assert.rejects(acquireManagedBrowser({ stateDir, profileDir, executablePath, owner: "job:a" }), /open in a Chrome without Oracle's DevTools endpoint/);
  await assert.rejects(assertManagedBrowserAvailable(stateDir, profileDir), /open in a Chrome without Oracle's DevTools endpoint/);
  assert.equal(launchCount(profileDir), 0, "a launch would open a window in the holder's browser");
});

test("a crashed browser's leftovers never bind the profile to another live browser", { skip: process.platform === "win32" }, async (t) => {
  const { profileDir, stateDir, executablePath } = await fixture(t);
  // Another profile's browser (say, a different account) now listens on the port the crashed one wrote down.
  const otherProfile = join(profileDir, "..", "other-profile");
  await mkdir(otherProfile);
  const other = spawn(executablePath, managedChromeArgs(otherProfile), { stdio: "ignore" });
  t.after(() => other.kill("SIGKILL"));
  assert.ok(await waitFor(async () => (await inspectManagedBrowser(otherProfile)).state === "running"));
  const otherPort = readFileSync(join(otherProfile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const crashed = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => crashed.once("exit", resolve));
  symlinkSync(`${hostname()}-${crashed.pid}`, join(profileDir, "SingletonLock"));
  writeFileSync(join(profileDir, "DevToolsActivePort"), `${otherPort}\n/devtools/browser/crashed`);

  assert.equal((await inspectManagedBrowser(profileDir)).state, "stopped");
  await assertManagedBrowserAvailable(stateDir, profileDir);
  const attached = await acquireManagedBrowser({ stateDir, profileDir, executablePath, owner: "job:a" });
  assert.equal(attached.launched, true, "the profile gets its own browser");
  assert.notEqual(attached.endpoint, `http://127.0.0.1:${otherPort}`, "never the other profile's browser");
  await releaseManagedBrowser(stateDir, attached.leaseKey);
});

test("browser.args cannot replace the managed profile or DevTools flags", () => {
  for (const arg of ["--user-data-dir=/tmp/other", "--remote-debugging-port=9222", "--remote-debugging-address=0.0.0.0", "--remote-allow-origins=*"]) {
    assert.throws(() => managedChromeArgs("/tmp/profile", [arg]), /cannot override oracle-managed Chrome launch isolation flag/);
  }
  assert.ok(managedChromeArgs("/tmp/profile", ["--disable-blink-features=AutomationControlled"]).includes("--remote-debugging-address=127.0.0.1"));
});
