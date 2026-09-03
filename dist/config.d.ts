import { type OpenAICompactConfig } from "./schema.js";
import { getConfigSources, type ConfigContext } from "./paths.js";
export declare function loadConfig(context: ConfigContext): Promise<OpenAICompactConfig>;
export { getConfigSources };
