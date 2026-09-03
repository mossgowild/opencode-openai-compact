import fs from "node:fs/promises";
import path from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";
import { mergeDeep } from "./merge.js";
import { defaultConfig, OpenAICompactConfigSchema } from "./schema.js";
import { getConfigSources, getDefaultConfigPath, getGlobalConfigSources, } from "./paths.js";
const configSchemaUrl = "https://raw.githubusercontent.com/partment/opencode-openai-compact/main/configSchema.json";
async function readOptionalJsonc(source) {
    let text;
    try {
        text = await fs.readFile(source.path, "utf8");
    }
    catch (error) {
        if (source.optional && error.code === "ENOENT")
            return undefined;
        throw error;
    }
    const errors = [];
    const parsed = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        const first = errors[0];
        throw new Error(`Invalid JSONC in ${source.path}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
    }
    return parsed ?? {};
}
async function fileExists(file) {
    try {
        await fs.stat(file);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
async function ensureGlobalConfigFile() {
    for (const source of getGlobalConfigSources()) {
        if (await fileExists(source.path))
            return;
    }
    const file = getDefaultConfigPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs
        .writeFile(file, `{
  "$schema": "${configSchemaUrl}"
}
`, { flag: "wx" })
        .catch((error) => {
        if (error.code !== "EEXIST")
            throw error;
    });
}
export async function loadConfig(context) {
    await ensureGlobalConfigFile();
    let merged = defaultConfig;
    for (const source of getConfigSources(context)) {
        const data = await readOptionalJsonc(source);
        if (data === undefined)
            continue;
        merged = mergeDeep(merged, data);
    }
    return OpenAICompactConfigSchema.parse(merged);
}
export { getConfigSources };
