export declare const DEFAULT_ORACLE_JOBS_DIR = "/tmp";
export declare const ORACLE_JOBS_DIR_ENV = "PI_ORACLE_JOBS_DIR";
export declare const DEFAULT_ORACLE_STATE_DIR = "/tmp/pi-oracle-state";
export declare const ORACLE_STATE_DIR_ENV = "PI_ORACLE_STATE_DIR";
export declare function getOracleJobsDir(env?: Record<string, string | undefined>): string;
export declare function getOracleStateDir(env?: Record<string, string | undefined>): string;
