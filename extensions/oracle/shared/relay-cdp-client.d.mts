export interface RelayFrameSession {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
}

export declare class RelayCdpClient {
  static connect(endpoint: string): Promise<RelayCdpClient>;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  armFrameCapture(targetId: string): Promise<string>;
  frameSessions(): RelayFrameSession[];
  evaluate(sessionId: string, expression: string): Promise<unknown>;
  close(): void;
}
