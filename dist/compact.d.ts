import type { Hooks } from "@opencode-ai/plugin";
import { type OpenAICompactConfig } from "./schema.js";
import { type OpenAIOAuthAuth, type OAuthFetchLike } from "./oauth.js";
import { CheckpointStore, type AnyRecord } from "./state.js";
export { compactedItemsFrom } from "./state.js";
type FetchLike = typeof fetch;
type CompactHookOptions = {
    setOpenAIAuth?: (auth: OpenAIOAuthAuth) => Promise<void>;
    tokenFetch?: OAuthFetchLike;
    getSessionMessages?: (sessionID: string) => Promise<unknown>;
};
export declare function isResponsesUrl(url: URL, config: OpenAICompactConfig): boolean;
export declare function compactBody(body: AnyRecord, compactModel?: string | null, config?: OpenAICompactConfig, reasoningEffort?: "high" | "low" | "max" | "medium" | "minimal" | "none" | "xhigh" | null): AnyRecord;
export declare function createCompactHooks(config: OpenAICompactConfig, store: CheckpointStore, baseFetch?: FetchLike, options?: CompactHookOptions): Hooks;
