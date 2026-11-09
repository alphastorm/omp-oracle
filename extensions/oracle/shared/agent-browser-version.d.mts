export declare const AGENT_BROWSER_MIN_VERSION: "0.41.2";
export declare function parseAgentBrowserVersion(output: string): [number, number, number] | undefined;
export declare function isAgentBrowserVersionSupported(version: [number, number, number]): boolean;
export declare function assertAgentBrowserVersionSupported(binary: string, options?: { timeoutMs?: number }): Promise<string>;
