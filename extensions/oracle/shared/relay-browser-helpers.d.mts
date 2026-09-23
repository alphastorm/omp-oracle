export declare function assertRelayReady(endpoint: string): Promise<void>;
export declare function readCdpBrowserUrl(endpoint: string): Promise<string | undefined>;
export interface RelayTabCleanupOptions {
  binary: string;
  sessionName: string;
  endpoint: string;
  targetId: string;
  /** Identity of the managed browser that held the tab; a different or absent browser means the tab is gone. */
  browserUrl?: string;
}
export declare function closeRelayTab(options: RelayTabCleanupOptions): Promise<void>;
