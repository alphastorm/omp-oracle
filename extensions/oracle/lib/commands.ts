// Purpose: Register slash commands for oracle auth/bootstrap, status inspection, cancellation, and cleanup.
// Responsibilities: Bridge command handlers to shared oracle lifecycle helpers, surface consistent summaries, and coordinate follow-up queue advancement.
// Scope: Command-facing orchestration only; durable lifecycle mutations live in jobs/runtime/tools modules and browser execution stays in worker scripts.
// Usage: Imported by the oracle extension entrypoint to register /oracle-* commands with pi.
// Invariants/Assumptions: Commands operate on persisted project-scoped jobs and rely on shared observability formatting for detached-state clarity.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatOracleCancelOutcome, formatOracleJobSummary } from "../shared/job-observability-helpers.mjs";
import { runOracleAuthBootstrap } from "./auth.js";
import { normalizeOracleProviderAlias, type OracleProvider } from "./config.js";
import { isOracleProjectTrusted } from "./trust.js";
import {
  cancelOracleJob,
  getJobDir,
  isOpenOracleJob,
  isTerminalOracleJob,
  listJobsForCwd,
  listJobsForProject,
  ORACLE_STALE_HEARTBEAT_MS,
  markWakeupSettled,
  readJob,
  readJobForProject,
  reconcileStaleOracleJobs,
  removeTerminalOracleJob,
  shouldAdvanceQueueAfterCancellation,
} from "./jobs.js";
import { getQueuePosition, promoteQueuedJobs } from "./queue.js";
import { refreshOracleStatus } from "./poller.js";
import { isLockTimeoutError, withGlobalReconcileLock } from "./locks.js";
import { getProjectId } from "./runtime.js";

async function summarizeJob(jobId: string, options?: { responsePreview?: boolean }): Promise<string> {
  const job = readJob(jobId);
  if (!job) return `Oracle job ${jobId} not found.`;

  const responseAvailable = Boolean(job.responsePath && existsSync(job.responsePath));
  let responsePreview: string | undefined;
  let responseLength: number | undefined;
  if (options?.responsePreview && responseAvailable && job.responsePath) {
    try {
      const response = await readFile(job.responsePath, "utf8");
      responsePreview = response.slice(0, 4000);
      responseLength = response.length;
    } catch {
      responsePreview = undefined;
    }
  }

  return formatOracleJobSummary(job, {
    queuePosition: job.status === "queued" ? getQueuePosition(job.id) : undefined,
    artifactsPath: `${getJobDir(job.id)}/artifacts`,
    responseAvailable,
    responsePreview,
    responseLength,
    heartbeatStaleMs: ORACLE_STALE_HEARTBEAT_MS,
  });
}

function listRecentJobIds(projectId: string, limit = 5): string | undefined {
  const jobs = listJobsForProject(projectId).slice(0, limit);
  if (jobs.length === 0) return undefined;
  return jobs.map((job) => `${job.id} (${job.status})`).join(", ");
}

function readScopedJob(jobId: string, cwd: string) {
  const job = readJob(jobId);
  if (!job || job.projectId !== getProjectId(cwd)) return undefined;
  return job;
}

function parseOracleAuthProvider(args: string): OracleProvider | undefined {
  const value = args.trim();
  if (!value) return undefined;
  const provider = normalizeOracleProviderAlias(value);
  if (provider) return provider;
  throw new Error("Usage: /oracle-auth [chatgpt|grok]");
}

function emitCommandOutput(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.mode === "print") {
    process.stdout.write(`${message}\n`);
    return;
  }
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  pi.sendMessage({
    customType: "oracle-command-output",
    content: message,
    display: true,
    details: { level },
  });
}

