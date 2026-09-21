import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface OracleTrackedProcessOptions {
  termGraceMs?: number;
  killGraceMs?: number;
}

export interface OracleDetachedProcessHandle {
  pid: number | undefined;
  startedAt?: string;
}

export interface OracleRunCommandOptions extends SpawnOptions {
  /** Terminate the process tree after this long; unset or 0 means no deadline. */
  timeoutMs?: number;
  /** Force-kill this long after the termination request (default 2000). */
  killGraceMs?: number;
  /** Written to stdin, which is closed either way. */
  input?: string | Buffer;
  /** Resolve with the exit code instead of rejecting on non-zero exit or timeout. */
  allowFailure?: boolean;
}

export interface OracleRunCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export declare function resolveNodeExecutable(): string;
export declare function resolveAgentBrowserBinary(env?: Record<string, string | undefined>): string;
export declare function killProcessTree(child: ChildProcess): void;
export declare function killProcess(child: ChildProcess): void;
export declare function runCommand(command: string, args: string[], options?: OracleRunCommandOptions): Promise<OracleRunCommandResult>;
export declare function readProcessStartedAt(pid: number | undefined): string | undefined;
export declare function isProcessAlive(pid: number | undefined): boolean;
export declare function isTrackedProcessAlive(pid: number | undefined, startedAt?: string): boolean;
export declare function waitForProcessStartedAt(pid: number | undefined, timeoutMs?: number): Promise<string | undefined>;
export declare function terminateTrackedProcess(
  pid: number | undefined,
  startedAt?: string,
  options?: OracleTrackedProcessOptions,
): Promise<boolean>;
export declare function spawnDetachedNodeProcess(scriptPath: string, args?: string[]): Promise<OracleDetachedProcessHandle>;
