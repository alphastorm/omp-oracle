// Purpose: Provide shared process-identity and termination helpers for oracle runtime, worker, and queue coordination.
// Responsibilities: Read stable process start identities, detect liveness, wait for freshly spawned processes, terminate tracked processes safely, and run and close agent-browser driver sessions.
// Scope: Local process coordination only; job-state mutation and queue semantics stay in higher-level helpers.
// Usage: Imported by lib/jobs.ts, lib/runtime.ts, worker/run-job.mjs, worker/auth-bootstrap.mjs, and shared state helpers.
// Invariants/Assumptions: Process identity is validated with `ps -o lstart=` to defend against PID reuse on macOS.

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

/** A timeout is distinct from a driver command's non-zero exit. */
export class CommandTimeoutError extends Error {
  /** @param {string} command @param {string[]} args @param {number} timeoutMs @param {string} stdout @param {string} stderr */
  constructor(command, args, timeoutMs, stdout, stderr) {
    super(`${basename(command)} ${args[0] || ""} timed out after ${timeoutMs}ms${stderr ? `: ${stderr}` : ""}`);
    this.name = "CommandTimeoutError";
    this.code = "ETIMEDOUT";
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.stdout = stdout;
    this.stderr = stderr;
  }
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
        else reject(new CommandTimeoutError(command, args, /** @type {number} */ (timeoutMs), stdout.trim(), stderr.trim()));
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
 * Turn off agent-browser's experimental WebMCP support for every driver command this process
 * runs. From 0.36 the driver enables WebMCP in the Chrome it launches and appends page-provided
 * tool announcements to the text output of `eval`, `get url`, `snapshot`, and `get text`, which the
 * workers parse. Oracle uses no page tools, and earlier drivers ignore the variable.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyAgentBrowserEnvDefaults(env = process.env) {
  env.AGENT_BROWSER_NO_WEBMCP = "1";
  env.AGENT_BROWSER_NO_VERSION_CHECK = "1";
}

/** @param {NodeJS.ProcessEnv} [env] */
export function withAgentBrowserEnvDefaults(env = process.env) {
  const defaults = { ...env };
  applyAgentBrowserEnvDefaults(defaults);
  return defaults;
}

/** Resolve exactly as agent-browser v0.41.2's get_socket_dir, including namespaces.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: string; homedir?: () => string; tmpdir?: () => string }} [options]
 */
export function resolveAgentBrowserSocketDir(env = process.env, options = {}) {
  const home = (options.homedir || homedir)();
  const base = env.AGENT_BROWSER_SOCKET_DIR || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "agent-browser")
    : home ? join(home, ".agent-browser") : join((options.tmpdir || tmpdir)(), "agent-browser"));
  // Rust sanitizes each character before lowercasing; retain that order for Unicode.
  let namespace = "";
  let separator = false;
  for (const c of env.AGENT_BROWSER_NAMESPACE || "") {
    if (/[\p{L}\p{N}]/u.test(c)) { namespace += c.toLowerCase(); separator = false; }
    else if (namespace && !separator) { namespace += c === "_" ? "_" : "-"; separator = true; }
  }
  namespace = namespace.replace(/[-_]+$/, "");
  return namespace ? join(base, "namespaces", namespace, "run") : base;
}

/** Remove only known private sidecars, after the caller proves the session is absent.
 * @param {string} sessionName @param {NodeJS.ProcessEnv} [env] @returns {Promise<string[]>}
 */
export async function removeAgentBrowserSessionSidecars(sessionName, env = process.env) {
  if (!/^[\p{L}\p{N}_-]+$/u.test(sessionName)) return [];
  const removed = [];
  for (const suffix of ["config", "target"]) {
    const path = join(resolveAgentBrowserSocketDir(env), `${sessionName}.${suffix}`);
    try { await rm(path); removed.push(path); }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error; }
  }
  return removed;
}

/**
 * Whether the driver lists `sessionName` as an active session. An unreadable inventory is an
 * error, never evidence of absence.
 * @param {string} binary
 * @param {string} sessionName
 * @returns {Promise<boolean>}
 */
async function agentBrowserSessionListed(binary, sessionName) {
  const result = await runCommand(binary, ["session", "list"], { allowFailure: true, timeoutMs: 5_000, env: withAgentBrowserEnvDefaults() });
  if (result.code !== 0) throw new Error(`agent-browser session inventory is unavailable: ${result.stderr || result.stdout || `exit code ${result.code}`}`);
  return result.stdout.split("\n").some((line) => line.trim() === sessionName);
}

/**
 * Close a session the driver lists, and return only once it no longer lists it. `close` returns
 * before the session daemon exits, and a command sent on the same session name in that window
 * reaches the dying daemon: its tab is orphaned, the command fails to connect, or (agent-browser
 * 0.39) it is dropped as "may or may not have run". A session the driver does not list is never
 * closed, since `close` would spawn a daemon for it.
 * @param {string} binary
 * @param {string[]} sessionArgs `--session <name>` plus the session's connection flags
 * @param {string} sessionName
 * @param {{ timeoutMs: number; killGraceMs?: number }} options bounds both the close command and the wait for teardown
 * @returns {Promise<boolean>} whether a listed session was closed
 */
export async function closeAgentBrowserSession(binary, sessionArgs, sessionName, { timeoutMs, killGraceMs }) {
  if (!(await agentBrowserSessionListed(binary, sessionName))) {
    await removeAgentBrowserSessionSidecars(sessionName);
    return false;
  }
  const result = await runCommand(binary, [...sessionArgs, "close"], { allowFailure: true, timeoutMs, killGraceMs, env: withAgentBrowserEnvDefaults() });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `agent-browser close exited with code ${result.code}`);
  const deadline = Date.now() + timeoutMs;
  while (await agentBrowserSessionListed(binary, sessionName)) {
    if (Date.now() >= deadline) throw new Error(`agent-browser session ${sessionName} is still active after close`);
    await sleep(50);
  }
  await removeAgentBrowserSessionSidecars(sessionName);
  return true;
}

