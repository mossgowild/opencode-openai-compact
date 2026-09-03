import type { Hooks } from "@opencode-ai/plugin";
export type OAuthFetchLike = typeof fetch;
export type OpenAIAuthMethods = NonNullable<Hooks["auth"]>["methods"];
export type OpenAIOAuthAuth = {
    type: "oauth";
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
};
export type OpenAIOAuthOptions = {
    getAuth: () => Promise<OpenAIOAuthAuth | undefined>;
    setAuth?: (auth: OpenAIOAuthAuth) => Promise<void>;
    tokenFetch?: OAuthFetchLike;
};
export declare const openAIOAuthDummyKey = "opencode-oauth-dummy-key";
export declare const openAIAuthMethods: OpenAIAuthMethods;
export declare function usesOpenAIOAuth(providerID: string, headers: Headers): boolean;
export declare function asOpenAIOAuth(value: unknown): OpenAIOAuthAuth | undefined;
export declare function createOpenAIOAuth(options: OpenAIOAuthOptions): {
    requestInit(requestInit: RequestInit): Promise<RequestInit>;
};
