export declare function assertRelayReady(endpoint: string): Promise<void>;
export interface RelayTabCleanupOptions {
  binary: string;
  sessionName: string;
  endpoint: string;
  targetId: string;
}
export declare function closeRelayTab(options: RelayTabCleanupOptions): Promise<void>;
