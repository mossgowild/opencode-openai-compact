import { loadConfig } from "./config.js";
import { createCompactHooks } from "./compact.js";
import { getDatabasePath } from "./paths.js";
import { CheckpointStore } from "./state.js";
export const server = async ({ client, directory, worktree }) => {
    const config = await loadConfig({ directory, worktree });
    if (!config.enabled)
        return {};
    const store = await CheckpointStore.open(getDatabasePath());
    store.prune(config.state.retentionDays);
    return createCompactHooks(config, store, fetch, {
        async getSessionMessages(sessionID) {
            const result = await client.session.messages({ path: { id: sessionID } });
            return result.data;
        },
        async setOpenAIAuth(auth) {
            await client.auth.set({ path: { id: "openai" }, body: auth });
        },
    });
};
export default {
    id: "opencode-openai-compact",
    server,
};
export { createCompactHooks, loadConfig };
export { CheckpointStore, currentSchemaVersion } from "./state.js";