const PROCESS_START_TIME_CACHE_TTL_MS = 2_000;
/** @type {Map<number, { startedAt: string; readAt: number }>} */
const processStartTimeCache = new Map();

/** @param {number | undefined} pid @returns {pid is number} */
function isValidProcessPid(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/** @param {number} pid @returns {string | undefined} */
function readProcessStartedAtSynchronously(pid) {
  try {
    const startedAt = (process.platform === "win32"
      ? execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
      ], { encoding: "utf8", env: sweetCookieSafeStoragePasswordScrubbedEnv() })
      : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: sweetCookieSafeStoragePasswordScrubbedEnv() })).trim();
    if (startedAt) {
      processStartTimeCache.set(pid, { startedAt, readAt: Date.now() });
      return startedAt;
    }
  } catch {
    // An unavailable process table leaves callers free to retry on the next read.
  }
  processStartTimeCache.delete(pid);
  return undefined;
}

/**
 * @param {number | undefined} pid
 * @returns {string | undefined}
 */
export function readProcessStartedAt(pid) {
  if (!isValidProcessPid(pid)) return undefined;
  if (pid !== process.pid && !isProcessAlive(pid)) return undefined;
  const cached = processStartTimeCache.get(pid);
  if (cached && (pid === process.pid || Date.now() - cached.readAt < PROCESS_START_TIME_CACHE_TTL_MS)) return cached.startedAt;
  return readProcessStartedAtSynchronously(pid);
}

/**
 * Bypass the short-lived cache before any signal-sending identity decision.
 * @param {number | undefined} pid
 * @returns {string | undefined}
 */
export function readProcessStartedAtFresh(pid) {
  if (!isValidProcessPid(pid)) return undefined;
  if (pid === process.pid) return readProcessStartedAt(pid);
  if (!isProcessAlive(pid)) return undefined;
  return readProcessStartedAtSynchronously(pid);
}

/**
 * Populate process identities in one asynchronous process-table read, preserving lstart spacing.
 * @param {Iterable<number | undefined>} pids
 * @returns {Promise<void>}
 */
export async function primeProcessStartedAt(pids) {
  const now = Date.now();
  const pending = new Set();
  for (const pid of pids) {
    if (!isValidProcessPid(pid) || !isProcessAlive(pid)) continue;
    const cached = processStartTimeCache.get(pid);
    if (cached && (pid === process.pid || now - cached.readAt < PROCESS_START_TIME_CACHE_TTL_MS)) continue;
    pending.add(pid);
  }
  if (pending.size === 0) return;
  const ids = [...pending].join(",");
  const windows = process.platform === "win32";
  const args = windows
    ? ["-NoLogo", "-NoProfile", "-Command", `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToUniversalTime().ToString('o'))" }`]
    : ["-o", "pid=,lstart=", "-p", ids];
  await new Promise((resolve) => {
    execFile(windows ? "powershell.exe" : "ps", args, {
      encoding: "utf8",
      timeout: 5_000,
      env: sweetCookieSafeStoragePasswordScrubbedEnv(),
    }, (error, stdout) => {
      if (!error) {
        const readAt = Date.now();
        for (const line of stdout.split(/\r?\n/)) {
          const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
          if (!match) continue;
          const pid = Number(match[1]);
          if (pending.has(pid)) processStartTimeCache.set(pid, { startedAt: match[2], readAt });
        }
      }
      resolve(undefined);
    });
  });
}

/**
 * @param {number | undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!isValidProcessPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      processStartTimeCache.delete(pid);
      return false;
    }
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

/** @param {number} pid @param {string} startedAt */
function isTrackedProcessAliveFresh(pid, startedAt) {
  return readProcessStartedAtFresh(pid) === startedAt;
}

/**
 * @param {number | undefined} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<string | undefined>}
 */
export async function waitForProcessStartedAt(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = readProcessStartedAtFresh(pid);
    if (startedAt) return startedAt;
    await sleep(100);
  }
  return readProcessStartedAtFresh(pid);
}

/**
 * @param {number | undefined} pid
 * @param {string | undefined} startedAt
 * @param {OracleTrackedProcessOptions} [options]
 * @returns {Promise<boolean>}
 */
export async function terminateTrackedProcess(pid, startedAt, options = {}) {
  if (!isValidProcessPid(pid)) return true;
  const currentStartedAt = readProcessStartedAtFresh(pid);
  if (!currentStartedAt) return true;
  if (startedAt && currentStartedAt !== startedAt) return false;
  const expectedStartedAt = startedAt || currentStartedAt;

  const termGraceMs = options.termGraceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 2_000;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isTrackedProcessAliveFresh(pid, expectedStartedAt);
  }

  const termDeadline = Date.now() + termGraceMs;
  while (Date.now() < termDeadline) {
    if (!isTrackedProcessAliveFresh(pid, expectedStartedAt)) return true;
    await sleep(250);
  }

  if (!isTrackedProcessAliveFresh(pid, expectedStartedAt)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isTrackedProcessAliveFresh(pid, expectedStartedAt);
  }

  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (!isTrackedProcessAliveFresh(pid, expectedStartedAt)) return true;
    await sleep(250);
  }

  return !isTrackedProcessAliveFresh(pid, expectedStartedAt);
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
