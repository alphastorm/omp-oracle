import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sweetCookieSafeStoragePasswordScrubbedEnv } from "./browser-profile-helpers.mjs";

const runFile = promisify(execFile);
/** @typedef {{success?: boolean, code?: string, error?: string, data?: {tabs?: Array<{targetId: string, active?: boolean}>, targetId?: string}}} CommandResponse */

/** @param {string} endpoint */
export async function assertRelayReady(endpoint) {
  const response = await fetch(new URL("/json/version", endpoint), {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok || typeof (await response.json()).webSocketDebuggerUrl !== "string") {
    throw new Error("ChatGPT browser relay is unavailable. Connect the relay extension in your signed-in Chrome; do not import cookies.");
  }
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
  if (await relayTargetListed(endpoint, targetId)) {
    throw new Error("The job-owned relay tab remains open after cleanup.");
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
