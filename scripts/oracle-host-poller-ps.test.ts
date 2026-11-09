import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("scans and poller footer/readiness ticks never synchronously read process tables", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-poller-ps-"));
  await mkdir(join(root, "jobs"), { mode: 0o700 });
  Object.assign(process.env, { PI_ORACLE_JOBS_DIR: join(root, "jobs"), PI_ORACLE_STATE_DIR: join(root, "state"),
    PI_CODING_AGENT_DIR: join(root, "agent"), AGENT_BROWSER_PATH: join(root, "unused-browser") });
  let synchronousReads = 0;
  const original = childProcess.execFileSync;
  childProcess.execFileSync = ((file: string, ...args: unknown[]) => {
    if (file === "ps" || file === "powershell.exe") synchronousReads += 1;
    return Reflect.apply(original, childProcess, [file, ...args]);
  }) as typeof original;
  syncBuiltinESMExports();
  // These modules capture env and built-in bindings at load time, so static imports cannot isolate this test.
  const poller = await import("../extensions/oracle/lib/poller.ts");
  const jobs = await import("../extensions/oracle/lib/jobs.ts");
  const { writeLeaseMetadata, listLeaseMetadata } = await import("../extensions/oracle/lib/locks.ts");
  const { DEFAULT_CONFIG } = await import("../extensions/oracle/lib/config.ts");
  const { createPiHarness, createPollerCtx, createPersistedSessionManager, createJobForTest } = await import("./oracle-sanity-support.ts");
  const children = [spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] }),
    spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] })];
  t.after(async () => {
    await poller.stopAllPollers();
    await poller.waitForAllPollersToQuiesce();
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    await Promise.all(children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    }));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(children.map((child) => once(child, "spawn")));
  const session = createPersistedSessionManager("poller-ps");
  const sessionFile = session.getSessionFile()!;
  t.after(() => rm(dirname(sessionFile), { recursive: true, force: true }));
  const ctx = createPollerCtx(session, root);
  const pi = createPiHarness();
  await poller.scanOracleJobsOnce(pi, ctx, "unused-worker.mjs");
  const id = await createJobForTest(DEFAULT_CONFIG, root, sessionFile);
  const startedAt = children.map((child) => original("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
  await jobs.updateJob(id, (job) => ({ ...job, workerPid: children[0].pid, workerStartedAt: startedAt[0], heartbeatAt: new Date().toISOString() }));
  const leaseKey = "other-live-session";
  await writeLeaseMetadata("wakeup-target", leaseKey, { leaseKey, projectId: root, sessionId: join(root, "other.jsonl"),
    processPid: children[1].pid, processStartedAt: startedAt[1], updatedAt: new Date().toISOString() });
  synchronousReads = 0;
  await poller.scanOracleJobsOnce(pi, ctx, "unused-worker.mjs");
  assert.equal(synchronousReads, 0, "scan must asynchronously prime the worker and wake-up lease pids");
  assert.equal(jobs.readJob(id)?.status, "submitted");
  assert.ok(listLeaseMetadata<{ leaseKey: string }>("wakeup-target").some((lease) => lease.leaseKey === leaseKey));

  let readinessRan = false;
  const statusesBefore = ctx.ui.statuses.length;
  const now = Date.now;
  poller.startPoller(pi, ctx, 60_000, "unused-worker.mjs", { checkReadiness: async () => {
    t.mock.method(Date, "now", () => now() + 2_050);
    readinessRan = true;
    return { readiness: "ready" };
  } });
  await poller.waitForAllPollersToQuiesce(5_000);
  assert.equal(readinessRan, true);
  assert.equal(synchronousReads, 0, "tick and readiness footer refreshes must prime expired identities asynchronously");
  assert.ok(ctx.ui.statuses.length > statusesBefore);
  assert.equal(ctx.ui.statuses.at(-1)?.value, "oracle: running");
  assert.equal(jobs.readJob(id)?.workerStartedAt, startedAt[0]);
  assert.equal(jobs.readJob(id)?.status, "submitted");
});
