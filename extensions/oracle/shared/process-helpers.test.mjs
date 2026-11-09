import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as helpers from "./process-helpers.mjs";

test("command timeout has a typed identity without changing allowFailure", async () => {
  await assert.rejects(helpers.runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 }), (error) => {
    assert.equal(error.constructor, helpers.CommandTimeoutError);
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.timeoutMs, 100);
    assert.match(error.message, /timed out after 100ms/);
    return true;
  });
  const result = await helpers.runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100, allowFailure: true });
  assert.equal(result.timedOut, true);
});

test("socket directory follows the driver override, XDG, home, temp and namespace rules", () => {
  const dirs = { homedir: () => "/home/operator", tmpdir: () => "/tmp", platform: "darwin" };
  assert.equal(helpers.resolveAgentBrowserSocketDir({ AGENT_BROWSER_SOCKET_DIR: "/sockets", XDG_RUNTIME_DIR: "/xdg" }, dirs), "/sockets");
  assert.equal(helpers.resolveAgentBrowserSocketDir({ AGENT_BROWSER_SOCKET_DIR: "", XDG_RUNTIME_DIR: "/xdg" }, dirs), "/xdg/agent-browser");
  assert.equal(helpers.resolveAgentBrowserSocketDir({}, dirs), "/home/operator/.agent-browser");
  assert.equal(helpers.resolveAgentBrowserSocketDir({}, { ...dirs, homedir: () => "" }), "/tmp/agent-browser");
  assert.equal(helpers.resolveAgentBrowserSocketDir({ AGENT_BROWSER_NAMESPACE: " --Agent__ " }, dirs), "/home/operator/.agent-browser/namespaces/agent/run");
  // v0.41.2 applies XDG on Windows as well.
  assert.equal(helpers.resolveAgentBrowserSocketDir({ XDG_RUNTIME_DIR: "/xdg" }, { ...dirs, platform: "win32" }), "/xdg/agent-browser");
});

test("close removes only an absent session's sidecars and supplies private env defaults", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "oracle-process-test-"));
  const saved = { ...process.env };
  const binary = join(dir, "driver");
  const state = join(dir, "state");
  const log = join(dir, "calls");
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, web: process.env.AGENT_BROWSER_NO_WEBMCP, version: process.env.AGENT_BROWSER_NO_VERSION_CHECK }) + '\\n');
const state = ${JSON.stringify(state)};
if (fs.readFileSync(state, 'utf8') === 'unreadable') process.exit(1);
if (args[0] === 'session') console.log(fs.readFileSync(state, 'utf8'));
else if (args.at(-1) === 'close') fs.writeFileSync(state, '');
`, { mode: 0o700 });
  try {
    process.env.AGENT_BROWSER_SOCKET_DIR = dir;
    delete process.env.AGENT_BROWSER_NAMESPACE;
    delete process.env.AGENT_BROWSER_NO_WEBMCP;
    delete process.env.AGENT_BROWSER_NO_VERSION_CHECK;
    const object = {};
    helpers.applyAgentBrowserEnvDefaults(object);
    assert.deepEqual(object, { AGENT_BROWSER_NO_WEBMCP: "1", AGENT_BROWSER_NO_VERSION_CHECK: "1" });
    for (const listed of [true, false]) {
      await writeFile(state, listed ? "s1" : "");
      await writeFile(log, "");
      for (const name of ["s1.config", "s1.target", "s2.target"]) await writeFile(join(dir, name), "private");
      assert.equal(await helpers.closeAgentBrowserSession(binary, ["--session", "s1"], "s1", { timeoutMs: 1000 }), listed);
      await assert.rejects(access(join(dir, "s1.target")));
      await assert.rejects(access(join(dir, "s1.config")));
      await access(join(dir, "s2.target"));
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(calls.filter((call) => call.args.at(-1) === "close").length, listed ? 1 : 0);
      assert.ok(calls.every((call) => call.web === "1" && call.version === "1"));
      assert.equal(process.env.AGENT_BROWSER_NO_WEBMCP, undefined);
      assert.equal(process.env.AGENT_BROWSER_NO_VERSION_CHECK, undefined);
    }
    await writeFile(state, "unreadable");
    await writeFile(join(dir, "s1.target"), "private");
    await assert.rejects(helpers.closeAgentBrowserSession(binary, [], "s1", { timeoutMs: 1000 }), /inventory is unavailable/);
    await access(join(dir, "s1.target"));
    assert.deepEqual(await helpers.removeAgentBrowserSessionSidecars("../s2"), []);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});
