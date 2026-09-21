#!/usr/bin/env node
// Purpose: Fail the gate when the worker runtime references a name that does not exist.
// Responsibilities: Run TypeScript's checkJs pass over extensions/oracle/worker/run-job.mjs and
//   reject only unresolved-identifier diagnostics (TS2304 "Cannot find name", TS2552 "Did you
//   mean"). Every other diagnostic is reported as informational.
// Scope: run-job.mjs is excluded from both project typechecks because it is not fully typed, so a
//   missing import there is invisible to `node --check`, the unit suites, and both `tsc` projects
//   — it only fails at runtime, mid-job, after a real provider call has already been spent.
// Usage: npm run check:worker-runtime-names (wired into npm run verify:oracle).
// Invariants/Assumptions: tsconfig.worker-runtime.json lists the worker runtime entry points.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "tsconfig.worker-runtime.json";
const FATAL = /error (TS2304|TS2552):/;

const result = spawnSync("npx", ["tsc", "--noEmit", "-p", PROJECT], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  env: process.env,
});

if (result.error) {
  console.error(`Could not run the worker runtime name check: ${result.error.message}`);
  process.exit(1);
}

const lines = `${result.stdout || ""}${result.stderr || ""}`.split("\n").filter((line) => line.trim());
const unresolved = lines.filter((line) => FATAL.test(line));

if (unresolved.length > 0) {
  console.error("Worker runtime references names that do not exist:");
  for (const line of unresolved) console.error(`  ${line}`);
  console.error("\nThese fail at runtime mid-job, not at load. Add the missing import or fix the typo.");
  process.exit(1);
}

const other = lines.filter((line) => /error TS\d+:/.test(line));
console.log(`worker runtime name check passed (${other.length} non-fatal type diagnostic(s) in ${PROJECT})`);
