import type { OracleRunCommandOptions, OracleRunCommandResult } from "../shared/process-helpers.mjs";
export declare const AGENT_BROWSER_TIMEOUTS: { default: number; open: number; connect: number; batch: number; status: number; diagnostics: number };
export declare function resolveAgentBrowserTimeoutMs(args: string[], explicit?: number, env?: NodeJS.ProcessEnv): number;
export declare class AgentBrowserTimeoutError extends Error {
  code: string;
  subcommand: string;
  timeoutMs: number;
  constructor(subcommand: string, timeoutMs: number, message: string);
}
export interface AgentBrowserRunnerDependencies {
  binary: string;
  baseArgs: () => string[];
  beforeCommand?: () => Promise<void>;
  connectionCheckEnabled: () => boolean;
  shuttingDown: () => boolean;
  disconnectMessage: string;
}
export declare function createAgentBrowserRunner(dependencies: AgentBrowserRunnerDependencies): {
  run(args: string[], options?: OracleRunCommandOptions): Promise<OracleRunCommandResult>;
  streamStatus(): Promise<Record<string, unknown>>;
};
export declare function parseEvalResult(stdout?: string): any;
export declare function batchInvocation(commands: string[][]): { args: ["batch"]; input: string };
