import type { OracleAuthLoginProbe, OracleAuthPageClassification } from "./auth-flow-helpers.mjs";
export interface ProviderPageSignals { text: string; composerPresent: boolean }
export interface ProviderPageArgs { url: string; snapshot: string; signals?: ProviderPageSignals }
export interface ChatGptJobPageArgs extends ProviderPageArgs { probe?: OracleAuthLoginProbe; allowedOrigins: readonly string[] }
export interface DetectedProviderSignals { challenge?: "blocking" | "settling"; transient?: string; uploadError?: string; headerTooLarge: boolean }
export declare const PROVIDER_PATTERNS: { challenge: RegExp[]; challengeSettling: RegExp; transient: string[]; visibleBlocker: string[]; upload: string[]; responseFailure: string[]; headerTooLarge: RegExp };
export declare function snapshotSignalText(snapshot: string): string;
export declare function providerPageSignalsExpression(options: { editorSelector: string }): string;
export declare function detectProviderSignals(input: { snapshot: string; signals?: ProviderPageSignals }): DetectedProviderSignals;
export declare function visibleBlockerInSnapshot(snapshot: string): string | undefined;
export declare function classifyChatGptJobPage(args: ChatGptJobPageArgs): OracleAuthPageClassification;
export declare function classifyGrokPage(args: ProviderPageArgs): OracleAuthPageClassification;
export declare function classifyGrokAuthPage(args: ProviderPageArgs & { cookieSourceLabel: string }): OracleAuthPageClassification;
export declare function hasGrokLoginCta(text: string): boolean;
export declare function detectCompletionFailure(args: { hasStopStreaming: boolean; hasRetryButton: boolean; turnText: string; readSignals: () => Promise<ProviderPageSignals | undefined> }): Promise<string | undefined>;
export declare function formatProviderTransientErrorMessage(job: { selection?: { provider?: string } }, errorText: string, context?: string): string;
export declare function providerTransientErrorMessage(job: { selection?: { provider?: string } }, snapshot: string, context?: string): string;
export declare function throwIfProviderTransientError(job: { selection?: { provider?: string } }, snapshot: string, context?: string): void;
