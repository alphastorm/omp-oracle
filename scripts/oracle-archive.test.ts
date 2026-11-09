import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function incompressibleBytes(bytes: number, seed: string): Buffer {
  const result = Buffer.allocUnsafe(bytes);
  for (let offset = 0; offset < bytes; offset += 32) {
    createHash("sha256").update(`oracle-archive-fixture-${seed}-${offset}`).digest().copy(result, offset);
  }
  return result;
}

test("whole-repo pruning uses fast probes without dropping a boundary-fitting directory", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  const located = spawnSync("/bin/sh", ["-c", "command -v zstd"], { encoding: "utf8" });
  if (located.status !== 0) { t.skip("zstd is not installed"); return; }
  const realZstd = located.stdout.trim();
  const root = await mkdtemp(join(tmpdir(), "oracle-archive-probe-"));
  const cwd = join(root, "project");
  const log = join(root, "levels.jsonl");
  const wrapper = join(root, "zstd-wrapper");
  await mkdir(cwd, { mode: 0o700 });
  Object.assign(process.env, { PI_ORACLE_JOBS_DIR: join(root, "jobs"), PI_ORACLE_STATE_DIR: join(root, "state"),
    PI_CODING_AGENT_DIR: join(root, "agent"), AGENT_BROWSER_PATH: join(root, "unused-browser") });
  const oldZstd = process.env.PI_ORACLE_TEST_ZSTD_BIN;
  t.after(async () => {
    if (oldZstd === undefined) delete process.env.PI_ORACLE_TEST_ZSTD_BIN; else process.env.PI_ORACLE_TEST_ZSTD_BIN = oldZstd;
    await rm(root, { recursive: true, force: true });
  });
  // jobs.ts captures its state roots at load time; this boundary intentionally needs a dynamic import.
  const { createArchiveForTesting } = await import("../extensions/oracle/lib/archive.ts");
  for (const [path, bytes] of [["pkg1/dist/payload.bin", 300 * 1024], ["pkg2/build/payload.bin", 200 * 1024], ["pkg3/out/payload.bin", 100 * 1024]] as const) {
    const fullPath = join(cwd, path);
    await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
    await writeFile(fullPath, incompressibleBytes(bytes, path), { mode: 0o600 });
    await utimes(fullPath, 1_700_000_000, 1_700_000_000);
  }
  await mkdir(join(cwd, "src"), { mode: 0o700 });
  await writeFile(join(cwd, "src/main.ts"), "export const answer = 42;\n", { mode: 0o600 });
  await utimes(join(cwd, "src/main.ts"), 1_700_000_000, 1_700_000_000);
  const baseline = await createArchiveForTesting(cwd, ["pkg3/out/payload.bin", "src/main.ts"], join(root, "baseline.tar.zst"), { maxBytes: 10_000_000, archiveFormat: "tar.zst" });
  await writeFile(wrapper, `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\nconst result = spawnSync(${JSON.stringify(realZstd)}, args, { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  process.env.PI_ORACLE_TEST_ZSTD_BIN = wrapper;
  const archivePath = join(root, "context.tar.zst");
  const result = await createArchiveForTesting(cwd, ["."], archivePath, { maxBytes: baseline.archiveBytes, archiveFormat: "tar.zst" });
  assert.deepEqual(result.autoPrunedPrefixes.map((entry) => entry.relativePath), ["pkg1/dist", "pkg2/build"]);
  assert.ok(result.archiveBytes <= baseline.archiveBytes);
  assert.equal(result.archiveBytes, (await stat(archivePath)).size);
  assert.ok(result.initialArchiveBytes! > baseline.archiveBytes);
  assert.ok(result.includedEntries.includes("pkg3/out/payload.bin"));
  const invocations = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.ok(invocations.filter((args) => args.includes("-19")).length <= 2, "only the initial and boundary-exact builds use -19");
  assert.ok(invocations.some((args) => args.includes("-3")), "pruning must use fast -3 probes");
  const probes = invocations.filter((args) => args.includes("-3")).map((args) => args[args.indexOf("-o") + 1]);
  assert.ok(probes.every((path) => path !== archivePath && dirname(path) !== dirname(archivePath)), "probe files live beside the temporary list, not the final archive");
});
