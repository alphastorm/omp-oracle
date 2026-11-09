import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const workerPath = fileURLToPath(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url));

test("only trusted jobs can be read, enumerated, or promoted", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-ownership-"));
  const jobsDir = join(root, "jobs");
  await mkdir(jobsDir, { mode: 0o700 });
  Object.assign(process.env, { PI_ORACLE_JOBS_DIR: jobsDir, PI_ORACLE_STATE_DIR: join(root, "state"),
    PI_CODING_AGENT_DIR: join(root, "agent"), AGENT_BROWSER_PATH: join(root, "unused-browser") });
  t.after(() => rm(root, { recursive: true, force: true }));
  // These modules capture state roots at load time; static imports cannot isolate this test.
  const jobs = await import("../extensions/oracle/lib/jobs.ts");
  const queue = await import("../extensions/oracle/lib/queue.ts");
  const paths = await import("../extensions/oracle/shared/state-path-helpers.mjs");
  const { compareQueuedOracleJobs } = await import("../extensions/oracle/shared/job-coordination-helpers.mjs");
  const { DEFAULT_CONFIG } = await import("../extensions/oracle/lib/config.ts");
  const { createJobForTest } = await import("./oracle-sanity-support.ts");
  const id = await createJobForTest(DEFAULT_CONFIG, root, join(root, "session.jsonl"));
  const validDir = jobs.getJobDir(id);
  const valid = jobs.readJob(id)!;
  await symlink(validDir, join(jobsDir, "oracle-evil"));
  const looseDir = join(jobsDir, "oracle-loose");
  await mkdir(looseDir, { mode: 0o700 });
  await writeFile(join(looseDir, "job.json"), JSON.stringify({ ...valid, id: "loose", status: "queued", phase: "queued" }), { mode: 0o600 });
  await chmod(looseDir, 0o777);

  await t.test("enumeration and reads reject symlinks and writable directories", () => {
    assert.ok(jobs.listOracleJobDirs().includes(validDir));
    assert.equal(jobs.readJob(validDir)?.id, id);
    assert.equal(jobs.readJob("evil"), undefined);
    assert.equal(jobs.readJob("loose"), undefined);
    assert.equal(jobs.listOracleJobDirs().includes(join(jobsDir, "oracle-evil")), false);
    assert.equal(jobs.listOracleJobDirs().includes(looseDir), false);
    assert.equal(queue.listQueuedJobs().some((job) => job.id === "loose"), false);
  });

  await t.test("worker queue enumeration applies the same trust boundary", async () => {
    // Execute the production declarations without starting the browser worker (native-test precedent).
    const source = await readFile(workerPath, "utf8");
    const tree = ts.createSourceFile(workerPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set(["getAnyJobDir", "getAnyJobPath", "readAnyJob", "listQueuedJobs"]);
    const declarations = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
    assert.equal(declarations.length, names.size);
    const bindings = { ...paths, ORACLE_JOBS_DIR: jobsDir, existsSync, readdirSync, readFileSync, join, compareQueuedOracleJobs };
    const listQueued = new Function(...Object.keys(bindings), `${declarations.map((node) => node.getText(tree)).join("\n")}\nreturn listQueuedJobs;`)(...Object.values(bindings)) as () => Array<{ id: string }>;
    assert.equal(listQueued().some((job) => job.id === "loose"), false);
  });

  await t.test("promotion never spawns a worker for a planted 0777 job", async () => {
    const spawned: string[] = [];
    await queue.promoteQueuedJobs({ workerPath, source: "ownership-test", spawnWorkerFn: async (_path, jobId) => {
      spawned.push(jobId);
      throw new Error("untrusted job reached spawn");
    } });
    assert.deepEqual(spawned, []);
  });

  await t.test("paths and saved identities cannot redirect an id lookup", async () => {
    assert.equal(jobs.readJob("../x"), undefined);
    assert.throws(() => jobs.getJobDir("../x"), /Invalid oracle job id:/);
    assert.throws(() => jobs.readJobForProject("../x", root), /Oracle job not found in this project: \.\.\/x/);
    const outside = join(root, "oracle-outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "job.json"), JSON.stringify({ ...valid, id: "outside" }), { mode: 0o600 });
    assert.equal(jobs.readJob(outside), undefined);
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      assert.equal(jobs.readJob("oracle-outside"), undefined, "relative directories are never looked up from cwd");
    } finally { process.chdir(originalCwd); }
    const mismatch = join(jobsDir, "oracle-mismatch");
    await mkdir(mismatch, { mode: 0o700 });
    await writeFile(join(mismatch, "job.json"), JSON.stringify(valid), { mode: 0o600 });
    assert.equal(jobs.readJob("mismatch"), undefined);
    await chmod(join(validDir, "job.json"), 0o666);
    assert.equal(jobs.readJob(id), undefined);
    await chmod(join(validDir, "job.json"), 0o600);
    await symlink(join(validDir, "job.json"), join(mismatch, "linked.json"));
    await rm(join(mismatch, "job.json"));
    await symlink(join(validDir, "job.json"), join(mismatch, "job.json"));
    assert.equal(jobs.readJob("mismatch"), undefined);
  });

  await t.test("uid and Windows-compatible predicates retain symlink protection", () => {
    const own = process.getuid!();
    assert.equal(paths.isTrustedStat({ uid: own + 1, mode: 0o40700, isSymbolicLink: () => false }, own), false);
    assert.equal(paths.isTrustedStat({ uid: own, mode: 0o40722, isSymbolicLink: () => false }, own), false);
    assert.equal(paths.isTrustedStat({ uid: own + 1, mode: 0o40777, isSymbolicLink: () => false }, undefined), true);
    assert.equal(paths.isTrustedStat({ uid: own, mode: 0o40700, isSymbolicLink: () => true }, undefined), false);
    assert.equal(paths.isValidOracleJobId("a".repeat(128)), true);
    for (const invalid of ["", "a".repeat(129), "../x", "a/b", "-x", "x\n"]) assert.equal(paths.isValidOracleJobId(invalid), false);
  });

  await t.test("both worker entrypoints refuse invalid and untrusted jobs before execution", () => {
    for (const args of [["../x"], ["loose"], ["loose", "--recollect"]]) {
      const result = spawnSync(process.execPath, [workerPath, ...args], { env: process.env, encoding: "utf8", timeout: 5_000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, args[0] === "../x" ? /Usage: run-job\.mjs <job-id>/ : /Refusing untrusted oracle job directory/);
    }
  });
});

test("a symlinked state root is refused without chmodding its target", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-state-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const state = join(root, "state-link");
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);
  await symlink(target, state);
  const locksUrl = new URL("../extensions/oracle/lib/locks.ts", import.meta.url).href;
  const code = `try { const { withGlobalReconcileLock } = await import(${JSON.stringify(locksUrl)}); await withGlobalReconcileLock({}, async () => {}); process.exitCode = 2; } catch (error) { console.log(error.message); }`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: { ...process.env, PI_ORACLE_STATE_DIR: state }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Oracle state directory ${state} is a symlink; refusing to use it. Point PI_ORACLE_STATE_DIR at a private directory you own.`);
  assert.equal((await stat(target)).mode & 0o777, 0o755);
});
