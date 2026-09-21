// Purpose: Provide shared process-identity and termination helpers for oracle runtime, worker, and queue coordination.
// Responsibilities: Read stable process start identities, detect liveness, wait for freshly spawned processes, and terminate tracked processes safely.
// Scope: Local process coordination only; job-state mutation and queue semantics stay in higher-level helpers.
// Usage: Imported by lib/jobs.ts, lib/runtime.ts, worker/run-job.mjs, and shared state helpers.
// Invariants/Assumptions: Process identity is validated with `ps -o lstart=` to defend against PID reuse on macOS.

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { sweetCookieSafeStoragePasswordScrubbedEnv } from "./browser-profile-helpers.mjs";
import { sleep } from "./time-helpers.mjs";

/** @typedef {import("./process-helpers.d.mts").OracleTrackedProcessOptions} OracleTrackedProcessOptions */
/** @typedef {import("./process-helpers.d.mts").OracleDetachedProcessHandle} OracleDetachedProcessHandle */
/** @typedef {import("./process-helpers.d.mts").OracleRunCommandOptions} OracleRunCommandOptions */
/** @typedef {import("./process-helpers.d.mts").OracleRunCommandResult} OracleRunCommandResult */

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Ask a child and its descendants to stop: SIGTERM, or `taskkill /t` on Windows where signals
 * do not reach a shell-spawned tree.
 * @param {import("node:child_process").ChildProcess} child
 */
export function killProcessTree(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    return;
  }
  child.kill("SIGTERM");
}

/**
 * Force a child to stop: SIGKILL, or `taskkill /f` on Windows.
 * @param {import("node:child_process").ChildProcess} child
 */
export function killProcess(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    return;
  }
  child.kill("SIGKILL");
}

/**
 * Run a child process to completion with a bounded lifetime. The environment is always scrubbed
 * of safe-storage passwords; on Windows the command runs through the shell. A `timeoutMs` first
 * terminates the process tree, then force-kills it after `killGraceMs`; the promise settles only
 * once the child has closed. A non-zero exit or timeout rejects unless `allowFailure` is set, in
 * which case the result carries the exit code and, for a timeout, the timeout message as stderr.
 * @param {string} command
 * @param {string[]} args
 * @param {OracleRunCommandOptions} [options]
 * @returns {Promise<OracleRunCommandResult>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS, input, allowFailure = false, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions,
      env: sweetCookieSafeStoragePasswordScrubbedEnv(spawnOptions.env),
      shell: spawnOptions.shell ?? process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let killGraceTimer;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        killGraceTimer = setTimeout(() => killProcess(child), killGraceMs);
        killGraceTimer.unref?.();
      }, timeoutMs);
      killTimer.unref?.();
    }
    if (input) child.stdin?.end(input);
    else child.stdin?.end();
    child.stdout?.on("data", (data) => { stdout += String(data); });
    child.stderr?.on("data", (data) => { stderr += String(data); });
    child.on("error", (error) => {
      clearTimeout(killTimer);
      clearTimeout(killGraceTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      clearTimeout(killGraceTimer);
      if (timedOut) {
        const message = stderr || stdout || `${command} timed out after ${timeoutMs}ms`;
        if (allowFailure) resolve({ code, stdout: stdout.trim(), stderr: message, timedOut });
        else reject(new Error(message));
        return;
      }
      if (code === 0 || allowFailure) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
    });
  });
}
export function resolveNodeExecutable() {
  const configured = process.env.PI_ORACLE_NODE_PATH?.trim();
  if (configured) return configured;
  return /^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
}

/**
 * The agent-browser driver binary: an explicit AGENT_BROWSER_PATH, then the Homebrew and /usr/local
 * installs, else the bare name for PATH lookup by the spawner.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveAgentBrowserBinary(env = process.env) {
  return [env.AGENT_BROWSER_PATH, "/opt/homebrew/bin/agent-browser", "/usr/local/bin/agent-browser"].find(
    (candidate) => typeof candidate === "string" && candidate && existsSync(candidate),
  ) || "agent-browser";
}

/**
 * @param {number | undefined} pid
 * @returns {string | undefined}
 */
export function readProcessStartedAt(pid) {
  if (!pid || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      const startedAt = execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
      ], { encoding: "utf8", env: sweetCookieSafeStoragePasswordScrubbedEnv() }).trim();
      return startedAt || undefined;
    }
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: sweetCookieSafeStoragePasswordScrubbedEnv() }).trim();
    return startedAt || undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {number | undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

/**
 * @param {number | undefined} pid
 * @param {string | undefined} startedAt
 * @returns {boolean}
 */
export function isTrackedProcessAlive(pid, startedAt) {
  const currentStartedAt = readProcessStartedAt(pid);
  if (!currentStartedAt) return false;
  return startedAt ? currentStartedAt === startedAt : true;
}

/**
 * @param {number | undefined} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<string | undefined>}
 */
export async function waitForProcessStartedAt(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = readProcessStartedAt(pid);
    if (startedAt) return startedAt;
    await sleep(100);
  }
  return readProcessStartedAt(pid);
}

/**
 * @param {number | undefined} pid
 * @param {string | undefined} startedAt
 * @param {OracleTrackedProcessOptions} [options]
 * @returns {Promise<boolean>}
 */
export async function terminateTrackedProcess(pid, startedAt, options = {}) {
  if (!pid || pid <= 0) return true;
  const currentStartedAt = readProcessStartedAt(pid);
  if (!currentStartedAt) return true;
  if (startedAt && currentStartedAt !== startedAt) return false;

  const termGraceMs = options.termGraceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 2_000;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isTrackedProcessAlive(pid, startedAt);
  }

  const termDeadline = Date.now() + termGraceMs;
  while (Date.now() < termDeadline) {
    if (!isTrackedProcessAlive(pid, startedAt)) return true;
    await sleep(250);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isTrackedProcessAlive(pid, startedAt);
  }

  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (!isTrackedProcessAlive(pid, startedAt)) return true;
    await sleep(250);
  }

  return !isTrackedProcessAlive(pid, startedAt);
}

/**
 * @param {string} scriptPath
 * @param {string[]} args
 * @returns {Promise<OracleDetachedProcessHandle>}
 */
export async function spawnDetachedNodeProcess(scriptPath, args = []) {
  const child = spawn(resolveNodeExecutable(), [scriptPath, ...args], {
    detached: true,
    env: sweetCookieSafeStoragePasswordScrubbedEnv(),
    stdio: "ignore",
  });
  child.unref();
  return {
    pid: child.pid,
    startedAt: await waitForProcessStartedAt(child.pid),
  };
}
