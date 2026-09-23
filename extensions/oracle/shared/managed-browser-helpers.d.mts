export interface SharedBrowserConfigLike {
  browser?: {
    chatGptRelayEndpoint?: string;
    chatGptManagedProfileDir?: string;
  };
}

/** Where a job's pinned tab lives on the managed browser; written by the worker once it attaches. */
export interface ManagedBrowserRecord {
  endpoint: string;
  /** `/json/version` webSocketDebuggerUrl: the browser instance, unique per Chrome launch. */
  browserUrl: string;
}

export interface SharedBrowserJobLike {
  config?: SharedBrowserConfigLike;
  relayTargetId?: string;
  managedBrowser?: ManagedBrowserRecord;
}

export type ManagedBrowserState =
  | { state: "running"; endpoint: string; browserUrl: string }
  | { state: "held"; pid: number }
  | { state: "stopped" };

export interface ManagedBrowserAttachment extends ManagedBrowserRecord {
  leaseKey: string;
  /** True when this attach started Chrome under a keeper; false when it reused a running Chrome. */
  launched: boolean;
}

export interface ManagedBrowserLaunchSpec {
  profileDir: string;
  executablePath: string;
  args: string[];
  idleMs: number;
  launchTimeoutMs: number;
}

export interface ManagedBrowserUserLease {
  leaseKey: string;
  profileDir: string;
  owner: string;
  processPid: number;
  createdAt: string;
}

export declare const MANAGED_BROWSER_LOCK_KIND: "managed-browser";
export declare const MANAGED_BROWSER_USER_KIND: "managed-browser-user";
export declare function managedBrowserIdleMs(env?: Record<string, string | undefined>): number;
export declare function usesSharedBrowser(config: SharedBrowserConfigLike | undefined): boolean;
export declare function sharedBrowserEndpoint(job: SharedBrowserJobLike | undefined, config?: SharedBrowserConfigLike): string | undefined;
export declare function sharedBrowserCleanupFields(
  job: SharedBrowserJobLike | undefined,
  config?: SharedBrowserConfigLike,
): { sharedBrowser: boolean; relayEndpoint?: string; relayTargetId?: string; managedBrowserUrl?: string };
export declare function managedChromeArgs(profileDir: string, extraArgs?: string[]): string[];
export declare function inspectManagedBrowser(profileDir: string): Promise<ManagedBrowserState>;
export declare function managedBrowserInUseMessage(profileDir: string, pid: number): string;
export declare function assertManagedBrowserAvailable(stateDir: string, profileDir: string): Promise<void>;
export declare function managedProfileHolderPid(profileDir: string): number | undefined;
export declare function canonicalManagedProfileDir(profileDir: string): string;
export declare function managedBrowserReplaced(record: ManagedBrowserRecord): Promise<boolean>;
export declare function acquireManagedBrowser(options: {
  stateDir: string;
  profileDir: string;
  executablePath: string;
  args?: string[];
  owner: string;
  launchTimeoutMs?: number;
}): Promise<ManagedBrowserAttachment>;
export declare function releaseManagedBrowser(stateDir: string, leaseKey: string | undefined): Promise<void>;
export declare function managedBrowserInUse(stateDir: string, profileDir: string, endpoint: string): Promise<boolean>;
