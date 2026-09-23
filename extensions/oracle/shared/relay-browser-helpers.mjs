import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { sweetCookieSafeStoragePasswordScrubbedEnv } from "./browser-profile-helpers.mjs";

const runFile = promisify(execFile);
/** @typedef {{success?: boolean, code?: string, error?: string, data?: {tabs?: Array<{targetId: string, active?: boolean}>, targetId?: string}}} CommandResponse */

/**
 * Every failure names the endpoint and cause behind one stable prefix; the extension's
 * error codes and session readiness classify on that prefix.
 * @param {string} endpoint
 */
export async function assertRelayReady(endpoint) {
  let reason;
  try {
    const response = await fetch(new URL("/json/version", endpoint), {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    const version = response.ok ? await response.json().catch(() => undefined) : undefined;
    if (typeof version?.webSocketDebuggerUrl === "string") return;
    reason = response.ok ? "no webSocketDebuggerUrl in /json/version" : `HTTP ${response.status} from /json/version`;
  } catch (error) {
    // Bun reports the socket failure on the error itself, Node on its cause.
    const code = error?.cause?.code ?? error?.code;
    reason = code === "ConnectionRefused" || code === "ECONNREFUSED" ? "connection refused"
      : error?.name === "TimeoutError" ? "no response within 5 s"
      : String(code ?? error?.message ?? error);
  }
  throw new Error(`ChatGPT browser relay is unavailable: ${endpoint} (${reason}). Start the Chrome that serves this endpoint; Oracle does not launch it or fall back to another browser.`);
}

// The driver parses CLI target references as Chrome hex IDs or labels. Relay
// IDs are opaque: retain them for identity checks, and close the pinned current
// tab instead. Never recover by selecting another tab.
/** @param {import("./relay-browser-helpers.d.mts").RelayTabCleanupOptions} options */
export async function closeRelayTab({ binary, sessionName, endpoint, targetId }) {
  const prefix = ["--session", sessionName, "--cdp", endpoint, "--pin-tab", "--json"];
  /** @param {...string} args @returns {Promise<CommandResponse>} */
  const run = async (...args) => {
    try {
      const { stdout } = await runFile(binary, [...prefix, ...args], {
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
        env: sweetCookieSafeStoragePasswordScrubbedEnv(),
      });
      return JSON.parse(stdout);
    } catch (error) {
      if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
        /** @type {CommandResponse | undefined} */
        let response;
        try {
          response = JSON.parse(error.stdout);
        } catch { /* Preserve the original subprocess error. */ }
        if (response?.code === "tab_gone") return response;
        if (typeof response?.error === "string") throw new Error(response.error);
      }
      throw error;
    }
  };
  await assertRelayReady(endpoint);
  // The driver spawns a fresh pinned daemon (and its own tab) for a session whose daemon is gone.
  // Consult the relay inventory first so an already-closed target never costs a stray tab.
  if (!(await relayTargetListed(endpoint, targetId))) return;
  const listed = await run("tab", "list");
  if (!listed.success || !Array.isArray(listed.data?.tabs)) {
    throw new Error("Could not inspect the relay job's pinned tab; cleanup refused.");
  }
  const owned = listed.data.tabs.find((tab) => tab.targetId === targetId);
  if (owned) {
    if (!owned.active) throw new Error("The active relay tab is not owned by this job; cleanup refused.");
    const closed = await run("tab", "close");
    if (closed.code !== "tab_gone" && (!closed.success || closed.data?.targetId !== targetId)) {
      throw new Error("The relay driver did not confirm closing the job-owned tab.");
    }
  }
  // The driver can omit a live target or acknowledge a rejected close. Always
  // verify the relay inventory before discarding the durable owned identity.
  await assertRelayReady(endpoint);
  // Native Chrome can acknowledge close before target discovery removes the tab.
  // Wait only after an owned close; never retry the close or select another tab.
  const deadline = Date.now() + 2000;
  while (await relayTargetListed(endpoint, targetId)) {
    if (!owned || Date.now() >= deadline) {
      throw new Error("The job-owned relay tab remains open after cleanup.");
    }
    await sleep(100);
  }
}

/** @param {string} endpoint @param {string} targetId */
async function relayTargetListed(endpoint, targetId) {
  const response = await fetch(new URL("/json/list", endpoint), {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Could not verify relay tab cleanup.");
  const targets = await response.json();
  return !Array.isArray(targets) || targets.some((target) => target.id === targetId);
}
