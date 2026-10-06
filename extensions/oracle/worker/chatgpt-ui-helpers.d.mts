export type OracleUiModelFamily = "instant" | "thinking" | "pro";
export type OracleUiEffort = "light" | "standard" | "extended" | "heavy";

export interface OracleUiSelection {
  modelFamily: OracleUiModelFamily;
  effort?: OracleUiEffort;
  autoSwitchToThinking?: boolean;
}

export declare const CHATGPT_CANONICAL_APP_ORIGINS: readonly string[];
export declare const CHATGPT_COMPOSER_LABELS: readonly string[];
export declare const CHATGPT_ADD_FILES_LABEL: string;
export declare const CHATGPT_SEND_LABELS: readonly string[];
export declare const CHATGPT_STOP_LABELS: readonly string[];
export declare const CHATGPT_COMPOSER_EDITOR_SELECTOR: string;
export declare const CHATGPT_STOP_CONTROL_SELECTOR: string;
export declare const CHATGPT_ATTACH_FILES_INPUT_SELECTOR: string;
export declare const CHATGPT_DEEP_RESEARCH_MENTION_SELECTOR: string;
export declare const CHATGPT_MODEL_PICKER_SELECTOR: string;

export declare function buildAllowedChatGptOrigins(chatUrl: string, authUrl?: string): string[];
export declare function stripChatGptResponseChrome(value: string | undefined): string;
export declare function matchesModelFamilyLabel(label: string | undefined, family: OracleUiModelFamily): boolean;
export declare function matchesRequestedModelControlLabel(label: string | undefined, selection: OracleUiSelection): boolean;
export declare function matchesCompactIntelligenceControlLabel(label: string | undefined): boolean;
export declare function matchesCompactIntelligenceOpenerLabel(label: string | undefined): boolean;
export declare function requestedEffortLabel(selection: OracleUiSelection): string | undefined;
export declare function effortSelectionVisible(snapshot: string, effortLabel: string | undefined): boolean;
export declare function snapshotHasClosedCompactSelection(snapshot: string, selection: OracleUiSelection): boolean;
export declare function snapshotHasModelConfigurationUi(snapshot: string): boolean;
export declare const POWER_SLIDER_TIER_LABELS: readonly string[];
export declare function snapshotHasPowerSliderMenu(snapshot: string): boolean;
export declare function powerSliderClosedIntoSelection(snapshot: string, selection: OracleUiSelection): boolean;
export declare function parsePowerSliderDescription(description: string | undefined): { label: string; index: number; count: number } | undefined;
export declare function powerSliderTargetLabel(selection: OracleUiSelection): string;
export declare function powerSliderStepKey(currentLabel: string, targetLabel: string): "ArrowLeft" | "ArrowRight" | undefined;
export declare function isDeepResearchMenuEntry(entry: { kind?: string; label?: string; disabled?: boolean }): boolean;
export declare function snapshotHasDeepResearchPill(snapshot: string): boolean;
export declare function classifyDeepResearchTurn(turn: { snapshot?: string; text?: string }): "started" | "reply";
export declare function parseDeepResearchWidgetText(text: string | undefined): { completed: boolean; report: string };
export declare function isChatGptComposerEntry(entry: import("./artifact-heuristics.d.mts").SnapshotEntry): boolean;
export declare function isChatGptStopEntry(entry: import("./artifact-heuristics.d.mts").SnapshotEntry): boolean;
export declare function snapshotHasUsableComposerControls(snapshot: string): boolean;
export declare function findDialogCloseEntry(snapshot: string): import("./artifact-heuristics.d.mts").SnapshotEntry | undefined;
export declare function waitForStationaryControl(selector: string, options?: { stableSamples?: number; intervalMs?: number; timeoutMs?: number }): Promise<boolean>;
export declare function snapshotHasModelOpener(snapshot: string): boolean;
export declare function matchesModelConfigurationOpener(entry: import("./artifact-heuristics.d.mts").SnapshotEntry): boolean;
export declare function snapshotHasSelectedLatestModel(snapshot: string): boolean;
export declare function autoSwitchToThinkingSelectionVisible(snapshot: string): boolean | undefined;
export declare function snapshotCanSafelySkipModelConfiguration(snapshot: string, selection: OracleUiSelection): boolean;
export declare function snapshotStronglyMatchesRequestedModel(snapshot: string, selection: OracleUiSelection): boolean;
export declare function snapshotWeaklyMatchesRequestedModel(snapshot: string, selection: OracleUiSelection): boolean;
export declare function buildAssistantCompletionSignature(args: {
  responseText: string;
  artifactLabels?: string[];
}): string | undefined;
export declare function deriveAssistantCompletionSignature(args: {
  hasStopStreaming: boolean;
  hasTargetCopyResponse: boolean;
  responseText: string;
  artifactLabels?: string[];
}): string | undefined;
