export type OracleCollectionStatus = "complete" | "partial" | "failed";
export type OracleCaptureFidelity = "native_markdown" | "exact_code" | "derived_markdown" | "text_only";
export type OracleArtifactInspectionState = "inspected" | "not_performed" | "failed";
export type OracleArtifactState = "discovered" | "downloaded" | "validated" | "failed";

export interface OracleCollectionBinding {
  conversationId?: string;
  responseIndex?: number;
  messageId?: string;
  turnSha256?: string;
  frameId?: string;
  report?: boolean;
}

export interface OracleCapturedSource {
  id: string;
  kind: "citation" | "artifact";
  label: string;
  url?: string;
  unresolved?: boolean;
}

export interface OracleCapturedBlock {
  index: number;
  language: string;
  text: string;
}

export interface OracleArtifactCandidate {
  candidateId: string;
  label: string;
  selector: string;
  fileName?: string;
  nativeMarkdown: boolean;
}

export interface OracleScopedCapture {
  messageId?: string;
  title?: string;
  rawText: string;
  rawHtml: string;
  markdown: string;
  codeBlocks: OracleCapturedBlock[];
  sources: OracleCapturedSource[];
  candidates: OracleArtifactCandidate[];
  frames: Array<{ selector: string; src: string }>;
}

export interface OracleDownloadedBytes {
  bytesBase64: string;
  contentType: string;
  fileName: string;
  expectedSize?: number;
}

export interface OracleNativeDownloadEvidence {
  guid: string;
  frameId: string;
  source: "blob" | "data";
  totalBytes: number;
  activation: unknown;
}

export interface OracleNativeDownload extends OracleDownloadedBytes {
  native: OracleNativeDownloadEvidence;
}

export interface OracleNativeDownloadCdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<any>;
  on(method: string, listener: (event: { method: string; sessionId?: string; params: Record<string, any> }) => void): () => void;
  evaluate(sessionId: string, expression: string): Promise<unknown>;
}

export interface OracleArtifactOutcome {
  candidateId?: string;
  displayName?: string;
  state?: OracleArtifactState;
  required?: boolean;
}

export interface OracleCollectionOutcome {
  collectionStatus: OracleCollectionStatus;
  collectionRequiredMissing: string[];
  collectionOptionalMissing: string[];
}

export declare function captureScopedResponse(options?: Pick<OracleCollectionBinding, "responseIndex" | "messageId" | "report">): OracleScopedCapture;
export declare function captureExpression(options?: Pick<OracleCollectionBinding, "responseIndex" | "messageId" | "report">, frameDocument?: boolean): string;
export declare function captureDownload(selector: string): Promise<OracleDownloadedBytes>;
export declare function activateDownloadControl(selector: string, report?: boolean): Promise<{ activated: true; menuOption?: string }>;
export declare function armDownloadRegistry(): number;
export declare function disarmDownloadRegistry(): void;
export declare function readRegisteredDownload(url: string): Promise<string>;
export declare function decodeDataUrl(url: string): Buffer;
export declare function collectNativeDownload(input: {
  cdp: OracleNativeDownloadCdp;
  pageSessionId: string;
  frameSessionId?: string;
  activate: () => Promise<unknown>;
  timeoutMs?: number;
  onWait?: () => void;
}): Promise<OracleNativeDownload>;
export declare function redactTransportSecrets(text: unknown): string;
export declare function turnContentSha256(rawText: unknown): string;
export declare function validateArtifactBytes(bytes: Buffer, options?: { fileName?: string; contentType?: string; expectedSize?: number }): { size: number; sha256: string; detectedType: string };
export declare function collectionOutcome(input: {
  hasResponse: boolean;
  fidelity: OracleCaptureFidelity;
  inspection: OracleArtifactInspectionState;
  artifacts?: OracleArtifactOutcome[];
  requiredMissing?: string[];
  optionalMissing?: string[];
}): OracleCollectionOutcome;
