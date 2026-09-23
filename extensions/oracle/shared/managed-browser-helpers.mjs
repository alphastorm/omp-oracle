// Purpose: Run the opt-in managed ChatGPT browser: one Chrome on an Oracle-dedicated persistent profile, opened for jobs and quit when idle.
// Responsibilities: Find a Chrome already serving the profile, detect a profile held without a usable DevTools endpoint, hold per-user leases under one profile lock, and start the keeper that owns an Oracle-launched Chrome.
// Scope: Managed-profile lifecycle only; job-owned pinned tabs are driven by the worker through the shared relay helpers.
// Usage: Imported by the worker (job-time attach), the extension (readiness, sign-in, cleanup inputs), and worker/managed-browser.mjs (the keeper).
// Invariants/Assumptions: An endpoint belongs to the profile only when the live /json/version browser id equals the id Chrome wrote into that profile's DevToolsActivePort. Oracle quits only a Chrome its keeper spawned as a child, never one it merely found running.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeBrowserLaunchArg, sweetCookieSafeStoragePasswordScrubbedEnv } from "./browser-profile-helpers.mjs";
import { isProcessAlive, readProcessStartedAt, resolveNodeExecutable } from "./process-helpers.mjs";
import { readCdpBrowserUrl } from "./relay-browser-helpers.mjs";
import { getStateLocksDir, hashOracleStateKey, listStateLeaseMetadata, releaseStateLease, withStateLock, writeStateLeaseMetadata } from "./state-coordination-helpers.mjs";

/** @typedef {import("./managed-browser-helpers.d.mts").ManagedBrowserState} ManagedBrowserState */
/** @typedef {import("./managed-browser-helpers.d.mts").ManagedBrowserAttachment} ManagedBrowserAttachment */
/** @typedef {import("./managed-browser-helpers.d.mts").ManagedBrowserLaunchSpec} ManagedBrowserLaunchSpec */
/** @typedef {import("./managed-browser-helpers.d.mts").ManagedBrowserUserLease} ManagedBrowserUserLease */
/** @typedef {import("./managed-browser-helpers.d.mts").SharedBrowserJobLike} SharedBrowserJobLike */
/** @typedef {import("./managed-browser-helpers.d.mts").SharedBrowserConfigLike} SharedBrowserConfigLike */

export const MANAGED_BROWSER_LOCK_KIND = "managed-browser";
export const MANAGED_BROWSER_USER_KIND = "managed-browser-user";
const KEEPER_PATH = fileURLToPath(new URL("../worker/managed-browser.mjs", import.meta.url));
const ACQUIRE_LOCK_TIMEOUT_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_MS = 120_000;
const IN_USE_MESSAGE_PREFIX = "Managed ChatGPT browser profile is open in a Chrome without Oracle's DevTools endpoint";

/**
 * How long an Oracle-launched browser stays open with no job and no page before its keeper quits it.
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function managedBrowserIdleMs(env = process.env) {
  const value = Number(env.PI_ORACLE_MANAGED_BROWSER_IDLE_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_IDLE_MS;
}

/**
 * Jobs on the relay or the managed browser own a pinned tab in a shared Chrome instead of a cloned runtime profile.
 * @param {SharedBrowserConfigLike | undefined} config
 * @returns {boolean}
 */
export function usesSharedBrowser(config) {
  return Boolean(config?.browser?.chatGptRelayEndpoint || config?.browser?.chatGptManagedProfileDir);
}

/**
 * The CDP endpoint holding a job's pinned tab: the configured relay, or the managed browser the worker attached.
 * @param {SharedBrowserJobLike | undefined} job
 * @param {SharedBrowserConfigLike | undefined} [config]
 * @returns {string | undefined}
 */
export function sharedBrowserEndpoint(job, config = job?.config) {
  return config?.browser?.chatGptRelayEndpoint ?? job?.managedBrowser?.endpoint;
}

/**
 * Inputs every extension-side cleanup path passes for a job's shared-browser tab.
 * @param {SharedBrowserJobLike | undefined} job
 * @param {SharedBrowserConfigLike | undefined} [config]
 */
export function sharedBrowserCleanupFields(job, config = job?.config) {
  return {
    sharedBrowser: usesSharedBrowser(config),
    relayEndpoint: sharedBrowserEndpoint(job, config),
    relayTargetId: job?.relayTargetId,
    managedBrowserUrl: job?.managedBrowser?.browserUrl,
  };
}

/**
 * @param {string} profileDir
 * @param {string[]} [extraArgs]
 * @returns {string[]}
 */
