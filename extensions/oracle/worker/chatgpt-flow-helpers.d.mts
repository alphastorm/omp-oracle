export interface OracleStableValueState {
  lastValue: string;
  stableCount: number;
}

export interface OracleStaleStopState {
  text: string;
  since: number | undefined;
  stale: boolean;
}

export interface OracleSendAcceptanceState {
  url?: string;
  urlKnown?: boolean;
  assistantCount?: number;
  stopStreaming?: boolean;
}

export declare function assistantSnapshotSlice(snapshot: string, composerLabel: string, responseIndex: number): string | undefined;
export declare function composerFileEntryCount(snapshot: string, fileLabel: string, composerLabel: string): number;
export declare function stripUrlQueryAndHash(url: string | undefined): string;
export declare function isConversationPathUrl(url: string): boolean;
export declare function conversationIdFromUrl(url: string | undefined): string | undefined;
export declare function providerSendAccepted(before: OracleSendAcceptanceState, after: OracleSendAcceptanceState): boolean;
export declare function chatGptStreamingVisible(snapshot: string): boolean;
export declare function chatGptGenerationActive(args: { snapshot: string; domStopButton?: boolean }): boolean;
export declare function resolveStableConversationUrlCandidate(url: string, previousChatUrl?: string): string | undefined;
export declare function nextStableValueState(
  state: Partial<OracleStableValueState> | undefined,
  nextValue: string,
): OracleStableValueState;
export declare function nextStaleStopState(
  state: Partial<OracleStaleStopState> | undefined,
  input: { stopControl: boolean; text: string; now: number; staleAfterMs: number },
): OracleStaleStopState;
