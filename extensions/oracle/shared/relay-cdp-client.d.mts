export interface RelayFrameSession {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
}

export interface RelayCdpEvent {
  method: string;
  sessionId?: string;
  params: Record<string, any>;
}

export interface RelayCdpRemoteObject {
  type: string;
  value?: unknown;
  description?: string;
}

export interface RelayCdpExceptionDetails {
  text: string;
  exception?: RelayCdpRemoteObject;
}

/**
 * Result shapes for the CDP methods this codebase sends. Chrome's protocol is the source of truth;
 * only the fields consumers read are declared. Methods not listed here resolve to `unknown`.
 */
export interface RelayCdpResults {
  "Target.attachToTarget": { sessionId: string };
  "Target.setAutoAttach": Record<string, never>;
  "DOM.getDocument": { root: { nodeId: number } };
  "DOM.querySelector": { nodeId: number };
  "DOM.describeNode": { node: { nodeId: number; frameId?: string } };
  "Runtime.evaluate": { result: RelayCdpRemoteObject; exceptionDetails?: RelayCdpExceptionDetails };
}

export declare class RelayCdpClient {
  static connect(endpoint: string): Promise<RelayCdpClient>;
  send<M extends keyof RelayCdpResults>(method: M, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<RelayCdpResults[M]>;
  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown>;
  on(method: string, listener: (event: RelayCdpEvent) => void): () => void;
  armFrameCapture(targetId: string): Promise<string>;
  frameSessions(): RelayFrameSession[];
  evaluate(sessionId: string, expression: string): Promise<unknown>;
  close(): void;
}