export function managedChromeArgs(profileDir, extraArgs = []) {
  for (const arg of extraArgs) assertSafeBrowserLaunchArg(arg);
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-address=127.0.0.1",
    // Port 0 makes Chrome write DevToolsActivePort into this profile: the only binding from endpoint to profile.
    "--remote-debugging-port=0",
    // Keep job tabs rendering while the window sits behind other windows (docs/OPERATIONS.md).
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--no-first-run",
    "--no-default-browser-check",
    // Jobs open their own tabs; no startup window means no restored session pages keeping the browser busy.
    "--no-startup-window",
    ...extraArgs,
  ];
}

/**
 * @param {string} profileDir
 * @returns {{ port: number; browserPath: string } | undefined}
 */
function readDevToolsActivePort(profileDir) {
  try {
    const [port, browserPath] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split(/\r?\n/);
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65_535 || !browserPath?.startsWith("/devtools/browser/")) return undefined;
    return { port: portNumber, browserPath: browserPath.trim() };
  } catch {
    return undefined;
  }
}

/**
 * The live local process holding Chrome's profile lock, if any. POSIX Chrome links SingletonLock to `<host>-<pid>`.
 * @param {string} profileDir
 * @returns {number | undefined}
 */
export function managedProfileHolderPid(profileDir) {
  // Windows Chrome holds the profile without a lock symlink; a launch there reports the handoff instead.
  if (process.platform === "win32") return undefined;
  const lockPath = join(profileDir, "SingletonLock");
  let target;
  try {
    target = readlinkSync(lockPath);
  } catch {
    return undefined;
  }
  const separator = target.lastIndexOf("-");
  const pid = Number(target.slice(separator + 1));
  if (separator <= 0 || target.slice(0, separator) !== hostname() || !Number.isInteger(pid) || !isProcessAlive(pid)) return undefined;
  // Chrome links the lock within a second of starting; a process that started later reused a dead holder's pid.
  const startedAtMs = Date.parse(readProcessStartedAt(pid) ?? "");
  if (Number.isFinite(startedAtMs) && startedAtMs > lstatSync(lockPath).mtimeMs + 2_000) return undefined;
  return pid;
}

/**
 * @param {string} profileDir
 * @returns {Promise<ManagedBrowserState>}
 */
export async function inspectManagedBrowser(profileDir) {
  const active = readDevToolsActivePort(profileDir);
  if (active) {
    const endpoint = `http://127.0.0.1:${active.port}`;
    const browserUrl = await readCdpBrowserUrl(endpoint);
    // DevToolsActivePort survives every Chrome exit; only a live browser reporting the same id is this profile's.
    if (browserUrl && browserUrlMatches(browserUrl, active)) return { state: "running", endpoint, browserUrl };
  }
  const pid = managedProfileHolderPid(profileDir);
  return pid ? { state: "held", pid } : { state: "stopped" };
}

/**
 * @param {string} browserUrl
 * @param {{ port: number; browserPath: string }} active
 * @returns {boolean}
 */
function browserUrlMatches(browserUrl, active) {
  try {
    const url = new URL(browserUrl);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1" && Number(url.port) === active.port && url.pathname === active.browserPath;
  } catch {
    return false;
  }
}

/**
 * @param {string} profileDir
 * @param {number} pid
 * @returns {string}
 */
export function managedBrowserInUseMessage(profileDir, pid) {
  return `${IN_USE_MESSAGE_PREFIX}: ${profileDir} (Chrome pid ${pid}). Quit that Chrome; the next job reopens the profile, or run /oracle-auth to reopen it for sign-in.`;
}

/**
 * Readiness is attachability, not login: a stopped managed browser is ready because the next job starts it.
 * @param {string} stateDir
 * @param {string} profileDir
 * @returns {Promise<void>}
 */
export async function assertManagedBrowserAvailable(stateDir, profileDir) {
  // A launch or an idle quit in progress holds the profile lock; the profile is changing hands, not blocked.
  if (existsSync(join(getStateLocksDir(stateDir), hashOracleStateKey(MANAGED_BROWSER_LOCK_KIND, profileDir)))) return;
  const current = await inspectManagedBrowser(profileDir);
  if (current.state === "held") throw new Error(managedBrowserInUseMessage(profileDir, current.pid));
}

/**
 * Hold a lease on the managed browser for one job or sign-in: reuse the Chrome serving the profile, or start one under a keeper.
 * The lease is written under the profile lock before the browser is resolved, so an idle keeper can never quit it mid-attach.
 * @param {{ stateDir: string; profileDir: string; executablePath: string; args?: string[]; owner: string; launchTimeoutMs?: number }} options
 * @returns {Promise<ManagedBrowserAttachment>}
 */
