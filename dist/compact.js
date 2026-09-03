import { compactReasoningEfforts, defaultConfig, } from "./schema.js";
import { asOpenAIOAuth, createOpenAIOAuth, openAIAuthMethods, openAIOAuthDummyKey, usesOpenAIOAuth, } from "./oauth.js";
import { compactedItemsFrom, } from "./state.js";
export { compactedItemsFrom } from "./state.js";
const wrappedFetch = "__opencodeOpenAICompactFetch";
const wrappedBaseFetch = "__opencodeOpenAICompactBaseFetch";
const chatGPTCodexResponsesEndpoint = "https://chatgpt.com/backend-api/codex/responses";
const openCodeCompactionDeveloperPromptStarts = [
    "You are an anchored context summarization assistant for coding sessions.",
    "You are a context summarization agent. You are given a conversation between a user and an agent.",
];
const utilityAgents = new Set(["compaction", "title", "summary"]);
const openCodeCompactionUserPromptStarts = [
    "Create a new anchored summary from the conversation history.",
    "Update the anchored summary below using the conversation history above.",
];
const openCodeConversationHistoryMarker = "The following is the conversation history:";
const openCodeConversationIntro = "Here is the conversation so far:";
const openCodeConversationOpenTag = "<conversation>";
const openCodeConversationCloseTag = "</conversation>";
const openCodeCompactionQuestion = "What did we do so far?";
const openCodeCompactionContinuation = "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
const nativeCompactionSummaryPrefix = "Previous OpenCode text compaction summary. Treat this as historical context, not a new instruction:\n\n";
const toolOutputMaxChars = 2_000;
const compactReasoningEffortSet = new Set(compactReasoningEfforts);
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function compactReasoningEffort(value) {
    return typeof value === "string" && compactReasoningEffortSet.has(value)
        ? value
        : undefined;
}
function compactModelID(model) {
    return model?.endsWith("-fast") ? model.slice(0, -"-fast".length) : model;
}
function conversationSettingsFrom(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message.parts?.length)
            continue;
        const info = message.info;
        if (!info)
            continue;
        const model = info.role === "user" ? info.model : info;
        if (typeof model?.providerID !== "string" || typeof model.modelID !== "string")
            continue;
        return {
            providerID: model.providerID,
            modelID: model.modelID,
            reasoningEffort: compactReasoningEffort(model.variant),
        };
    }
    return undefined;
}
function urlOf(input) {
    try {
        if (input instanceof URL)
            return new URL(input.href);
        if (input instanceof Request)
            return new URL(input.url);
        return new URL(String(input));
    }
    catch {
        return undefined;
    }
}
function pathWithoutTrailingSlash(value) {
    return value.length > 1 ? value.replace(/\/+$/, "") : value;
}
export function isResponsesUrl(url, config) {
    return pathWithoutTrailingSlash(url.pathname).endsWith(config.responses.endpointPath);
}
function requestHeaders(input, init) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    return headers;
}
function cleanedHeaders(headers, config) {
    const result = new Headers(headers);
    result.delete(config.headers.compact);
    result.delete(config.headers.session);
    return result;
}
function fetchInit(init, headers) {
    return init ? { ...init, headers } : { headers };
}
function fetchInitForReroute(input, init, headers) {
    if (!(input instanceof Request))
        return fetchInit(init, headers);
    const requestInit = {
        method: input.method,
        body: input.body,
        cache: input.cache,
        credentials: input.credentials,
        integrity: input.integrity,
        keepalive: input.keepalive,
        mode: input.mode,
        redirect: input.redirect,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        signal: input.signal,
        ...init,
        headers,
    };
    const duplex = input.duplex;
    if (duplex && requestInit.body !== undefined && requestInit.body !== null)
        requestInit.duplex = duplex;
    return requestInit;
}
function compactMarkers(headers, config) {
    const sessionID = headers.get(config.headers.session) ?? undefined;
    const compact = headers.get(config.headers.compact);
    const shouldCompact = compact === "1";
    const shouldNativeCompact = compact === "native";
    headers.delete(config.headers.compact);
    headers.delete(config.headers.session);
    return { sessionID, shouldCompact, shouldNativeCompact };
}
async function bodyText(input, init) {
    if (typeof init?.body === "string")
        return init.body;
    if (init?.body instanceof Uint8Array)
        return new TextDecoder().decode(init.body);
    if (input instanceof Request)
        return input.clone().text();
    return undefined;
}
function contentText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return "";
    return value
        .map((item) => {
        if (typeof item === "string")
            return item;
        const record = asRecord(item);
        return typeof record?.text === "string" ? record.text : "";
    })
        .filter(Boolean)
        .join("\n");
}
function messageText(entry) {
    return (entry.parts ?? [])
        .filter((part) => part.type === "text" && !part.ignored && typeof part.text === "string")
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n");
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    const record = asRecord(value);
    if (!record)
        return value;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}
