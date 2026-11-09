// Purpose: Share oracle state path defaults across extension and detached workers.
// Scope: Path defaults and read-only trust checks; no filesystem mutation.

import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_ORACLE_JOBS_DIR = "/tmp";
export const ORACLE_JOBS_DIR_ENV = "PI_ORACLE_JOBS_DIR";
export const DEFAULT_ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
export const ORACLE_STATE_DIR_ENV = "PI_ORACLE_STATE_DIR";
export const ORACLE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const trustedStateRoots = new Set();

/** @param {unknown} id @returns {id is string} */
export function isValidOracleJobId(id) {
  // Require the entire match: JavaScript's `$` also accepts a trailing line terminator.
  return typeof id === "string" && ORACLE_JOB_ID_PATTERN.exec(id)?.[0] === id;
}

/**
 * @param {{ uid: number; mode: number; isSymbolicLink(): boolean }} stat
 * @param {number | undefined} ownUid
 */
export function isTrustedStat(stat, ownUid) {
  return !stat.isSymbolicLink() && (ownUid === undefined || (stat.uid === ownUid && (stat.mode & 0o022) === 0));
}

/** @param {string} dir */
export function isTrustedOracleJobDir(dir) {
  try {
    const ownUid = process.getuid?.();
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || !isTrustedStat(directory, ownUid)) return false;
    const job = lstatSync(join(dir, "job.json"));
    return job.isFile() && isTrustedStat(job, ownUid);
  } catch {
    return false;
  }
}

/** @param {string} jobsDir @returns {string[]} */
export function listTrustedOracleJobIds(jobsDir) {
  try {
    return readdirSync(jobsDir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith("oracle-")) return [];
      const id = entry.name.slice("oracle-".length);
      return isValidOracleJobId(id) && isTrustedOracleJobDir(join(jobsDir, entry.name)) ? [id] : [];
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** @param {string} stateDir */
export function assertTrustedOracleStateRoot(stateDir) {
  const path = resolve(stateDir);
  if (trustedStateRoots.has(path)) return;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const ownUid = process.getuid?.();
  const reason = stat.isSymbolicLink() ? "a symlink" : ownUid !== undefined && stat.uid !== ownUid ? `owned by uid ${stat.uid}` : undefined;
  if (reason) {
    throw new Error(`Oracle state directory ${stateDir} is ${reason}; refusing to use it. Point PI_ORACLE_STATE_DIR at a private directory you own.`);
  }
  trustedStateRoots.add(path);
}

export function getOracleJobsDir(env = process.env) {
  return env[ORACLE_JOBS_DIR_ENV]?.trim() || DEFAULT_ORACLE_JOBS_DIR;
}

export function getOracleStateDir(env = process.env) {
  const stateDir = env[ORACLE_STATE_DIR_ENV]?.trim() || DEFAULT_ORACLE_STATE_DIR;
  // Check before callers create/chmod the root or write managed-browser logs.
  assertTrustedOracleStateRoot(stateDir);
  return stateDir;
}