export async function acquireManagedBrowser({ stateDir, profileDir, executablePath, args = [], owner, launchTimeoutMs = LAUNCH_TIMEOUT_MS }) {
  const leaseKey = `${owner}:${randomUUID()}`;
  try {
    return await withStateLock(stateDir, MANAGED_BROWSER_LOCK_KIND, profileDir, { processPid: process.pid, owner, action: "attach" }, async () => {
      /** @type {ManagedBrowserUserLease} */
      const lease = { leaseKey, profileDir, owner, processPid: process.pid, createdAt: new Date().toISOString() };
      await writeStateLeaseMetadata(stateDir, MANAGED_BROWSER_USER_KIND, leaseKey, lease);
      const current = await inspectManagedBrowser(profileDir);
      if (current.state === "running") return { leaseKey, endpoint: current.endpoint, browserUrl: current.browserUrl, launched: false };
      if (current.state === "held") throw new Error(managedBrowserInUseMessage(profileDir, current.pid));
      const started = await startManagedBrowserKeeper({ profileDir, executablePath, args, idleMs: managedBrowserIdleMs(), launchTimeoutMs });
      return { leaseKey, ...started, launched: true };
    }, ACQUIRE_LOCK_TIMEOUT_MS);
  } catch (error) {
    await releaseStateLease(stateDir, MANAGED_BROWSER_USER_KIND, leaseKey);
    throw error;
  }
}

/**
 * @param {string} stateDir
 * @param {string | undefined} leaseKey
 * @returns {Promise<void>}
 */
export async function releaseManagedBrowser(stateDir, leaseKey) {
  await releaseStateLease(stateDir, MANAGED_BROWSER_USER_KIND, leaseKey);
}

/**
 * Whether anything still needs the browser: a live lease holder, or a page someone opened (a sign-in tab, a tab whose cleanup failed).
 * Leases of dead processes are pruned. An unreadable page inventory counts as in use: the keeper never quits on uncertainty.
 * @param {string} stateDir
 * @param {string} profileDir
 * @param {string} endpoint
 * @returns {Promise<boolean>}
 */
export async function managedBrowserInUse(stateDir, profileDir, endpoint) {
  const leases = /** @type {Partial<ManagedBrowserUserLease>[]} */ (listStateLeaseMetadata(stateDir, MANAGED_BROWSER_USER_KIND));
  let leased = false;
  for (const lease of leases) {
    if (lease?.profileDir !== profileDir) continue;
    if (isProcessAlive(lease.processPid)) leased = true;
    else await releaseStateLease(stateDir, MANAGED_BROWSER_USER_KIND, lease.leaseKey);
  }
  if (leased) return true;
  try {
    const response = await fetch(new URL("/json/list", endpoint), { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) return true;
    const targets = await response.json();
    return !Array.isArray(targets) || targets.some((target) => target?.type === "page" && target.url !== "about:blank");
  } catch {
    return true;
  }
}

/**
 * Spawn the detached keeper and wait for its one-line handshake: the endpoint of the Chrome it launched, or why it could not.
 * @param {ManagedBrowserLaunchSpec} spec
 * @returns {Promise<{ endpoint: string; browserUrl: string }>}
 */
async function startManagedBrowserKeeper(spec) {
  const keeper = spawn(resolveNodeExecutable(), [KEEPER_PATH, JSON.stringify(spec)], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: sweetCookieSafeStoragePasswordScrubbedEnv(),
  });
  try {
    /** @type {{ error?: unknown; endpoint?: unknown; browserUrl?: unknown } | undefined} */
    const reply = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        keeper.kill("SIGTERM");
        reject(new Error(`The managed browser keeper did not report within ${spec.launchTimeoutMs + 5_000}ms.`));
      }, spec.launchTimeoutMs + 5_000);
      keeper.stdout?.on("data", (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, newline)));
        } catch (error) {
          reject(error);
        }
      });
      keeper.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      // `close` follows the last stdout chunk; `exit` can arrive before the handshake line is read.
      keeper.once("close", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`The managed browser keeper exited before Chrome was ready (${signal ?? `exit code ${code}`}).`));
      });
    });
    if (typeof reply?.error === "string") throw new Error(reply.error);
    if (typeof reply?.endpoint !== "string" || typeof reply?.browserUrl !== "string") throw new Error("The managed browser keeper returned no endpoint.");
    return { endpoint: reply.endpoint, browserUrl: reply.browserUrl };
  } finally {
    keeper.stdout?.destroy();
    keeper.unref();
  }
}
