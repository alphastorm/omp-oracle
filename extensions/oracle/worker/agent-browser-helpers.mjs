// Bounded agent-browser execution; never retry a command that may already have run.
import { CommandTimeoutError, runCommand } from "../shared/process-helpers.mjs";

export const AGENT_BROWSER_TIMEOUTS = { default: 60_000, open: 90_000, connect: 30_000, batch: 120_000, status: 15_000, diagnostics: 15_000 };

/** @param {string[]} args @param {number} [explicit] @param {NodeJS.ProcessEnv} [env] */
export function resolveAgentBrowserTimeoutMs(args, explicit, env = process.env) {
  if (explicit !== undefined) return explicit;
  const command = args.find((arg) => !arg.startsWith("--"));
  if (command === "open" || command === "connect" || command === "batch") return AGENT_BROWSER_TIMEOUTS[command];
  const raw = env.PI_ORACLE_AGENT_BROWSER_TIMEOUT_MS?.trim() || "";
  const value = /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(value) && value > 0 ? Math.min(150_000, Math.max(5_000, value)) : AGENT_BROWSER_TIMEOUTS.default;
}

export class AgentBrowserTimeoutError extends Error {
  /** @param {string} subcommand @param {number} timeoutMs @param {string} message */
  constructor(subcommand, timeoutMs, message) {
    super(message);
    this.name = "AgentBrowserTimeoutError";
    this.code = "agent_browser_timeout";
    this.subcommand = subcommand;
    this.timeoutMs = timeoutMs;
  }
}

/** @param {import("./agent-browser-helpers.d.mts").AgentBrowserRunnerDependencies} dependencies */
export function createAgentBrowserRunner({ binary, baseArgs, beforeCommand, connectionCheckEnabled, shuttingDown, disconnectMessage }) {
  async function checkIdentity() {
    if (shuttingDown()) throw new Error("Oracle worker is shutting down.");
    if (connectionCheckEnabled()) await beforeCommand?.();
  }
  async function streamStatus() {
    await checkIdentity();
    const result = await runCommand(binary, [...baseArgs(), "--json", "stream", "status"], { allowFailure: true, timeoutMs: AGENT_BROWSER_TIMEOUTS.status });
    try { return JSON.parse(result.stdout || "{}").data || {}; } catch { return {}; }
  }
  /** @param {string[]} args @param {import("../shared/process-helpers.d.mts").OracleRunCommandOptions} [options] */
  async function run(args, options = {}) {
    if (args[0] === "wait" && /^\d+$/.test(args[1] || "")) throw new Error("numeric agent-browser waits must use sleep()");
    await checkIdentity();
    try {
      return await runCommand(binary, [...baseArgs(), ...args], { ...options, timeoutMs: resolveAgentBrowserTimeoutMs(args, options.timeoutMs) });
    } catch (error) {
      if (connectionCheckEnabled()) {
        const status = await streamStatus().catch(() => ({}));
        if (status.connected === false) throw new Error(disconnectMessage);
      }
      throw error instanceof CommandTimeoutError ? new AgentBrowserTimeoutError(args.find((arg) => !arg.startsWith("--")) || "", error.timeoutMs, error.message) : error;
    }
  }
  return { run, streamStatus };
}

/** Decode driver eval output, including the literal undefined token introduced in 0.41.2.
 * @param {string} [stdout] @returns {any}
 */
export function parseEvalResult(stdout) {
  if (!stdout) return undefined;
  const value = stdout.trim();
  if (value === "undefined") return undefined;
  try {
    let parsed = JSON.parse(value);
    while (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed;
  } catch { return value; }
}

/** @param {string[][]} commands @returns {{args: ["batch"]; input: string}} */
export function batchInvocation(commands) {
  return { args: ["batch"], input: JSON.stringify(commands) };
}
