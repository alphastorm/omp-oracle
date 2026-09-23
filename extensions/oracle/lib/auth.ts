// Purpose: Share oracle auth-bootstrap orchestration between slash commands and agent-facing tools.
// Responsibilities: Load effective auth guidance, run reconcile maintenance, spawn the auth bootstrap worker, open managed-browser sign-in, and return user-facing results.
// Scope: Extension-side auth bootstrap orchestration only; browser cookie import and profile validation stay in worker/auth-bootstrap.mjs.
// Usage: Imported by oracle commands and tools whenever the shared oracle auth seed profile must be refreshed.
// Invariants/Assumptions: Auth bootstrap runs under the global reconcile lock when available, uses the effective oracle config for the current workspace root, and returns the worker's stdout/stderr message verbatim on success or failure.
import { spawn } from "node:child_process";
import { formatOracleAuthConfigRemediation, formatOracleAuthConfigSummary, getOracleConfigLoadDetails, loadOracleConfig, resolveOracleConfigForProvider, type OracleConfig, type OracleConfigLoadOptions, type OracleProvider } from "./config.js";
import { pruneTerminalOracleJobs, reconcileStaleOracleJobs } from "./jobs.js";
import { isLockTimeoutError, withGlobalReconcileLock } from "./locks.js";
import { acquireManagedBrowser, managedBrowserIdleMs, releaseManagedBrowser } from "../shared/managed-browser-helpers.mjs";
import { resolveNodeExecutable } from "../shared/process-helpers.mjs";
import { RelayCdpClient } from "../shared/relay-cdp-client.mjs";
import { getOracleStateDir } from "../shared/state-path-helpers.mjs";
import { sleep } from "../shared/time-helpers.mjs";

const SIGN_IN_CHECK_MS = 10_000;

/** A signed-in ChatGPT tab settles off the auth pages with an account id behind /backend-api/me (the worker's login-probe identity); a signed-out one never does. */
async function managedTabSignedIn(endpoint: string, targetId: string, chatOrigin: string): Promise<boolean> {
  const expression = `(async () => {
    if (location.origin !== ${JSON.stringify(chatOrigin)} || /^\\/(auth|login|signin|log-in)/i.test(location.pathname)) return false;
    const response = await fetch("/backend-api/me", { cache: "no-store", credentials: "include" });
    const me = response.status === 200 ? await response.json().catch(() => null) : null;
    return typeof me?.id === "string" && me.id.length > 0;
  })()`;
  const cdp = await RelayCdpClient.connect(endpoint);
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const deadline = Date.now() + SIGN_IN_CHECK_MS;
    while (Date.now() < deadline) {
      const evaluated = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).catch(() => undefined);
      if (evaluated?.result.value === true) return true;
      await sleep(500);
    }
    return false;
  } finally {
    cdp.close();
  }
}

/** Sign-in for the managed browser happens in that browser: open ChatGPT there, reusing a running Chrome or starting one. */
async function openManagedBrowserSignIn(config: OracleConfig, profileDir: string): Promise<string> {
  const executablePath = config.browser.executablePath;
  if (!executablePath) {
    throw new Error("The managed ChatGPT browser needs browser.executablePath, and no Chrome executable was detected. Set it in the agent-level oracle.json.");
  }
  const stateDir = getOracleStateDir();
  const managed = await acquireManagedBrowser({ stateDir, profileDir, executablePath, args: config.browser.args, owner: "sign-in" });
  try {
    const opened = await fetch(new URL(`/json/new?${config.browser.authUrl}`, managed.endpoint), { method: "PUT", signal: AbortSignal.timeout(5000) });
    if (!opened.ok) throw new Error(`Chrome did not open the ChatGPT sign-in tab (HTTP ${opened.status}).`);
    const created: unknown = await opened.json().catch(() => undefined);
    const targetId = created && typeof created === "object" && "id" in created && typeof created.id === "string" ? created.id : undefined;
    if (!targetId) throw new Error("Chrome did not report the ChatGPT sign-in tab it opened.");
    if (await managedTabSignedIn(managed.endpoint, targetId, new URL(config.browser.chatUrl).origin)) {
      // Nothing to sign in to, and an open tab would keep an Oracle-launched browser from quitting.
      await fetch(new URL(`/json/close/${targetId}`, managed.endpoint), { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      return `ChatGPT is already signed in in the managed browser (${profileDir}); nothing to do.`;
    }
  } finally {
    await releaseManagedBrowser(stateDir, managed.leaseKey);
  }
  return [
    `ChatGPT is not signed in in the managed browser (${profileDir}). Sign in on the ChatGPT tab it just opened; the login persists in that profile.`,
    managed.launched
      ? `Oracle keeps this browser open while that tab is open and quits it ${Math.round(managedBrowserIdleMs() / 1000)} s after the tab and any jobs are gone.`
      : "This browser was already running outside Oracle, so Oracle leaves it open.",
  ].join("\n");
}

export async function runOracleAuthBootstrap(authWorkerPath: string, cwd: string, provider?: OracleProvider, configOptions?: OracleConfigLoadOptions): Promise<string> {
  const baseConfig = loadOracleConfig(cwd, configOptions);
  const config = resolveOracleConfigForProvider(baseConfig, provider ?? baseConfig.defaults.provider);
  if (config.browser.chatGptRelayEndpoint) {
    throw new Error("ChatGPT relay authentication stays in your existing Chrome. Finish login or any challenge there; oracle_auth will not import cookies in relay mode.");
  }
  if (config.browser.chatGptManagedProfileDir) return openManagedBrowserSignIn(config, config.browser.chatGptManagedProfileDir);
  const configLoad = getOracleConfigLoadDetails(cwd, configOptions);
  const authConfigGuidance = {
    ...configLoad,
    remediation: formatOracleAuthConfigRemediation(configLoad),
    summary: formatOracleAuthConfigSummary(configLoad),
  };

  try {
    await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_auth", cwd }, async () => {
      await reconcileStaleOracleJobs();
      await pruneTerminalOracleJobs();
    });
  } catch (error) {
    if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(resolveNodeExecutable(), [authWorkerPath, JSON.stringify({ config, configLoad: authConfigGuidance })], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const message = stdout.trim() || stderr.trim() || "Oracle auth bootstrap finished with no output.";
      if (code === 0) resolve(message);
      else reject(new Error(message));
    });
  });
}