function forkMessageFingerprint(entry) {
    const info = { ...(asRecord(entry.info) ?? {}) };
    delete info.id;
    delete info.sessionID;
    delete info.parentID;
    const parts = (entry.parts ?? []).map((part) => {
        const result = { ...(asRecord(part) ?? {}) };
        delete result.id;
        delete result.messageID;
        delete result.sessionID;
        delete result.tail_start_id;
        return result;
    });
    return JSON.stringify(canonicalValue({ info, parts }));
}
function isOpenCodeCompactionDeveloperPrompt(value) {
    const text = contentText(value).trimStart();
    return openCodeCompactionDeveloperPromptStarts.some((start) => text.startsWith(start));
}
function isTaggedOpenCodeConversation(value) {
    const text = contentText(value).trimStart();
    if (!text.startsWith(openCodeConversationIntro))
        return false;
    const open = text.indexOf(openCodeConversationOpenTag, openCodeConversationIntro.length);
    if (open === -1)
        return false;
    return text.indexOf(openCodeConversationCloseTag, open + openCodeConversationOpenTag.length) !== -1;
}
function isOpenCodeCompactionUserPrompt(value) {
    const text = contentText(value).trimStart();
    return openCodeCompactionUserPromptStarts.some((start) => text.startsWith(start)) || isTaggedOpenCodeConversation(value);
}
function hasEmbeddedOpenCodeConversation(value) {
    if (isTaggedOpenCodeConversation(value))
        return true;
    return isOpenCodeCompactionUserPrompt(value) && contentText(value).includes(openCodeConversationHistoryMarker);
}
function hasInvalidCheckpointHistory(checkpoint) {
    return checkpoint.items.some((item) => item.role === "user" && hasEmbeddedOpenCodeConversation(item.content));
}
function compactInput(value) {
    if (!Array.isArray(value))
        return value;
    return value.filter((item, index) => {
        const record = asRecord(item);
        if (!record)
            return true;
        if (record.role === "developer" && isOpenCodeCompactionDeveloperPrompt(record.content))
            return false;
        if (index === value.length - 1 &&
            record.role === "user" &&
            isOpenCodeCompactionUserPrompt(record.content) &&
            !hasEmbeddedOpenCodeConversation(record.content)) {
            return false;
        }
        return true;
    });
}
function isKnownOpenCodeCompactionBody(body) {
    if (isOpenCodeCompactionDeveloperPrompt(body.instructions))
        return true;
    if (!Array.isArray(body.input))
        return false;
    const last = asRecord(body.input.at(-1));
    return last?.role === "user" && isOpenCodeCompactionUserPrompt(last.content);
}
function truncateToolOutput(value) {
    if (value.length <= toolOutputMaxChars)
        return value;
    const omitted = value.length - toolOutputMaxChars;
    return `${value.slice(0, toolOutputMaxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`;
}
function structuredOpenAIInput(messages, providerID, sourceModel) {
    const input = [];
    for (const message of messages) {
        const info = message.info;
        const parts = message.parts ?? [];
        if (!info?.role)
            return undefined;
        if (!parts.length)
            continue;
        if (info.role === "user") {
            const content = [];
            for (const part of parts) {
                if (part.type === "text" && !part.ignored && part.text) {
                    content.push({ type: "input_text", text: part.text });
                    continue;
                }
                if (part.type === "file") {
                    if (typeof part.mime !== "string")
                        return undefined;
                    if (part.mime === "text/plain" || part.mime === "application/x-directory")
                        continue;
                    if (part.mime.startsWith("image/") || part.mime === "application/pdf") {
                        content.push({ type: "input_text", text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` });
                        continue;
                    }
                    if (typeof part.url !== "string")
                        return undefined;
                    content.push(part.url.startsWith("data:")
                        ? { type: "input_file", filename: part.filename ?? "file", file_data: part.url }
                        : { type: "input_file", file_url: part.url });
                    continue;
                }
                if (part.type === "compaction") {
                    content.push({ type: "input_text", text: openCodeCompactionQuestion });
                    continue;
                }
                if (part.type === "subtask") {
                    content.push({ type: "input_text", text: "The following tool was executed by the user" });
                }
            }
            if (content.length)
                input.push({ role: "user", content });
            continue;
        }
        if (info.role !== "assistant")
            return undefined;
        const differentModel = `${providerID}/${sourceModel}` !== `${info.providerID}/${info.modelID}`;
        const assistantItems = [];
        const toolOutputs = [];
        const reasoningByID = new Map();
        const hasSignedReasoning = parts.some((part) => part.type === "reasoning" && asRecord(asRecord(part.metadata)?.anthropic)?.signature != null);
        for (const part of parts) {
            if (part.type === "text") {
                const text = part.text === "" && hasSignedReasoning ? " " : part.text;
                if (typeof text !== "string")
                    return undefined;
                const metadata = differentModel ? undefined : asRecord(asRecord(part.metadata)?.openai);
                const item = {
                    role: "assistant",
                    content: [{ type: "output_text", text }],
                };
                if (typeof metadata?.itemId === "string")
                    item.id = metadata.itemId;
                if (metadata?.phase === "commentary" || metadata?.phase === "final_answer")
                    item.phase = metadata.phase;
                assistantItems.push(item);
                continue;
            }
            if (part.type === "reasoning") {
                if (typeof part.text !== "string")
                    return undefined;
                if (differentModel) {
                    if (part.text.trim()) {
                        assistantItems.push({ role: "assistant", content: [{ type: "output_text", text: part.text }] });
                    }
                    continue;
                }
                const metadata = asRecord(asRecord(part.metadata)?.openai);
                const encryptedContent = metadata?.reasoningEncryptedContent;
                if (typeof encryptedContent !== "string")
                    continue;
                const summary = part.text ? [{ type: "summary_text", text: part.text }] : [];
                const itemID = metadata?.itemId;
                if (typeof itemID !== "string") {
                    assistantItems.push({ type: "reasoning", encrypted_content: encryptedContent, summary });
                    continue;
                }
                const existing = reasoningByID.get(itemID);
                if (existing) {
                    const existingSummary = existing.summary;
                    existingSummary.push(...summary);
                    existing.encrypted_content = encryptedContent;
                    continue;
                }
                const item = {
                    type: "reasoning",
                    id: itemID,
                    encrypted_content: encryptedContent,
                    summary,
                };
                reasoningByID.set(itemID, item);
                assistantItems.push(item);
                continue;
            }
            if (part.type !== "tool")
                continue;
            if (part.metadata?.providerExecuted === true)
                return undefined;
            if (typeof part.tool !== "string" || typeof part.callID !== "string")
                return undefined;
            const state = asRecord(part.state);
            if (!state || typeof state.status !== "string")
                return undefined;
            let argumentsText;
            try {
                argumentsText = JSON.stringify(state.input === undefined ? {} : state.input);
            }
            catch {
                return undefined;
            }
            assistantItems.push({
                type: "function_call",
                call_id: part.callID,
                name: part.tool,
                arguments: argumentsText,
            });
            let output;
            if (state.status === "completed") {
                const time = asRecord(state.time);
                if (time?.compacted)
                    output = "[Old tool result content cleared]";
                else if (typeof state.output === "string")
                    output = truncateToolOutput(state.output);
                else
                    return undefined;
            }
            else if (state.status === "error") {
                const metadata = asRecord(state.metadata);
                if (metadata?.interrupted === true && typeof metadata.output === "string")
                    output = metadata.output;
                else if (typeof state.error === "string")
                    output = state.error;
                else
                    return undefined;
            }
            else if (state.status === "pending" || state.status === "running") {
                output = "[Tool execution was interrupted]";
            }
            else {
                return undefined;
            }
            toolOutputs.push({ type: "function_call_output", call_id: part.callID, output });
        }
        input.push(...assistantItems, ...toolOutputs);
    }
    return input.length ? input : undefined;
}
function cloneMessages(messages) {
    try {
        return structuredClone(messages);
    }
    catch {
        return undefined;
    }
}
function messageHasText(value, role, text) {
    const message = asRecord(value);
    return message?.role === role && contentText(message.content) === text;
}
function postCompactionInput(input, summary) {
    const start = input.findIndex((item, index) => messageHasText(item, "user", openCodeCompactionQuestion) &&
        messageHasText(input[index + 1], "assistant", summary));
    if (start === -1)
        return input;
    const result = [...input.slice(0, leadingInstructionCount(input)), ...input.slice(start + 2)];
    if (messageHasText(result.at(-1), "user", openCodeCompactionContinuation))
        result.pop();
    return result;
}
function withoutLatestUserInput(input) {
    for (let index = input.length - 1; index >= 0; index--) {
        if (asRecord(input[index])?.role === "user") {
            return [...input.slice(0, index), ...input.slice(index + 1)];
        }
    }
    return input;
}
function compactBodyValue(key, value) {
    if (key === "input") {
        const input = compactInput(value);
        if (!Array.isArray(input))
            return input;
        return [
            ...input.filter((item) => asRecord(item)?.type !== "compaction_trigger"),
            { type: "compaction_trigger" },
        ];
    }
    if (key === "instructions" && (value === "" || isOpenCodeCompactionDeveloperPrompt(value)))
        return undefined;
    return value;
}
function leadingInstructionCount(input) {
    let index = 0;
    while (true) {
        const role = asRecord(input[index])?.role;
        if (role !== "developer" && role !== "system")
            return index;
        index++;
    }
}
function latestInstructionPrefix(input) {
    let start = 0;
    for (let index = input.length - 1; index >= 0; index--) {
        const type = asRecord(input[index])?.type;
        if (type === "compaction" || type === "compaction_summary") {
            start = index + 1;
            break;
        }
    }
    let end = start;
    while (true) {
        const role = asRecord(input[end])?.role;
        if (role !== "developer" && role !== "system")
            return input.slice(start, end);
        end++;
    }
}
function stableInstructionsFrom(body) {
    if (!body)
        return undefined;
    const inputPrefix = Array.isArray(body.input) ? latestInstructionPrefix(body.input) : [];
    const instructions = isOpenCodeCompactionDeveloperPrompt(body.instructions) ? undefined : body.instructions;
    if (instructions === undefined && !inputPrefix.length)
        return undefined;
    return { instructions, inputPrefix: structuredClone(inputPrefix) };
}
function instructionsFromSystem(system) {
    if (!Array.isArray(system))
        return undefined;
    if (!system.every((item) => typeof item === "string"))
        return undefined;
    const instructions = system.join("\n");
    if (!instructions || isOpenCodeCompactionDeveloperPrompt(instructions))
        return undefined;
    return instructions;
}
function withStableInstructions(body, stable, allowInstructions) {
    if (!stable)
        return body;
    const next = { ...body };
    if (allowInstructions && next.instructions === undefined && stable.instructions !== undefined) {
        next.instructions = structuredClone(stable.instructions);
    }
    if (stable.inputPrefix.length && Array.isArray(next.input)) {
        next.input = [...structuredClone(stable.inputPrefix), ...next.input.slice(leadingInstructionCount(next.input))];
    }
    return next;
}
export function compactBody(body, compactModel = defaultConfig.providers.openai.compactModel, config = defaultConfig, reasoningEffort = defaultConfig.providers.openai.compactReasoningEffort) {
    const model = compactModelID(compactModel ?? (typeof body.model === "string" ? body.model : undefined));
    const result = model ? { model } : {};
    for (const key of config.compactBodyKeys) {
        if (key === "model")
            continue;
        const value = compactBodyValue(key, body[key]);
        if (value !== undefined)
            result[key] = value;
    }
    if (!config.compactBodyKeys.includes("input")) {
        const input = compactBodyValue("input", body.input);
        if (input !== undefined)
            result.input = input;
    }
    const effort = reasoningEffort ?? compactReasoningEffort(asRecord(body.reasoning)?.effort);
    if (effort)
        result.reasoning = { ...(asRecord(result.reasoning) ?? {}), effort };
    result.tool_choice = "auto";
    result.store = false;
    result.stream = true;
    result.include = ["reasoning.encrypted_content"];
    return result;
}
function parseJsonRecord(text) {
    if (!text)
        return undefined;
    try {
        return asRecord(JSON.parse(text));
    }
    catch {
        return undefined;
    }
}
function usageFrom(value) {
    return {
        input_tokens: value?.input_tokens ?? 0,
        input_tokens_details: {
            cached_tokens: asRecord(value?.input_tokens_details)?.cached_tokens ?? 0,
        },
        output_tokens: value?.output_tokens ?? 0,
        output_tokens_details: {
            reasoning_tokens: asRecord(value?.output_tokens_details)?.reasoning_tokens ?? 0,
        },
        total_tokens: value?.total_tokens ?? Number(value?.input_tokens ?? 0) + Number(value?.output_tokens ?? 0),
    };
}
function responseMessageID(responseID) {
    return `msg_${responseID.replace(/[^a-zA-Z0-9]/g, "_")}`;
}
function compactedItemsForV2(input, compaction) {
    if (!Array.isArray(input))
        return undefined;
    const retained = input.filter((item) => asRecord(item)?.role === "user" || isNativeCompactionSummaryItem(item));
    return compactedItemsFrom([...retained, compaction]);
}
async function compactV2Payload(response) {
    const text = await response.text();
    const data = [];
    let lines = [];
    const flush = () => {
        if (lines.length)
            data.push(lines.join("\n"));
        lines = [];
    };
    for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
        if (!line) {
            flush();
            continue;
        }
        if (line.startsWith(":"))
            continue;
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        if (field !== "data")
            continue;
        const value = separator === -1 ? "" : line.slice(separator + 1);
        lines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    flush();
    let completed;
    let compaction;
    let compactionCount = 0;
    for (const value of data) {
        if (value === "[DONE]")
            continue;
        let event;
        try {
            event = asRecord(JSON.parse(value));
        }
        catch {
            return undefined;
        }
        if (!event ||
            event.type === "error" ||
            event.type === "response.failed" ||
            event.type === "response.incomplete") {
            return undefined;
        }
        if (event.type === "response.output_item.done") {
            const item = asRecord(event.item);
            if (item?.type === "compaction") {
                compactionCount++;
                compaction ??= item;
            }
        }
        if (event.type === "response.completed") {
            if (completed)
                return undefined;
            completed = asRecord(event.response);
        }
    }
    if (!completed ||
        (completed.status !== undefined && completed.status !== "completed") ||
        compactionCount !== 1 ||
        !compaction ||
        typeof compaction.encrypted_content !== "string") {
        return undefined;
    }
    return { ...completed, compaction };
}
function sseResponse(input) {
    const messageID = responseMessageID(input.responseID);
    const usage = usageFrom(input.usage);
    const message = {
        id: messageID,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
            {
                type: "output_text",
                text: input.summary,
                annotations: [],
                logprobs: [],
            },
        ],
    };
    const response = {
        id: input.responseID,
        object: "response",
        created_at: input.createdAt,
        model: input.model,
        status: "completed",
        output: [message],
        incomplete_details: null,
        service_tier: null,
        usage,
    };
    const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
        {
            type: "response.output_text.delta",
            item_id: messageID,
            output_index: 0,
            content_index: 0,
            delta: input.summary,
            logprobs: [],
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response },
    ];
    const stream = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(stream, {
        status: 200,
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
        },
    });
}
function messageCreatedAt(entry) {
    const createdAt = entry.info?.time?.created;
    return finiteNumber(createdAt) ? createdAt : undefined;
}
function isCompletedCompactionSummary(value) {
    const info = asRecord(value);
    const time = asRecord(info?.time);
    return (info?.role === "assistant" &&
        info.summary === true &&
        info.error == null &&
        typeof info.finish === "string" &&
        finiteNumber(time?.completed));
}
function isNativeCompactionSummaryItem(value) {
    const item = asRecord(value);
    return item?.role === "assistant" && contentText(item.content).startsWith(nativeCompactionSummaryPrefix);
}
function latestNativeCompactionSummary(messages, pluginSummary) {
    const compactionParents = new Set(messages
        .filter((message) => message.info?.role === "user" &&
        typeof message.info.id === "string" &&
        message.parts?.some((part) => part.type === "compaction"))
        .map((message) => message.info.id));
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const parentID = message.info?.parentID;
        if (!isCompletedCompactionSummary(message.info) || typeof parentID !== "string" || !compactionParents.has(parentID)) {
            continue;
        }
        const text = messageText(message);
        if (text && text !== pluginSummary)
            return text;
    }
    return undefined;
}
function hasCompletedCompactionAfterCheckpoint(checkpoint, messages) {
    const compactionParents = new Set(messages
        .filter((message) => {
        const info = message.info;
        const createdAt = messageCreatedAt(message);
        return (info?.role === "user" &&
            typeof info.id === "string" &&
            info.id !== checkpoint.afterMessageID &&
            createdAt !== undefined &&
            createdAt >= checkpoint.afterCreatedAt &&
            message.parts?.some((part) => part.type === "compaction"));
    })
        .map((message) => message.info.id));
    return messages.some((message) => isCompletedCompactionSummary(message.info) &&
        typeof message.info?.parentID === "string" &&
        compactionParents.has(message.info.parentID));
}
function isOpenCodeCompactionContinuation(entry) {
    return entry.parts?.some((part) => part.type === "text" && part.synthetic === true && part.metadata?.compaction_continue === true);
}
function selectCheckpoint(checkpoints, entries) {
    const messageIDs = new Set(entries
        .map((entry) => entry.info?.id)
        .filter((id) => typeof id === "string"));
    for (let index = checkpoints.length - 1; index >= 0; index--) {
        const checkpoint = checkpoints[index];
        if (messageIDs.has(checkpoint.afterMessageID))
            return { checkpoint, clearActive: false };
    }
    const createdAts = entries.map(messageCreatedAt).filter((createdAt) => createdAt !== undefined);
    if (!createdAts.length || createdAts.length !== entries.length) {
        return { clearActive: false };
    }
    const minCreatedAt = Math.min(...createdAts);
    for (let index = checkpoints.length - 1; index >= 0; index--) {
        const checkpoint = checkpoints[index];
        if (minCreatedAt >= checkpoint.afterCreatedAt)
            return { checkpoint, clearActive: false };
    }
    return { clearActive: true };
}
function sessionIDFromMessages(messages) {
    for (const message of messages) {
        const sessionID = message.info?.sessionID;
        if (typeof sessionID === "string")
            return sessionID;
    }
    return undefined;
}
function sortCheckpoints(checkpoints) {
    return checkpoints.sort((a, b) => a.afterCreatedAt - b.afterCreatedAt || a.createdAt - b.createdAt);
}
function getProviderSessionMap(map, providerID) {
    const existing = map.get(providerID);
    if (existing)
        return existing;
    const created = new Map();
    map.set(providerID, created);
    return created;
}
function getProviderID(input) {
    const record = asRecord(input);
    const model = asRecord(record?.model);
    if (typeof model?.providerID === "string")
        return model.providerID;
    const provider = asRecord(record?.provider);
    if (typeof provider?.providerID === "string")
        return provider.providerID;
    if (typeof provider?.id === "string")
        return provider.id;
    return undefined;
}
function messageProviderKey(sessionID, messageID) {
    return `${sessionID}\0${messageID}`;
}
export function createCompactHooks(config, store, baseFetch = fetch, options = {}) {
    store.prune(config.state.retentionDays);
    const configuredProviders = new Set(Object.keys(config.providers));
    const checkpointsByProvider = new Map();
    for (const { sessionID, checkpoint } of store.loadAll()) {
        const sessions = getProviderSessionMap(checkpointsByProvider, checkpoint.providerID);
        const checkpoints = sessions.get(sessionID) ?? [];
        checkpoints.push(checkpoint);
        sessions.set(sessionID, sortCheckpoints(checkpoints));
    }
    const controlMessagesByProvider = new Map();
    for (const control of store.loadControlMessages()) {
        const sessions = getProviderSessionMap(controlMessagesByProvider, control.providerID);
        const messages = sessions.get(control.sessionID) ?? new Map();
        messages.set(control.messageID, control);
        sessions.set(control.sessionID, messages);
    }
    const pendingCompactResults = new Map();
    const pendingCompactionBoundaries = new Map();
    const pendingAutoContinues = new Map();
    const pendingAutoContinueRequests = new Map();
    const activeCheckpointByProvider = new Map();
    const stableInstructionsByProvider = new Map();
    const pendingSystemByProvider = new Map();
    const providerByMessage = new Map();
    const pendingCompactionCaptures = new Map();
    const failedCompactionCaptures = new Set();
    const blockedCompactionRequests = new Set();
    const structuredCompactionSnapshots = new Map();
    const pendingNativeCompactions = new Map();
    let openAIAuth;
    let openAIWrappedFetch;
    const openAIOAuth = createOpenAIOAuth({
        getAuth: async () => openAIAuth,
        async setAuth(auth) {
            openAIAuth = auth;
            await options.setOpenAIAuth?.(auth);
        },
        tokenFetch: options.tokenFetch,
    });
    function rememberMessageProvider(input, output) {
        const providerID = getProviderID(input);
        if (!providerID || !configuredProviders.has(providerID))
            return;
        const inputRecord = asRecord(input);
        const sessionID = inputRecord?.sessionID;
        if (typeof sessionID !== "string")
            return;
        const outputRecord = asRecord(output);
        const message = asRecord(outputRecord?.message);
        const messageID = typeof message?.id === "string" ? message.id : inputRecord?.messageID;
        if (typeof messageID !== "string")
            return;
        providerByMessage.set(messageProviderKey(sessionID, messageID), providerID);
    }
    function providerIDFromMessages(messages) {
        for (const message of messages) {
            const sessionID = message.info?.sessionID;
            const messageID = message.info?.id;
            if (typeof sessionID !== "string" || typeof messageID !== "string")
                continue;
            const providerID = providerByMessage.get(messageProviderKey(sessionID, messageID));
            if (providerID)
                return providerID;
        }
        return undefined;
    }
    function providerIDFromTrimmedSessionCheckpoint(messages) {
        const sessionID = sessionIDFromMessages(messages);
        if (!sessionID)
            return undefined;
        const messageIDs = new Set(messages
            .map((message) => message.info?.id)
            .filter((id) => typeof id === "string"));
        let result;
        for (const [providerID, sessions] of checkpointsByProvider) {
            const checkpoints = sessions.get(sessionID);
            if (!checkpoints?.length)
                continue;
            if (checkpoints.some((checkpoint) => messageIDs.has(checkpoint.afterMessageID)))
                return undefined;
            if (result)
                return undefined;
            result = providerID;
        }
        return result;
    }
    function transformProviderID(input, messages) {
        return getProviderID(input) ?? providerIDFromMessages(messages) ?? providerIDFromTrimmedSessionCheckpoint(messages);
    }
    function controlsFor(providerID, sessionID) {
        return controlMessagesByProvider.get(providerID)?.get(sessionID);
    }
    function rememberControlIdentity(providerID, sessionID, messageID, createdAt, contentText) {
        const sessions = getProviderSessionMap(controlMessagesByProvider, providerID);
        const messages = sessions.get(sessionID) ?? new Map();
        const existing = messages.get(messageID);
        if (existing) {
            // Text can match genuine user input, so message IDs remain the only removal identity.
            if (existing.contentText || !contentText)
                return;
            const updated = { ...existing, contentText };
            messages.set(messageID, updated);
            store.upsertControlMessage(updated);
            return;
        }
        const control = {
            providerID,
            sessionID,
            messageID,
            createdAt,
            contentText,
        };
        messages.set(messageID, control);
        sessions.set(sessionID, messages);
        store.upsertControlMessage(control);
    }
    function rememberControlMessage(providerID, sessionID, message) {
        const messageID = message.info?.id;
        if (typeof messageID !== "string")
            return;
        rememberControlIdentity(providerID, sessionID, messageID, messageCreatedAt(message) ?? Date.now(), messageText(message));
    }
    function forgetControlMessage(sessionID, messageID) {
        for (const sessions of controlMessagesByProvider.values()) {
            const controls = sessions.get(sessionID);
            if (!controls?.delete(messageID))
                continue;
            if (!controls.size)
                sessions.delete(sessionID);
        }
        store.deleteControlMessage(sessionID, messageID);
    }
    function isPendingAutoContinueCandidate(message, pending) {
        const info = message.info;
        if (info?.role !== "user" || typeof info.id !== "string" || info.id === pending.compactionMessageID)
            return false;
        if (pending.agent && info.agent && pending.agent !== info.agent)
            return false;
        const createdAt = messageCreatedAt(message);
        if (createdAt !== undefined &&
            pending.compactionCreatedAt !== undefined &&
            createdAt < pending.compactionCreatedAt) {
            return false;
        }
        return message.parts?.some((part) => part.type === "text" && part.synthetic === true) === true;
    }
    function captureControlMessages(providerID, sessionID, messages) {
        for (const message of messages) {
            if (isOpenCodeCompactionContinuation(message))
                rememberControlMessage(providerID, sessionID, message);
        }
        const pending = pendingAutoContinues.get(sessionID);
        if (pending?.providerID !== providerID)
            return;
        const continuation = messages.find((message) => isPendingAutoContinueCandidate(message, pending));
        if (!continuation)
            return;
        rememberControlMessage(providerID, sessionID, continuation);
        pendingAutoContinues.delete(sessionID);
    }
    function removeControlMessages(providerID, sessionID, messages) {
        const controls = controlsFor(providerID, sessionID);
        if (!controls?.size)
            return;
        const filtered = messages.filter((message) => {
            const messageID = message.info?.id;
            return typeof messageID !== "string" || !controls.has(messageID);
        });
        if (filtered.length !== messages.length)
            messages.splice(0, messages.length, ...filtered);
    }
    // Transform history is compaction-filtered, so verify forks using raw source and child messages.
    async function inheritForkState(providerID, sessionID, messages) {
        const getSessionMessages = options.getSessionMessages;
        if (!getSessionMessages)
            return;
        const providerSessions = checkpointsByProvider.get(providerID);
        if (!providerSessions || providerSessions.has(sessionID))
            return;
        const boundaryTimes = new Set();
        for (const message of messages) {
            const createdAt = messageCreatedAt(message);
            if (createdAt === undefined || !message.parts?.some((part) => part.type === "compaction"))
                continue;
            boundaryTimes.add(createdAt);
        }
        if (!boundaryTimes.size)
            return;
        const childValue = await getSessionMessages(sessionID).catch(() => undefined);
        if (!Array.isArray(childValue))
            return;
        const childMessages = childValue;
        const childFingerprints = childMessages.map(forkMessageFingerprint);
        const candidates = (await Promise.all([...providerSessions.entries()].map(async ([sourceSessionID, checkpoints]) => {
            if (sourceSessionID === sessionID || !checkpoints.some((item) => boundaryTimes.has(item.afterCreatedAt))) {
                return undefined;
            }
            const value = await getSessionMessages(sourceSessionID).catch(() => undefined);
            if (!Array.isArray(value))
                return undefined;
            const sourceMessages = value;
            const limit = Math.min(sourceMessages.length, childMessages.length);
            let prefixLength = 0;
            while (prefixLength < limit &&
                forkMessageFingerprint(sourceMessages[prefixLength]) === childFingerprints[prefixLength]) {
                prefixLength++;
            }
            if (!prefixLength)
                return undefined;
            const messageIDs = new Map();
            for (let index = 0; index < prefixLength; index++) {
                const sourceMessageID = sourceMessages[index]?.info?.id;
                const childMessageID = childMessages[index]?.info?.id;
                if (typeof sourceMessageID === "string" && typeof childMessageID === "string") {
                    messageIDs.set(sourceMessageID, childMessageID);
                }
            }
            const inherited = checkpoints.filter((checkpoint) => messageIDs.has(checkpoint.afterMessageID));
            if (!inherited.length)
                return undefined;
            return {
                sourceSessionID,
                prefixLength,
                messageIDs,
                inherited,
                signature: inherited
                    .map((checkpoint) => `${checkpoint.afterCreatedAt}\0${checkpoint.responseID}`)
                    .sort()
                    .join("\x01"),
            };
        }))).filter((candidate) => candidate !== undefined);
        if (!candidates.length || providerSessions.has(sessionID))
            return;
        const prefixLength = Math.max(...candidates.map((candidate) => candidate.prefixLength));
        const finalists = candidates.filter((candidate) => candidate.prefixLength === prefixLength);
        if (new Set(finalists.map((candidate) => candidate.signature)).size !== 1)
            return;
        const selected = finalists[0];
        const inherited = selected.inherited.map((checkpoint) => ({
            ...checkpoint,
            afterMessageID: selected.messageIDs.get(checkpoint.afterMessageID),
            items: structuredClone(checkpoint.items),
        }));
        providerSessions.set(sessionID, sortCheckpoints(inherited));
        for (const checkpoint of inherited)
            store.upsert(sessionID, checkpoint);
        const inheritedControls = new Map();
        const conflictingControls = new Set();
        for (const candidate of finalists) {
            for (const control of controlsFor(providerID, candidate.sourceSessionID)?.values() ?? []) {
                const messageID = candidate.messageIDs.get(control.messageID);
                if (!messageID || conflictingControls.has(messageID))
                    continue;
                const next = { ...control, sessionID, messageID };
                const existing = inheritedControls.get(messageID);
                if (existing &&
                    (existing.createdAt !== next.createdAt || existing.contentText !== next.contentText)) {
                    inheritedControls.delete(messageID);
                    conflictingControls.add(messageID);
                    continue;
                }
                inheritedControls.set(messageID, next);
            }
        }
        for (const control of inheritedControls.values()) {
            rememberControlIdentity(control.providerID, control.sessionID, control.messageID, control.createdAt, control.contentText);
        }
    }
    function storeStableInstructions(providerID, sessionID, stable) {
        const sessions = getProviderSessionMap(stableInstructionsByProvider, providerID);
        const previous = sessions.get(sessionID);
        sessions.set(sessionID, {
            instructions: stable.instructions !== undefined ? stable.instructions : previous?.instructions,
            inputPrefix: stable.inputPrefix.length ? stable.inputPrefix : (previous?.inputPrefix ?? []),
        });
    }
    function rememberStableInstructions(providerID, sessionID, body) {
        const stable = stableInstructionsFrom(body);
        if (stable)
            storeStableInstructions(providerID, sessionID, stable);
    }
    function rememberPendingSystem(providerID, sessionID, system) {
        const sessions = getProviderSessionMap(pendingSystemByProvider, providerID);
        const instructions = instructionsFromSystem(system);
        if (instructions)
            sessions.set(sessionID, instructions);
        else
            sessions.delete(sessionID);
    }
    function promotePendingSystem(providerID, sessionID) {
        const sessions = pendingSystemByProvider.get(providerID);
        const instructions = sessions?.get(sessionID);
        if (!instructions)
            return;
        storeStableInstructions(providerID, sessionID, { instructions, inputPrefix: [] });
        sessions?.delete(sessionID);
    }
    function addCheckpoint(providerID, sessionID, responseID, boundary, items) {
        const checkpoint = {
            providerID,
            responseID,
            afterMessageID: boundary.messageID,
            afterCreatedAt: boundary.createdAt,
            createdAt: Date.now(),
            items,
        };
        const sessions = getProviderSessionMap(checkpointsByProvider, providerID);
        const checkpoints = sessions.get(sessionID) ?? [];
        sessions.set(sessionID, sortCheckpoints([...checkpoints.filter((checkpoint) => checkpoint.responseID !== responseID), checkpoint]));
        store.upsert(sessionID, checkpoint);
        store.prune(config.state.retentionDays);
        return checkpoint;
    }
    function compactCheckpointFromEvent(event) {
        if (event.type !== "message.part.updated")
            return undefined;
        const properties = asRecord(event.properties);
        const sessionID = properties?.sessionID;
        const pending = typeof sessionID === "string" ? pendingCompactResults.get(sessionID) : undefined;
        const part = asRecord(properties?.part);
        const messageID = part?.messageID;
        const createdAt = properties?.time;
        if (!pending || part?.text !== config.summary)
            return undefined;
        if (typeof sessionID !== "string" || typeof messageID !== "string" || !finiteNumber(createdAt))
            return undefined;
        return { providerID: pending.providerID, sessionID, responseID: pending.responseID, boundary: { messageID, createdAt } };
    }
    function trimMessagesAfterCheckpoint(providerID, messages) {
        const sessionID = sessionIDFromMessages(messages);
        const checkpoints = sessionID ? checkpointsByProvider.get(providerID)?.get(sessionID) : undefined;
        if (!sessionID || !checkpoints)
            return;
        const { checkpoint, clearActive } = selectCheckpoint(checkpoints, messages);
        const activeCheckpoints = getProviderSessionMap(activeCheckpointByProvider, providerID);
        if (checkpoint) {
            activeCheckpoints.set(sessionID, checkpoint);
        }
        else if (clearActive && pendingCompactResults.get(sessionID)?.providerID !== providerID) {
            activeCheckpoints.delete(sessionID);
        }
        if (!checkpoint)
            return;
        const index = messages.findIndex((message) => message.info?.id === checkpoint.afterMessageID);
        if (index === -1)
            return;
        let start = index + 1;
        const boundary = messages[index];
        if (boundary?.info?.role === "user" && boundary.parts?.some((part) => part.type === "compaction")) {
            const summaryIndex = messages.findIndex((message, messageIndex) => messageIndex > index &&
                message.info?.role === "assistant" &&
                message.info.summary === true &&
                message.info.parentID === boundary.info?.id);
            if (summaryIndex !== -1)
                start = summaryIndex + 1;
        }
        const trimmed = messages.slice(start).filter((message) => !isOpenCodeCompactionContinuation(message));
        messages.splice(0, messages.length, ...trimmed);
    }
    function takeStructuredSnapshot(sessionID) {
        const snapshots = structuredCompactionSnapshots.get(sessionID);
        const snapshot = snapshots?.shift();
        if (!snapshots?.length)
            structuredCompactionSnapshots.delete(sessionID);
        return snapshot;
    }
    function clearStructuredCapture(sessionID) {
        pendingCompactionCaptures.delete(sessionID);
        structuredCompactionSnapshots.delete(sessionID);
        failedCompactionCaptures.delete(sessionID);
        blockedCompactionRequests.delete(sessionID);
        pendingCompactionBoundaries.delete(sessionID);
    }
    function clearNativeFallbackSession(sessionID) {
        store.deleteSession(sessionID);
        pendingNativeCompactions.delete(sessionID);
        for (const sessions of checkpointsByProvider.values())
            sessions.delete(sessionID);
        for (const sessions of activeCheckpointByProvider.values())
            sessions.delete(sessionID);
        for (const sessions of controlMessagesByProvider.values())
            sessions.delete(sessionID);
        pendingCompactResults.delete(sessionID);
        pendingCompactionBoundaries.delete(sessionID);
        clearStructuredCapture(sessionID);
    }
    function structuredInputFor(providerID, sessionID, sourceModel, snapshot) {
        const messages = snapshot?.messages ? cloneMessages(snapshot.messages) : undefined;
        if (!messages)
            return undefined;
        try {
            trimMessagesAfterCheckpoint(providerID, messages);
            const history = structuredOpenAIInput(messages, providerID, sourceModel);
            if (!history)
                return undefined;
            const checkpoint = activeCheckpointByProvider.get(providerID)?.get(sessionID);
            const checkpointItems = checkpoint ? structuredClone(checkpoint.items) : [];
            const nativeSummaryText = snapshot?.nativeSummary;
            if (!nativeSummaryText)
                return [...checkpointItems, ...history];
            const nativeSummary = {
                role: "assistant",
                content: [{ type: "output_text", text: `${nativeCompactionSummaryPrefix}${nativeSummaryText}` }],
            };
            return [...checkpointItems.filter((item) => !isNativeCompactionSummaryItem(item)), nativeSummary, ...history];
        }
        catch {
            return undefined;
        }
    }
    async function initWithCompactedInput(providerID, requestInput, init, headers, sessionID, removeLatestUser, selectedCheckpoint) {
        const body = parseJsonRecord(await bodyText(requestInput, init));
        if (!body || !Array.isArray(body.input)) {
            return fetchInitForReroute(requestInput, init, headers);
        }
        const checkpoint = selectedCheckpoint ?? activeCheckpointByProvider.get(providerID)?.get(sessionID);
        if (!checkpoint)
            return fetchInitForReroute(requestInput, init, headers);
        headers.set("content-type", "application/json");
        const postCompaction = postCompactionInput(body.input, config.summary);
        const input = removeLatestUser ? withoutLatestUserInput(postCompaction) : postCompaction;
        const next = {
            ...body,
            input: [...structuredClone(checkpoint.items), ...input],
        };
        return { ...fetchInitForReroute(requestInput, init, headers), body: JSON.stringify(next) };
    }
    function wrapFetch(base, providerID, provider) {
        const previousBase = base[wrappedBaseFetch];
        const baseFetch = typeof previousBase === "function" ? previousBase : base;
        const wrapped = (async (requestInput, init) => {
            const url = urlOf(requestInput);
            const headers = requestHeaders(requestInput, init);
            const { sessionID: headerSessionID, shouldCompact, shouldNativeCompact } = compactMarkers(headers, config);
            const isResponsesRequest = url ? isResponsesUrl(url, config) : false;
            const outboundHeaders = cleanedHeaders(headers, config);
            if (!isResponsesRequest) {
                return baseFetch(requestInput, fetchInit(init, outboundHeaders));
            }
            const sessionID = headerSessionID;
            if ((shouldCompact || shouldNativeCompact) && !sessionID) {
                return new Response("OpenAI compact request is missing session header", { status: 400 });
            }
            if (shouldCompact && sessionID && blockedCompactionRequests.delete(sessionID)) {
                clearStructuredCapture(sessionID);
                return new Response("OpenAI compact structured history could not be captured safely", { status: 502 });
            }
            const removeLatestUser = !shouldCompact && sessionID !== undefined && pendingAutoContinueRequests.get(sessionID) === providerID;
            if (removeLatestUser)
                pendingAutoContinueRequests.delete(sessionID);
            const nativeCompaction = sessionID ? pendingNativeCompactions.get(sessionID) : undefined;
            const matchingNativeCompaction = nativeCompaction?.providerID === providerID ? nativeCompaction : undefined;
            let originalRequestInit = fetchInitForReroute(requestInput, init, outboundHeaders);
            if (shouldNativeCompact) {
                const originalBody = await bodyText(requestInput, init);
                if (originalBody !== undefined)
                    originalRequestInit = { ...originalRequestInit, body: originalBody };
            }
            const suppressInvalidCheckpoint = !!matchingNativeCompaction && !shouldNativeCompact;
            const requestInit = sessionID && !suppressInvalidCheckpoint && (!shouldNativeCompact || matchingNativeCompaction)
                ? await initWithCompactedInput(providerID, requestInput, init, outboundHeaders, sessionID, removeLatestUser, shouldNativeCompact ? matchingNativeCompaction?.checkpoint : undefined)
                : originalRequestInit;
            const route = async (request) => {
                const authRequest = usesOpenAIOAuth(providerID, new Headers(request.headers))
                    ? await openAIOAuth.requestInit(request)
                    : undefined;
                return {
                    input: authRequest ? chatGPTCodexResponsesEndpoint : requestInput,
                    init: authRequest ?? request,
                };
            };
            const routed = await route(requestInit);
            const routedRequestInput = routed.input;
            const routedRequestInit = routed.init;
            if (!sessionID) {
                return baseFetch(routedRequestInput, routedRequestInit);
            }
            const body = parseJsonRecord(typeof routedRequestInit.body === "string" ? routedRequestInit.body : undefined);
            if (shouldNativeCompact) {
                const response = await baseFetch(routedRequestInput, routedRequestInit);
                if (response.ok) {
                    if (matchingNativeCompaction)
                        matchingNativeCompaction.completed = true;
                    return response;
                }
                if (!matchingNativeCompaction ||
                    (response.status !== 400 && response.status !== 413 && response.status !== 422)) {
                    return response;
                }
                const retry = await route(originalRequestInit);
                const retriedResponse = await baseFetch(retry.input, retry.init);
                if (!retriedResponse.ok)
                    return response;
                matchingNativeCompaction.completed = true;
                return retriedResponse;
            }
            if (!shouldCompact) {
                rememberStableInstructions(providerID, sessionID, body);
                return baseFetch(routedRequestInput, routedRequestInit);
            }
            if (typeof body?.model !== "string" || !Array.isArray(body.input) || !url) {
                clearStructuredCapture(sessionID);
                return baseFetch(routedRequestInput, routedRequestInit);
            }
            const snapshot = takeStructuredSnapshot(sessionID);
            const conversation = snapshot?.conversation?.providerID === providerID ? snapshot.conversation : undefined;
            const selectedModel = provider.compactModel ?? conversation?.modelID ?? body.model;
            const selectedReasoningEffort = provider.compactReasoningEffort ??
                conversation?.reasoningEffort ??
                compactReasoningEffort(asRecord(body.reasoning)?.effort) ??
                null;
            const structuredInput = structuredInputFor(providerID, sessionID, selectedModel, snapshot);
            if (snapshot && !structuredInput) {
                clearStructuredCapture(sessionID);
                return new Response("OpenAI compact structured history could not be converted safely", { status: 502 });
            }
            if (!structuredInput)
                clearStructuredCapture(sessionID);
            if (!structuredInput && !isKnownOpenCodeCompactionBody(body)) {
                return baseFetch(routedRequestInput, routedRequestInit);
            }
            const outboundCompactHeaders = new Headers(routedRequestInit.headers);
            outboundCompactHeaders.set("content-type", "application/json");
            const compactBodyWithHistory = compactBody(body, selectedModel, config, selectedReasoningEffort);
            delete compactBodyWithHistory.instructions;
            if (structuredInput)
                compactBodyWithHistory.input = [...structuredInput, { type: "compaction_trigger" }];
            const compactRequestBody = withStableInstructions(compactBodyWithHistory, stableInstructionsByProvider.get(providerID)?.get(sessionID), config.compactBodyKeys.includes("instructions"));
            const compacted = await baseFetch(routedRequestInput, {
                ...routedRequestInit,
                method: "POST",
                headers: outboundCompactHeaders,
                body: JSON.stringify(compactRequestBody),
            });
            if (!compacted.ok) {
                clearStructuredCapture(sessionID);
                return compacted;
            }
            const payload = await compactV2Payload(compacted.clone()).catch(() => undefined);
            const compaction = asRecord(payload?.compaction);
            const items = compaction ? compactedItemsForV2(compactRequestBody.input, compaction) : undefined;
            if (!items) {
                clearStructuredCapture(sessionID);
                return new Response("OpenAI compact response stream must complete with exactly one valid compaction item", {
                    status: 502,
                });
            }
            const responseID = typeof payload?.id === "string" ? payload.id : undefined;
            if (!responseID) {
                clearStructuredCapture(sessionID);
                return new Response("OpenAI compact response.completed event must contain a response id", { status: 502 });
            }
            const capturedBoundary = pendingCompactionBoundaries.get(sessionID);
            pendingCompactionBoundaries.delete(sessionID);
            const checkpoint = addCheckpoint(providerID, sessionID, responseID, capturedBoundary ?? { messageID: responseMessageID(responseID), createdAt: Date.now() }, items);
            if (capturedBoundary)
                pendingCompactResults.delete(sessionID);
            else
                pendingCompactResults.set(sessionID, { providerID, responseID, items });
            getProviderSessionMap(activeCheckpointByProvider, providerID).set(sessionID, checkpoint);
            return sseResponse({
                responseID,
                model: typeof payload?.model === "string" ? payload.model : selectedModel,
                createdAt: typeof payload?.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000),
                summary: config.summary,
                usage: asRecord(payload?.usage),
            });
        });
        Object.defineProperty(wrapped, wrappedFetch, { value: true });
        Object.defineProperty(wrapped, wrappedBaseFetch, { value: baseFetch });
        return wrapped;
    }
    function getOpenAIWrappedFetch(base = baseFetch) {
        const provider = config.providers.openai;
        if (!provider)
            return undefined;
        openAIWrappedFetch ??= wrapFetch(base, "openai", provider);
        return openAIWrappedFetch;
    }
    async function handleEvent(event) {
        if (event.type === "session.compacted") {
            const sessionID = asRecord(event.properties)?.sessionID;
            if (typeof sessionID !== "string")
                return;
            const nativeCompaction = pendingNativeCompactions.get(sessionID);
            if (!nativeCompaction?.completed)
                return;
            clearNativeFallbackSession(sessionID);
            return;
        }
        if (event.type === "message.updated") {
            const properties = asRecord(event.properties);
            const sessionID = properties?.sessionID;
            if (typeof sessionID !== "string")
                return;
            const nativeCompaction = pendingNativeCompactions.get(sessionID);
            const info = asRecord(properties?.info);
            if (!nativeCompaction?.completed || !isCompletedCompactionSummary(info))
                return;
            if (nativeCompaction.compactionMessageID && info?.parentID !== nativeCompaction.compactionMessageID)
                return;
            clearNativeFallbackSession(sessionID);
            return;
        }
        if (event.type === "session.deleted") {
            const sessionID = asRecord(event.properties)?.sessionID;
            if (typeof sessionID !== "string")
                return;
            for (const sessions of checkpointsByProvider.values())
                sessions.delete(sessionID);
            pendingCompactResults.delete(sessionID);
            pendingCompactionBoundaries.delete(sessionID);
            pendingAutoContinues.delete(sessionID);
            pendingAutoContinueRequests.delete(sessionID);
            pendingNativeCompactions.delete(sessionID);
            for (const sessions of activeCheckpointByProvider.values())
                sessions.delete(sessionID);
            for (const sessions of controlMessagesByProvider.values())
                sessions.delete(sessionID);
            for (const sessions of stableInstructionsByProvider.values())
                sessions.delete(sessionID);
            for (const sessions of pendingSystemByProvider.values())
                sessions.delete(sessionID);
            clearStructuredCapture(sessionID);
            for (const key of providerByMessage.keys()) {
                if (key.startsWith(`${sessionID}\0`))
                    providerByMessage.delete(key);
            }
            if (config.state.deleteOnSessionDeleted)
                store.deleteSession(sessionID);
            return;
        }
        if (event.type === "message.removed") {
            const properties = asRecord(event.properties);
            const sessionID = properties?.sessionID;
            const messageID = properties?.messageID;
            if (typeof sessionID !== "string" || typeof messageID !== "string")
                return;
            providerByMessage.delete(messageProviderKey(sessionID, messageID));
            clearStructuredCapture(sessionID);
            pendingAutoContinues.delete(sessionID);
            pendingAutoContinueRequests.delete(sessionID);
            failedCompactionCaptures.delete(sessionID);
            const nativeCompaction = pendingNativeCompactions.get(sessionID);
            if (nativeCompaction &&
                (nativeCompaction.checkpoint.afterMessageID === messageID ||
                    nativeCompaction.compactionMessageID === messageID)) {
                pendingNativeCompactions.delete(sessionID);
            }
            forgetControlMessage(sessionID, messageID);
            for (const [providerID, sessions] of checkpointsByProvider) {
                const checkpoints = sessions.get(sessionID);
                if (!checkpoints)
                    continue;
                const removed = checkpoints.filter((checkpoint) => checkpoint.afterMessageID === messageID);
                if (!removed.length)
                    continue;
                const remaining = checkpoints.filter((checkpoint) => checkpoint.afterMessageID !== messageID);
                if (remaining.length)
                    sessions.set(sessionID, remaining);
                else
                    sessions.delete(sessionID);
                const activeCheckpoints = activeCheckpointByProvider.get(providerID);
                if (activeCheckpoints?.get(sessionID)?.afterMessageID === messageID)
                    activeCheckpoints.delete(sessionID);
                for (const checkpoint of removed)
                    store.deleteCheckpoint(sessionID, providerID, checkpoint.responseID);
            }
            return;
        }
        const compact = compactCheckpointFromEvent(event);
        if (!compact)
            return;
        const pending = pendingCompactResults.get(compact.sessionID);
        if (pending?.responseID !== compact.responseID)
            return;
        pendingCompactResults.delete(compact.sessionID);
        const checkpoint = addCheckpoint(compact.providerID, compact.sessionID, compact.responseID, compact.boundary, pending.items);
        getProviderSessionMap(activeCheckpointByProvider, compact.providerID).set(compact.sessionID, checkpoint);
    }
    const hooks = {
        auth: {
            provider: "openai",
            methods: openAIAuthMethods,
            async loader(getAuth) {
                const auth = await getAuth();
                openAIAuth = asOpenAIOAuth(auth);
                const apiAuth = asRecord(auth);
                const fetch = getOpenAIWrappedFetch();
                if (openAIAuth)
                    return { apiKey: openAIOAuthDummyKey, ...(fetch ? { fetch } : {}) };
                if (apiAuth?.type === "api" && typeof apiAuth.key === "string") {
                    return { apiKey: apiAuth.key, ...(fetch ? { fetch } : {}) };
                }
                return {};
            },
        },
        async dispose() {
            store.close();
        },
        async config(cfg) {
            const root = cfg;
            root.provider ??= {};
            const providers = root.provider;
            for (const [providerID, compactProvider] of Object.entries(config.providers)) {
                providers[providerID] ??= {};
                const provider = providers[providerID];
                provider.options ??= {};
                const options = provider.options;
                const currentFetch = options.fetch ?? baseFetch;
                options.fetch =
                    providerID === "openai"
                        ? getOpenAIWrappedFetch(currentFetch)
                        : wrapFetch(currentFetch, providerID, compactProvider);
            }
        },
        async event(input) {
            await handleEvent(input.event);
        },
        "chat.message": async (input, output) => {
            if (typeof input.sessionID === "string") {
                pendingAutoContinues.delete(input.sessionID);
                pendingAutoContinueRequests.delete(input.sessionID);
                const message = asRecord(output.message);
                const messageID = typeof input.messageID === "string" ? input.messageID : message?.id;
                if (typeof messageID === "string")
                    forgetControlMessage(input.sessionID, messageID);
            }
            rememberMessageProvider(input, output);
        },
        "chat.headers": async (input, output) => {
            const providerID = getProviderID(input);
            if (!providerID || !configuredProviders.has(providerID))
                return;
            if (typeof input.sessionID !== "string")
                return;
            const hasCompactionCapture = !!structuredCompactionSnapshots.get(input.sessionID)?.length || failedCompactionCaptures.has(input.sessionID);
            const checkpoint = activeCheckpointByProvider.get(providerID)?.get(input.sessionID);
            if (hasCompactionCapture && checkpoint && hasInvalidCheckpointHistory(checkpoint)) {
                pendingSystemByProvider.get(providerID)?.delete(input.sessionID);
                const messageID = asRecord(input.message)?.id;
                pendingNativeCompactions.set(input.sessionID, {
                    providerID,
                    checkpoint,
                    compactionMessageID: typeof messageID === "string" ? messageID : undefined,
                    completed: false,
                });
                clearStructuredCapture(input.sessionID);
                output.headers[config.headers.session] = input.sessionID;
                output.headers[config.headers.compact] = "native";
                return;
            }
            if (structuredCompactionSnapshots.get(input.sessionID)?.length) {
                pendingSystemByProvider.get(providerID)?.delete(input.sessionID);
                const message = asRecord(input.message);
                const messageID = message?.id;
                const createdAt = asRecord(message?.time)?.created;
                if (typeof messageID === "string" && finiteNumber(createdAt)) {
                    pendingCompactionBoundaries.set(input.sessionID, { messageID, createdAt });
                }
                output.headers[config.headers.session] = input.sessionID;
                output.headers[config.headers.compact] = "1";
                return;
            }
            if (failedCompactionCaptures.has(input.sessionID)) {
                pendingSystemByProvider.get(providerID)?.delete(input.sessionID);
                blockedCompactionRequests.add(input.sessionID);
                output.headers[config.headers.session] = input.sessionID;
                output.headers[config.headers.compact] = "1";
                return;
            }
            const pendingAutoContinue = pendingAutoContinues.get(input.sessionID);
            if (pendingAutoContinue?.providerID === providerID) {
                const message = asRecord(input.message);
                const messageID = message?.id;
                const createdAt = asRecord(message?.time)?.created;
                const createdAfterCompaction = !finiteNumber(createdAt) ||
                    pendingAutoContinue.compactionCreatedAt === undefined ||
                    createdAt >= pendingAutoContinue.compactionCreatedAt;
                const matchingAgent = !pendingAutoContinue.agent || pendingAutoContinue.agent === input.agent;
                if (createdAfterCompaction &&
                    matchingAgent &&
                    typeof messageID === "string" &&
                    messageID !== pendingAutoContinue.compactionMessageID) {
                    rememberControlIdentity(providerID, input.sessionID, messageID, finiteNumber(createdAt) ? createdAt : Date.now(), "");
                    pendingAutoContinueRequests.set(input.sessionID, providerID);
                    pendingAutoContinues.delete(input.sessionID);
                }
            }
            const messageAgent = asRecord(input.message)?.agent;
            if ((typeof messageAgent === "string" && messageAgent !== input.agent) ||
                (messageAgent === undefined && utilityAgents.has(input.agent))) {
                pendingSystemByProvider.get(providerID)?.delete(input.sessionID);
                return;
            }
            promotePendingSystem(providerID, input.sessionID);
            output.headers[config.headers.session] = input.sessionID;
        },
        "experimental.chat.messages.transform": async (input, output) => {
            const messages = output.messages;
            const sessionID = sessionIDFromMessages(messages);
            const pendingCaptures = sessionID ? pendingCompactionCaptures.get(sessionID) : undefined;
            const providerID = transformProviderID(input, messages);
            let rawMessages;
            if (sessionID && providerID && configuredProviders.has(providerID)) {
                await inheritForkState(providerID, sessionID, messages);
                if (pendingCaptures && options.getSessionMessages) {
                    const value = await options.getSessionMessages(sessionID).catch(() => undefined);
                    if (Array.isArray(value))
                        rawMessages = value;
                }
                if (pendingCaptures && !activeCheckpointByProvider.get(providerID)?.has(sessionID)) {
                    const checkpoint = checkpointsByProvider.get(providerID)?.get(sessionID)?.at(-1);
                    if (checkpoint)
                        getProviderSessionMap(activeCheckpointByProvider, providerID).set(sessionID, checkpoint);
                }
                captureControlMessages(providerID, sessionID, messages);
                removeControlMessages(providerID, sessionID, messages);
                const checkpoint = activeCheckpointByProvider.get(providerID)?.get(sessionID);
                if (pendingCaptures && checkpoint && hasCompletedCompactionAfterCheckpoint(checkpoint, rawMessages ?? messages)) {
                    clearNativeFallbackSession(sessionID);
                }
            }
            const clonedMessages = pendingCaptures ? cloneMessages(messages) : undefined;
            const snapshot = clonedMessages
                ? {
                    messages: clonedMessages,
                    conversation: conversationSettingsFrom(messages),
                    nativeSummary: rawMessages ? latestNativeCompactionSummary(rawMessages, config.summary) : undefined,
                }
                : undefined;
            if (providerID && configuredProviders.has(providerID))
                trimMessagesAfterCheckpoint(providerID, messages);
            if (sessionID && pendingCaptures) {
                if (pendingCaptures === 1)
                    pendingCompactionCaptures.delete(sessionID);
                else
                    pendingCompactionCaptures.set(sessionID, pendingCaptures - 1);
                if (snapshot) {
                    failedCompactionCaptures.delete(sessionID);
                    const snapshots = structuredCompactionSnapshots.get(sessionID) ?? [];
                    snapshots.push(snapshot);
                    structuredCompactionSnapshots.set(sessionID, snapshots);
                }
                else {
                    failedCompactionCaptures.add(sessionID);
                }
            }
        },
        "experimental.chat.system.transform": async (input, output) => {
            const providerID = getProviderID(input);
            if (!providerID || !configuredProviders.has(providerID))
                return;
            if (typeof input.sessionID !== "string")
                return;
            rememberPendingSystem(providerID, input.sessionID, output.system);
        },
        "experimental.session.compacting": async (input) => {
            if (typeof input.sessionID !== "string")
                return;
            pendingAutoContinues.delete(input.sessionID);
            pendingAutoContinueRequests.delete(input.sessionID);
            pendingNativeCompactions.delete(input.sessionID);
            failedCompactionCaptures.delete(input.sessionID);
            blockedCompactionRequests.delete(input.sessionID);
            pendingCompactionCaptures.set(input.sessionID, (pendingCompactionCaptures.get(input.sessionID) ?? 0) + 1);
        },
        "experimental.compaction.autocontinue": async (input) => {
            if (typeof input.sessionID !== "string")
                return;
            const providerID = getProviderID(input);
            if (!providerID || !configuredProviders.has(providerID))
                return;
            const pending = pendingCompactResults.get(input.sessionID);
            const message = asRecord(input.message);
            const messageID = message?.id;
            const createdAt = asRecord(message?.time)?.created;
            if (pending?.providerID === providerID &&
                typeof messageID === "string" &&
                finiteNumber(createdAt)) {
                pendingCompactResults.delete(input.sessionID);
                const checkpoint = addCheckpoint(providerID, input.sessionID, pending.responseID, { messageID, createdAt }, pending.items);
                getProviderSessionMap(activeCheckpointByProvider, providerID).set(input.sessionID, checkpoint);
            }
            pendingAutoContinueRequests.delete(input.sessionID);
            pendingAutoContinues.set(input.sessionID, {
                providerID,
                agent: typeof input.agent === "string" ? input.agent : undefined,
                compactionMessageID: typeof messageID === "string" ? messageID : undefined,
                compactionCreatedAt: finiteNumber(createdAt) ? createdAt : undefined,
            });
        },
    };
    return hooks;
}
