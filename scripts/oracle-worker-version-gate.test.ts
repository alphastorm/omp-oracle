import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerPath = fileURLToPath(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url));

test("the job worker fails an unsupported agent-browser before any browser command", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-version-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobsDir = join(root, "jobs");
  await mkdir(jobsDir, { mode: 0o700 });
  const callsLog = join(root, "calls.log");
  const driver = join(root, "agent-browser");
  // A driver that predates the floor: it answers --version and records every invocation.
  await writeFile(driver, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}\nif [ "$1" = "--version" ]; then echo "agent-browser 0.39.1"; fi\nexit 0\n`, { mode: 0o700 });
  Object.assign(process.env, {
    PI_ORACLE_JOBS_DIR: jobsDir,
    PI_ORACLE_STATE_DIR: join(root, "state"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    AGENT_BROWSER_PATH: driver,
    AGENT_BROWSER_SOCKET_DIR: join(root, "sockets"),
  });
  // These modules capture state roots at load time, so they load after the environment is set.
  const { DEFAULT_CONFIG } = await import("../extensions/oracle/lib/config.ts");
  const { readJob } = await import("../extensions/oracle/lib/jobs.ts");
  const { createJobForTest } = await import("./oracle-sanity-support.ts");
  const jobId = await createJobForTest(DEFAULT_CONFIG, root, join(root, "session.jsonl"));

  const worker = spawnSync(process.execPath, [workerPath, jobId], { env: process.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(worker.error, undefined);

  const job = readJob(jobId);
  assert.equal(job?.status, "failed", worker.stderr);
  assert.equal(job?.errorCode, "agent_browser_unsupported");
  assert.match(job?.error ?? "", /found 0\.39\.1 .*need 0\.41\.2 or newer/);
  assert.equal(job?.promptSendState, "not_sent");
  const calls = (await readFile(callsLog, "utf8")).trim().split("\n");
  assert.equal(calls[0], "--version");
  // Only the version probe and teardown's session inventory may reach the driver: no open, connect, batch, or eval.
  assert.deepEqual(calls.filter((call) => call !== "--version" && call !== "session list"), []);
});
