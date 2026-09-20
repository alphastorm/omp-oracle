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

export declare class RelayCdpClient {
  static connect(endpoint: string): Promise<RelayCdpClient>;
  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown>;
  on(method: string, listener: (event: RelayCdpEvent) => void): () => void;
  armFrameCapture(targetId: string): Promise<string>;
  frameSessions(): RelayFrameSession[];
  evaluate(sessionId: string, expression: string): Promise<unknown>;
  close(): void;
}
