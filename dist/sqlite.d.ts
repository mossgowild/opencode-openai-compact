export type SQLiteSource = "bun:sqlite" | "node:sqlite" | "better-sqlite3";
export type SQLiteStatement<T = Record<string, unknown>> = {
    get(...params: unknown[]): T | null | undefined;
    all(...params: unknown[]): T[];
    run(...params: unknown[]): unknown;
};
export type SQLiteDatabase = {
    exec(sql: string): unknown;
    query<T = Record<string, unknown>>(sql: string): SQLiteStatement<T>;
    close(): void;
};
type RawStatement = {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
};
type RawDatabase = {
    exec(sql: string): unknown;
    query?(sql: string): RawStatement;
    prepare?(sql: string): RawStatement;
    close(): void;
};
type RawDatabaseCtor = new (filename?: string, options?: unknown) => RawDatabase;
type RequireLike = (id: string) => unknown;
type ResolveOptions = {
    isBun?: boolean;
    require?: RequireLike;
};
export type SQLiteBinding = {
    source: SQLiteSource;
    Database: RawDatabaseCtor;
};
export declare function resolveSQLiteBinding(options?: ResolveOptions): SQLiteBinding;
export declare function openSQLiteDatabase(filename: string, options?: ResolveOptions): SQLiteDatabase;
export {};
