import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { createCompactHooks } from "./compact.js";
export declare const server: Plugin;
declare const _default: {
    id: string;
    server: Plugin;
};
export default _default;
export { createCompactHooks, loadConfig };
export { CheckpointStore, currentSchemaVersion, type Checkpoint } from "./state.js";
export type { OpenAICompactConfig } from "./schema.js";
