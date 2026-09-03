export type ConfigContext = {
    directory: string;
    worktree: string;
};
export type ConfigSource = {
    path: string;
    optional: boolean;
};
export declare function getGlobalConfigDir(): string;
export declare function getDefaultConfigPath(): string;
export declare function getDatabasePath(): string;
export declare function getGlobalConfigSources(): ConfigSource[];
export declare function getConfigSources(context: ConfigContext): ConfigSource[];
