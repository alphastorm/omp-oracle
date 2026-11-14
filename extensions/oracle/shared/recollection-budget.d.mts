export declare const RECOLLECTION_STARTUP_BUDGET_MS: number;
export declare const RECOLLECTION_POST_WAIT_BUDGET_MS: number;
export declare const RECOLLECTION_FINALIZE_RESERVE_MS: number;
export declare const RECOLLECTION_READ_MARGIN_MS: number;
export declare const RECOLLECTION_RESEARCH_WAIT_MS: number;
export declare function recollectionWaitMs(job: { selection: { tool?: string }; config: { worker: { completionTimeoutMs: number } } }): number;
export declare function recollectionReadTimeoutMs(job: Parameters<typeof recollectionWaitMs>[0]): number;
export declare function recollectionOperationTimeoutMs(deadline: number | undefined, requested: number, now?: number): number;
