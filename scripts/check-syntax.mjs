#!/usr/bin/env node
// Purpose: Parse-check every ESM JavaScript source in the repository without a hand-maintained file list.
// Responsibilities: Discover `.mjs` files under extensions/, scripts/, and the repository root with the
//   standard library (no globs, no symlink following), run `node --check` on each, and fail on the first
//   syntax error naming the file.
// Scope: Syntax only. Type errors belong to the tsc projects; behavior belongs to the test suites.
// Usage: npm run check:syntax (part of npm run check:oracle-extension and both verify gates).
// Invariants/Assumptions: A file that does not parse fails the gate; a run that discovers nothing is a
//   configuration error, not a pass.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["extensions", "scripts"];
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

function collect(dir, recurse) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse && !SKIPPED_DIRS.has(entry.name)) found.push(...collect(path, true));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      found.push(path);
    }
  }
  return found;
}

const files = [...collect(REPO_ROOT, false), ...ROOTS.flatMap((root) => collect(join(REPO_ROOT, root), true))]
  .map((path) => relative(REPO_ROOT, path))
  .sort();
if (files.length === 0) {
  console.error("check-syntax discovered no .mjs files; the repository layout changed.");
  process.exit(1);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`Syntax check failed: ${file}\n${result.stderr || result.stdout || result.error?.message || ""}`);
    process.exit(result.status ?? 1);
  }
}
console.log(`syntax check passed (${files.length} .mjs files)`);
