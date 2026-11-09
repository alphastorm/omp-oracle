// Purpose: Enforce the shared host/worker agent-browser driver floor before browser work.
import { runCommand } from "./process-helpers.mjs";

export const AGENT_BROWSER_MIN_VERSION = "0.41.2";

/** @param {string} output @returns {[number, number, number] | undefined} */
export function parseAgentBrowserVersion(output) {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** @param {[number, number, number]} version @returns {boolean} */
export function isAgentBrowserVersionSupported(version) {
  return version[0] > 0 || (version[0] === 0 && (version[1] > 41 || (version[1] === 41 && version[2] >= 2)));
}

/**
 * @param {string} binary
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function assertAgentBrowserVersionSupported(binary, { timeoutMs = 5_000 } = {}) {
  const undetermined = (/** @type {string} */ detail) => new Error(
    `Oracle prerequisite agent-browser version could not be determined from \`${binary} --version\` (${detail}); oracle requires ${AGENT_BROWSER_MIN_VERSION} or newer.`,
  );
  let result;
  try {
    result = await runCommand(binary, ["--version"], { timeoutMs, allowFailure: true });
  } catch (error) {
    throw undetermined(error instanceof Error ? error.message : String(error));
  }
  const version = result.code === 0 && !result.timedOut ? parseAgentBrowserVersion(result.stdout) : undefined;
  if (!version) throw undetermined(result.stderr || result.stdout || `exit code ${result.code}`);
  const found = version.join(".");
  if (!isAgentBrowserVersionSupported(version)) {
    throw new Error(`Oracle prerequisite agent-browser is too old: found ${found} at ${binary}, need ${AGENT_BROWSER_MIN_VERSION} or newer. Upgrade agent-browser (npm install -g agent-browser@latest or brew upgrade agent-browser) and retry.`);
  }
  return found;
}
