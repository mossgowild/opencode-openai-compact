import { createRequire } from "node:module";
let cachedBinding;
function isBunRuntime() {
    return typeof globalThis.Bun !== "undefined";
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function resolveSQLiteBinding(options = {}) {
    const useCache = options.isBun === undefined && options.require === undefined;
    if (useCache && cachedBinding)
        return cachedBinding;
    const req = options.require ?? createRequire(import.meta.url);
    const failures = [];
    if (options.isBun ?? isBunRuntime()) {
        try {
            const sqlite = req("bun:sqlite");
            const binding = { source: "bun:sqlite", Database: sqlite.Database };
            if (useCache)
                cachedBinding = binding;
            return binding;
        }
        catch (error) {
            failures.push(`bun:sqlite: ${errorMessage(error)}`);
        }
    }
    try {
        const sqlite = req("node:sqlite");
        const binding = { source: "node:sqlite", Database: sqlite.DatabaseSync };
        if (useCache)
            cachedBinding = binding;
        return binding;
    }
    catch (error) {
        failures.push(`node:sqlite: ${errorMessage(error)}`);
    }
    try {
        const Database = req("better-sqlite3");
        const binding = { source: "better-sqlite3", Database };
        if (useCache)
            cachedBinding = binding;
        return binding;
    }
    catch (error) {
        failures.push(`better-sqlite3: ${errorMessage(error)}`);
    }
    throw new Error("opencode-openai-compact: no SQLite binding available. Install better-sqlite3, " +
        "or run on Node with node:sqlite support, or use Bun. " +
        `Attempts: ${failures.join("; ")}`);
}
export function openSQLiteDatabase(filename, options = {}) {
    const binding = resolveSQLiteBinding(options);
    return adaptSQLiteDatabase(new binding.Database(filename));
}
function adaptSQLiteDatabase(db) {
    return {
        exec(sql) {
            return db.exec(sql);
        },
        query(sql) {
            const statement = db.query ? db.query(sql) : db.prepare?.(sql);
            if (!statement)
                throw new Error("SQLite binding does not expose query() or prepare()");
            return {
                get(...params) {
                    return statement.get(...params);
                },
                all(...params) {
                    return statement.all(...params);
                },
                run(...params) {
                    return statement.run(...params);
                },
            };
        },
        close() {
            db.close();
        },
    };
}
