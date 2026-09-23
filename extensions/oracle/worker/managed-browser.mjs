// Purpose: Own one Oracle-launched managed ChatGPT Chrome for its whole life: start it, report its endpoint, and quit it once nothing uses it.
// Responsibilities: Spawn Chrome on the managed profile, hand its DevTools endpoint to the attaching process, watch leases and open pages, and quit Chrome after the idle grace.
// Scope: Detached process started by shared/managed-browser-helpers.mjs; it never signals a Chrome it did not spawn.
// Usage: node managed-browser.mjs '<ManagedBrowserLaunchSpec JSON>'
// Invariants/Assumptions: Chrome is this process's child, so a quit reaches exactly that process; the idle quit runs under the profile lock after re-checking that no lease holder or page remains.
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { sweetCookieSafeStoragePasswordScrubbedEnv } from "../shared/browser-profile-helpers.mjs";
import { inspectManagedBrowser, MANAGED_BROWSER_LOCK_KIND, managedBrowserInUse, managedChromeArgs, managedProfileHolderPid } from "../shared/managed-browser-helpers.mjs";
import { withStateLock } from "../shared/state-coordination-helpers.mjs";
import { getOracleStateDir } from "../shared/state-path-helpers.mjs";
import { sleep } from "../shared/time-helpers.mjs";

/** @type {import("../shared/managed-browser-helpers.d.mts").ManagedBrowserLaunchSpec} */
const spec = JSON.parse(process.argv[2] ?? "{}");
const stateDir = getOracleStateDir();
const logPath = join(stateDir, "managed-browser.log");
// The attaching process stops reading after the handshake; a late write must not crash the keeper.
process.stdout.on("error", () => undefined);

/** @param {string} message */
async function log(message) {
  await appendFile(logPath, `[${new Date().toISOString()}] keeper ${process.pid} ${spec.profileDir}: ${message}\n`, { mode: 0o600 }).catch(() => undefined);
}

const chrome = spawn(spec.executablePath, managedChromeArgs(spec.profileDir, spec.args), {
  stdio: "ignore",
  env: sweetCookieSafeStoragePasswordScrubbedEnv(),
});
/** @type {string | undefined} */
let chromeExit;
const chromeExited = new Promise((resolve) => {
  chrome.once("exit", (code, signal) => {
    chromeExit = signal ?? `exit code ${code}`;
    resolve(undefined);
  });
  chrome.once("error", (error) => {
    chromeExit = error.message;
    resolve(undefined);
  });
});

async function quitChrome() {
  if (chromeExit) return;
  // Chrome handles SIGTERM as a normal quit: the profile records a clean exit and no restore prompt.
  chrome.kill("SIGTERM");
  await Promise.race([chromeExited, sleep(15_000)]);
  if (chromeExit) return;
  chrome.kill("SIGKILL");
  await Promise.race([chromeExited, sleep(5_000)]);
}

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
  process.once(signal, () => {
    void quitChrome().finally(() => process.exit(0));
  });
}

async function waitForOwnEndpoint() {
  const deadline = Date.now() + spec.launchTimeoutMs;
  while (Date.now() < deadline) {
    if (chromeExit) throw new Error(`Chrome exited before its DevTools endpoint was ready (${chromeExit}); the profile may be open in another Chrome.`);
    const current = await inspectManagedBrowser(spec.profileDir);
    // Report only this child's endpoint, never one a Chrome started by someone else happens to serve.
    if (current.state === "running" && (process.platform === "win32" || managedProfileHolderPid(spec.profileDir) === chrome.pid)) return current;
    await sleep(100);
  }
  throw new Error(`Chrome did not serve a DevTools endpoint for ${spec.profileDir} within ${spec.launchTimeoutMs}ms.`);
}

let endpoint = "";
try {
  const ready = await waitForOwnEndpoint();
  endpoint = ready.endpoint;
  process.stdout.write(`${JSON.stringify({ endpoint: ready.endpoint, browserUrl: ready.browserUrl })}\n`);
  await log(`started Chrome ${chrome.pid} at ${ready.endpoint}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  await log(`launch failed: ${message}`);
  await quitChrome();
  process.exit(1);
}

const tickMs = Math.max(50, Math.min(2_000, Math.floor(spec.idleMs / 4)));
/** @type {number | undefined} */
let idleSince;
while (!chromeExit) {
  await Promise.race([chromeExited, sleep(tickMs)]);
  if (chromeExit) break;
  if (await managedBrowserInUse(stateDir, spec.profileDir, endpoint)) {
    idleSince = undefined;
    continue;
  }
  idleSince ??= Date.now();
  if (Date.now() - idleSince < spec.idleMs) continue;
  const quit = await withStateLock(stateDir, MANAGED_BROWSER_LOCK_KIND, spec.profileDir, { processPid: process.pid, owner: "keeper", action: "idle-quit" }, async () => {
    // A job may have leased the browser between the idle check and this lock.
    if (await managedBrowserInUse(stateDir, spec.profileDir, endpoint)) return false;
    await quitChrome();
    return true;
  }, 60_000).catch(() => false);
  if (quit) await log(`quit Chrome ${chrome.pid} after ${spec.idleMs}ms with no job and no page`);
  else idleSince = undefined;
}
await log(`Chrome ${chrome.pid} exited (${chromeExit})`);
process.exit(0);
