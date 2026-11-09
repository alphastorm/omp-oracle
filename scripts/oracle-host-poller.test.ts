import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "oracle-host-poller-"));
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PI_ORACLE_STATE_DIR = join(root, "state");
process.env.PI_ORACLE_JOBS_DIR = join(root, "jobs");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.AGENT_BROWSER_PATH = join(root, "agent-browser");
process.env.AGENT_BROWSER_SOCKET_DIR = join(root, "driver-sockets");
await Promise.all([
  mkdir(process.env.PI_ORACLE_STATE_DIR, { mode: 0o700 }),
  mkdir(process.env.PI_ORACLE_JOBS_DIR, { mode: 0o700 }),
  mkdir(process.env.PI_CODING_AGENT_DIR, { mode: 0o700 }),
  mkdir(process.env.AGENT_BROWSER_SOCKET_DIR, { mode: 0o700 }),
  writeFile(process.env.AGENT_BROWSER_PATH, "#!/usr/bin/env node\nconsole.log('agent-browser 0.41.2');\n", { mode: 0o755 }),
]);
const { loadOracleConfig } = await import("../extensions/oracle/lib/config.js");
const { getJobDir, readJob } = await import("../extensions/oracle/lib/jobs.js");
const { scanOracleJobsOnce, startPoller, stopAllPollers, stopPollerForSession, waitForAllPollersToQuiesce } = await import("../extensions/oracle/lib/poller.js");
const { createPiHarness, createPollerCtx, createPersistedSessionManager, createJobForTest, completeJob, waitForCondition } = await import("./oracle-sanity-support.js");
const config = loadOracleConfig(repoRoot, { projectConfigTrusted: false });
const workerPath = join(root, "unused-worker.mjs");
after(async () => {
  await stopAllPollers();
  await waitForAllPollersToQuiesce();
  await rm(root, { recursive: true, force: true });
});

test("wake-up is requested after marking even when the session turns busy", async () => {
  const manager = createPersistedSessionManager("host-commit-busy");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const ctx = createPollerCtx(manager, repoRoot);
  const harness = createPiHarness();
  const jobId = await createJobForTest(config, repoRoot, sessionFile);
  await completeJob(jobId);
  const options: unknown[] = [];
  harness.sendMessage = (message, delivery) => { harness.sentMessages.push(message); options.push(delivery); };
  try {
    await scanOracleJobsOnce(harness, ctx, workerPath, {
      hooks: { afterWakeupCommitted: () => { ctx.idle = false; } },
    });
    assert.ok(readJob(jobId)?.notifiedAt);
    assert.equal(ctx.idle, false);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].customType, "oracle-job-wakeup");
    assert.deepEqual(harness.sentMessages[0].details, { jobId, status: "complete" });
    assert.deepEqual(options, [{ triggerTurn: true, deliverAs: "followUp" }]);
    ctx.idle = true;
    await scanOracleJobsOnce(harness, ctx, workerPath);
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    stopPollerForSession(sessionFile, repoRoot);
    await rm(getJobDir(jobId), { recursive: true, force: true });
    await rm(dirname(sessionFile), { recursive: true, force: true });
  }
});

test("wake-up is requested after marking even when the poller stops", async () => {
  const manager = createPersistedSessionManager("host-commit-stop");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const ctx = createPollerCtx(manager, repoRoot);
  const harness = createPiHarness();
  const jobId = await createJobForTest(config, repoRoot, sessionFile);
  await completeJob(jobId);
  let committed = false;
  try {
    startPoller(harness, ctx, 60_000, workerPath, {
      hooks: { afterWakeupCommitted: () => {
        committed = true;
        stopPollerForSession(sessionFile, repoRoot);
      } },
    });
    await waitForCondition(() => committed, { timeoutMs: 2_000, description: "wake-up commit" });
    await waitForAllPollersToQuiesce();
    assert.ok(readJob(jobId)?.notifiedAt);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].customType, "oracle-job-wakeup");
    assert.deepEqual(harness.sentMessages[0].details, { jobId, status: "complete" });
    assert.deepEqual(ctx.ui.notifications, []);
  } finally {
    stopPollerForSession(sessionFile, repoRoot);
    await waitForAllPollersToQuiesce();
    await rm(getJobDir(jobId), { recursive: true, force: true });
    await rm(dirname(sessionFile), { recursive: true, force: true });
  }
});

test("a committed batch reaches the host even if its first mark makes the session busy", async () => {
  const manager = createPersistedSessionManager("host-commit-batch");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const ctx = createPollerCtx(manager, repoRoot);
  const harness = createPiHarness();
  const jobIds = [
    await createJobForTest(config, repoRoot, sessionFile),
    await createJobForTest(config, repoRoot, sessionFile),
  ];
  await Promise.all(jobIds.map((id) => completeJob(id)));
  try {
    await scanOracleJobsOnce(harness, ctx, workerPath, {
      hooks: { afterWakeupCommitted: () => { ctx.idle = false; } },
    });
    assert.ok(jobIds.every((id) => readJob(id)?.notifiedAt));
    assert.equal(harness.sentMessages.length, 1);
    const details = harness.sentMessages[0].details as { jobs: Array<{ jobId: string; status: string }> };
    assert.deepEqual(details.jobs.map((job) => job.jobId).sort(), [...jobIds].sort());
    assert.ok(details.jobs.every((job) => job.status === "complete"));
  } finally {
    stopPollerForSession(sessionFile, repoRoot);
    await Promise.all(jobIds.map((id) => rm(getJobDir(id), { recursive: true, force: true })));
    await rm(dirname(sessionFile), { recursive: true, force: true });
  }
});
