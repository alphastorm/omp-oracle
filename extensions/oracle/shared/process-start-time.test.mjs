import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

// Import after patching the built-in so the test observes synchronous process-table reads.
let synchronousReads = 0;
let replacement;
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, ...rest) {
  if (file === "ps" || file === "powershell.exe") {
    synchronousReads += 1;
    if (replacement && args.includes(String(replacement.pid))) return `${replacement.value}\n`;
  }
  return Reflect.apply(originalExecFileSync, this, [file, args, ...rest]);
};
syncBuiltinESMExports();
const helpers = await import("./process-helpers.mjs");

test("process start identities are cached, batch-primed, and fresh before signals", async (t) => {
  t.after(() => { childProcess.execFileSync = originalExecFileSync; syncBuiltinESMExports(); });
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(child, "spawn");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  });
  const pid = child.pid;
  let startedAt;

  await t.test("repeated live reads do not synchronously invoke ps twice", () => {
    synchronousReads = 0;
    startedAt = helpers.readProcessStartedAt(pid);
    assert.ok(startedAt);
    assert.equal(helpers.readProcessStartedAt(pid), startedAt);
    assert.equal(synchronousReads, 1);
    synchronousReads = 0;
    assert.ok(helpers.readProcessStartedAt(process.pid));
    assert.ok(helpers.readProcessStartedAt(process.pid));
    assert.equal(synchronousReads, 1, "own identity is cached for the process lifetime");
    for (const invalid of [undefined, 0, -1, NaN, Infinity, 1.5]) assert.equal(helpers.readProcessStartedAt(invalid), undefined);
  });

  await t.test("batched reads preserve exact single-pid lstart spacing", { skip: !["darwin", "linux"].includes(process.platform) }, async () => {
    const now = Date.now;
    const clock = t.mock.method(Date, "now", () => now() + 2_050);
    try {
      synchronousReads = 0;
      await helpers.primeProcessStartedAt([pid, pid, process.pid, undefined, -1]);
      assert.equal(helpers.readProcessStartedAt(pid), startedAt);
      assert.equal(synchronousReads, 0, "priming and the subsequent cache hit are asynchronous");
      assert.equal(helpers.readProcessStartedAtFresh(pid), startedAt);
      assert.equal(synchronousReads, 1, "fresh reads bypass the cache");
    } finally { clock.mock.restore(); }
  });

  await t.test("cached identities cannot authorize a signal to a reused pid", { skip: process.platform === "win32" }, async () => {
    assert.equal(helpers.readProcessStartedAt(pid), startedAt);
    replacement = { pid, value: "Mon Jan  1 00:00:00 2001" };
    const signals = [];
    const kill = process.kill;
    process.kill = function (target, signal) {
      if (signal && signal !== 0) { signals.push(signal); return true; }
      return kill(target, signal);
    };
    try {
      assert.equal(await helpers.terminateTrackedProcess(pid, startedAt, { termGraceMs: 1, killGraceMs: 1 }), false);
      assert.deepEqual(signals, []);
    } finally { process.kill = kill; replacement = undefined; }
  });

  await t.test("a dead process evicts a primed identity immediately", async () => {
    await helpers.primeProcessStartedAt([pid]);
    const exited = once(child, "exit");
    child.kill();
    await exited;
    synchronousReads = 0;
    assert.equal(helpers.readProcessStartedAt(pid), undefined);
    assert.equal(synchronousReads, 0, "kill(pid, 0) rejects a dead pid before consulting the cache or ps");
  });
});