export function registerOracleCommands(pi: ExtensionAPI, authWorkerPath: string, workerPath: string): void {
  async function inspectJob(args: string, ctx: ExtensionCommandContext, options: { source: "oracle_status" | "oracle_read_command" }): Promise<void> {
    const responsePreview = options.source === "oracle_read_command";
    try {
      const match = args.trim().match(/^(?:([^- \t\r\n][^ \t\r\n]*)\s*)?(?:--projectId\s+(.+))?$/);
      const command = responsePreview ? "oracle-read" : "oracle-status";
      if (!match) throw new Error(`Usage: /${command} [job-id] [--projectId <project-root>]`);
      const explicitJobId = match[1];
      const projectId = match[2] === undefined ? getProjectId(ctx.cwd)
        : match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
      if (typeof projectId !== "string" || !projectId.trim()) throw new Error("projectId must be a non-empty project root");
      const jobId = explicitJobId || listJobsForProject(projectId)[0]?.id;
      if (!jobId) {
        emitCommandOutput(pi, ctx, "No oracle jobs found for this project", "info");
        return;
      }
      const job = readJobForProject(jobId, projectId);
      if (isTerminalOracleJob(job)) {
        await markWakeupSettled(job.id, {
          source: options.source,
          sessionFile: ctx.sessionManager.getSessionFile?.(),
          cwd: ctx.cwd,
        });
      }
      const summary = await summarizeJob(job.id, { responsePreview });
      const recentJobs = !responsePreview && !explicitJobId ? listRecentJobIds(projectId) : undefined;
      emitCommandOutput(pi, ctx, [summary, recentJobs ? `Recent jobs: ${recentJobs}` : undefined].filter(Boolean).join("\n"), "info");
    } catch (error) {
      emitCommandOutput(pi, ctx, error instanceof Error ? error.message : String(error), "warning");
    }
  }

  pi.registerCommand("oracle-auth", {
    description: "Sync ChatGPT or Grok cookies from the configured local browser profile into the provider auth seed profile",
    handler: async (args, ctx) => {
      try {
        const provider = parseOracleAuthProvider(args);
        const providerLabel = provider === "grok" ? "Grok" : provider === "chatgpt" ? "ChatGPT" : "configured provider";
        emitCommandOutput(pi, ctx, `Syncing ${providerLabel} cookies from the configured local browser profile into the oracle auth seed profile…`, "info");
        const result = await runOracleAuthBootstrap(authWorkerPath, ctx.cwd, provider, { projectConfigTrusted: isOracleProjectTrusted(ctx) });
        emitCommandOutput(pi, ctx, result, "info");
      } catch (error) {
        emitCommandOutput(pi, ctx, error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.registerCommand("oracle-status", {
    description: "Show oracle job status and recent job ids; optionally pass --projectId <project-root>",
    handler: (args, ctx) => inspectJob(args, ctx, { source: "oracle_status" }),
  });

  pi.registerCommand("oracle-read", {
    description: "Show oracle job status plus saved response preview; optionally pass --projectId <project-root>",
    handler: (args, ctx) => inspectJob(args, ctx, { source: "oracle_read_command" }),
  });

  pi.registerCommand("oracle-cancel", {
    description: "Cancel a queued or active oracle job by id",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        emitCommandOutput(pi, ctx, "Usage: /oracle-cancel <job-id>\nUse /oracle-status to find the job id you want to cancel.", "warning");
        return;
      }

      const job = readScopedJob(jobId, ctx.cwd);
      if (!job) {
        emitCommandOutput(pi, ctx, `Oracle job ${jobId} not found in this project`, "warning");
        return;
      }
      if (!isOpenOracleJob(job)) {
        if (isTerminalOracleJob(job)) {
          emitCommandOutput(pi, ctx, `Job is already terminal: ${job.status}. Use /oracle-read ${job.id} for details or /oracle-clean ${job.id} to remove it.`, "info");
        } else {
          emitCommandOutput(pi, ctx, `Oracle job ${jobId} is not cancellable (${job.status})`, "info");
        }
        return;
      }

      const cancelled = await cancelOracleJob(jobId);
      if (shouldAdvanceQueueAfterCancellation(cancelled)) {
        await promoteQueuedJobs({ workerPath, source: "oracle_cancel_command" });
      }
      refreshOracleStatus(ctx);
      emitCommandOutput(pi, ctx, formatOracleCancelOutcome(cancelled), "info");
    },
  });

  pi.registerCommand("oracle-clean", {
    description: "Remove oracle temp files for terminal jobs; recently woken jobs may stay retained briefly",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const target = args.trim();
      if (!target) {
        emitCommandOutput(pi, ctx, "Usage: /oracle-clean <job-id|all>", "warning");
        return;
      }

      const jobs = target === "all" ? listJobsForCwd(ctx.cwd) : [readScopedJob(target, ctx.cwd)].filter(Boolean);
      if (jobs.length === 0) {
        emitCommandOutput(pi, ctx, "No matching oracle jobs found", "warning");
        return;
      }

      const nonTerminalJobs = jobs.filter((job): job is NonNullable<typeof job> => Boolean(job && !isTerminalOracleJob(job)));
      if (nonTerminalJobs.length > 0) {
        emitCommandOutput(
          pi,
          ctx,
          `Refusing to remove non-terminal oracle job${nonTerminalJobs.length === 1 ? "" : "s"}: ${nonTerminalJobs.map((job) => job.id).join(", ")}`,
          "warning",
        );
        return;
      }

      const cleanupWarnings: string[] = [];
      let removedCount = 0;
      const removeJobs = async () => {
        for (const job of jobs) {
          if (!job) continue;
          const result = await removeTerminalOracleJob(job);
          if (result.removed) removedCount += 1;
          cleanupWarnings.push(...result.cleanupReport.warnings.map((warning) => `${job.id}: ${warning}`));
        }
      };

      try {
        await withGlobalReconcileLock({ processPid: process.pid, source: "oracle_clean", cwd: ctx.cwd }, async () => {
          await reconcileStaleOracleJobs();
          await removeJobs();
        });
      } catch (error) {
        if (!isLockTimeoutError(error, "reconcile", "global")) throw error;
        await removeJobs();
      }

      refreshOracleStatus(ctx);
      const warningSuffix = cleanupWarnings.length > 0 ? ` Cleanup blockers/warnings:\n${cleanupWarnings.join("\n")}` : "";
      const retentionWarning = cleanupWarnings.find((warning) => warning.includes("post-send retention grace window") && warning.includes("Retry after "));
      const retryAfter = retentionWarning?.match(/Retry after ([^ ]+)/)?.[1];
      const removalSummary = retryAfter && removedCount < jobs.length
        ? `Job retained for wake-up safety. Retry cleanup after ${retryAfter}.`
        : removedCount === jobs.length
          ? `Removed ${removedCount} oracle job director${removedCount === 1 ? "y" : "ies"}.`
          : `Removed ${removedCount} of ${jobs.length} oracle job director${jobs.length === 1 ? "y" : "ies"}; retained ${jobs.length - removedCount} due to cleanup blockers or warnings.`;
      emitCommandOutput(pi, ctx, `${removalSummary}${warningSuffix}`, cleanupWarnings.length > 0 ? "warning" : "info");
    },
  });
}
