import type { Hooks } from "@opencode-ai/plugin"
import {
  compactReasoningEfforts,
  defaultConfig,
  type CompactReasoningEffort,
  type OpenAICompactConfig,
} from "./schema.js"
import {
  asOpenAIOAuth,
  createOpenAIOAuth,
  openAIAuthMethods,
  openAIOAuthDummyKey,
  usesOpenAIOAuth,
  type OpenAIOAuthAuth,
  type OAuthFetchLike,
} from "./oauth.js"
import { CheckpointStore, compactedItemsFrom, type AnyRecord, type Checkpoint } from "./state.js"

export { compactedItemsFrom } from "./state.js"

type FetchLike = typeof fetch
type MessageEntry = {
  info?: {
    id?: string
    sessionID?: string
    role?: string
    providerID?: string
    modelID?: string
    variant?: string
    model?: {
      providerID?: string
      modelID?: string
      variant?: string
    }
    error?: unknown
    time?: { created?: number }
  }
  parts?: Array<{
    type?: string
    text?: string
    messageID?: string
    synthetic?: boolean
    ignored?: boolean
    mime?: string
    filename?: string
    url?: string
    tool?: string
    callID?: string
    state?: unknown
    metadata?: AnyRecord
    time?: { start?: number }
  }>
}
type MessageBoundary = { messageID: string; createdAt: number }
type PendingCompactResult = { providerID: string; responseID: string; items: AnyRecord[] }
type ConversationSettings = {
  providerID: string
  modelID: string
  reasoningEffort?: CompactReasoningEffort
}
type StructuredCompactionSnapshot = { messages?: MessageEntry[]; conversation?: ConversationSettings }
type ProviderConfig = OpenAICompactConfig["providers"][string]
type StableInstructions = { instructions?: unknown; inputPrefix: unknown[] }
type CompactHookOptions = {
  setOpenAIAuth?: (auth: OpenAIOAuthAuth) => Promise<void>
  tokenFetch?: OAuthFetchLike
}

const wrappedFetch = "__opencodeOpenAICompactFetch"
const wrappedBaseFetch = "__opencodeOpenAICompactBaseFetch"
const chatGPTCodexResponsesEndpoint = "https://chatgpt.com/backend-api/codex/responses"
const openCodeCompactionDeveloperPromptStarts = [
  "You are an anchored context summarization assistant for coding sessions.",
  "You are a context summarization agent. You are given a conversation between a user and an agent.",
] as const
const utilityAgents = new Set(["compaction", "title", "summary"])
const openCodeCompactionUserPromptStarts = [
  "Create a new anchored summary from the conversation history.",
  "Update the anchored summary below using the conversation history above.",
] as const
const openCodeConversationHistoryMarker = "The following is the conversation history:"
const openCodeConversationIntro = "Here is the conversation so far:"
const openCodeConversationOpenTag = "<conversation>"
const openCodeConversationCloseTag = "</conversation>"
const openCodeCompactionQuestion = "What did we do so far?"
const openCodeCompactionContinuation =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
const toolOutputMaxChars = 2_000
const compactReasoningEffortSet = new Set<string>(compactReasoningEfforts)

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : undefined
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function compactReasoningEffort(value: unknown): CompactReasoningEffort | undefined {
  return typeof value === "string" && compactReasoningEffortSet.has(value)
    ? (value as CompactReasoningEffort)
    : undefined
}

function conversationSettingsFrom(messages: MessageEntry[]): ConversationSettings | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message.parts?.length) continue

    const info = message.info
    if (!info) continue
    const model = info.role === "user" ? info.model : info
    if (typeof model?.providerID !== "string" || typeof model.modelID !== "string") continue

    return {
      providerID: model.providerID,
      modelID: model.modelID,
      reasoningEffort: compactReasoningEffort(model.variant),
    }
  }
  return undefined
}

function urlOf(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof URL) return new URL(input.href)
    if (input instanceof Request) return new URL(input.url)
    return new URL(String(input))
  } catch {
    return undefined
  }
}

function pathWithoutTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/+$/, "") : value
}

export function isResponsesUrl(url: URL, config: OpenAICompactConfig) {
  return pathWithoutTrailingSlash(url.pathname).endsWith(config.responses.endpointPath)
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

function cleanedHeaders(headers: Headers, config: OpenAICompactConfig): Headers {
  const result = new Headers(headers)
  result.delete(config.headers.compact)
  result.delete(config.headers.session)
  return result
}

function fetchInit(init: RequestInit | undefined, headers: Headers): RequestInit {
  return init ? { ...init, headers } : { headers }
}

type RequestInitWithDuplex = RequestInit & { duplex?: "half" }

function fetchInitForReroute(input: RequestInfo | URL, init: RequestInit | undefined, headers: Headers): RequestInit {
  if (!(input instanceof Request)) return fetchInit(init, headers)

  const requestInit: RequestInitWithDuplex = {
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
  }
  const duplex = (input as Request & { duplex?: "half" }).duplex
  if (duplex && requestInit.body !== undefined && requestInit.body !== null) requestInit.duplex = duplex
  return requestInit
}

function compactMarkers(headers: Headers, config: OpenAICompactConfig) {
  const sessionID = headers.get(config.headers.session) ?? undefined
  const shouldCompact = headers.get(config.headers.compact) === "1"
  headers.delete(config.headers.compact)
  headers.delete(config.headers.session)
  return { sessionID, shouldCompact }
}

async function bodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body)
  if (input instanceof Request) return input.clone().text()
  return undefined
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((item) => {
      if (typeof item === "string") return item
      const record = asRecord(item)
      return typeof record?.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

function isOpenCodeCompactionDeveloperPrompt(value: unknown) {
  const text = contentText(value).trimStart()
  return openCodeCompactionDeveloperPromptStarts.some((start) => text.startsWith(start))
}

function isTaggedOpenCodeConversation(value: unknown) {
  const text = contentText(value).trimStart()
  if (!text.startsWith(openCodeConversationIntro)) return false
  const open = text.indexOf(openCodeConversationOpenTag, openCodeConversationIntro.length)
  if (open === -1) return false
  return text.indexOf(openCodeConversationCloseTag, open + openCodeConversationOpenTag.length) !== -1
}

function isOpenCodeCompactionUserPrompt(value: unknown) {
  const text = contentText(value).trimStart()
  return openCodeCompactionUserPromptStarts.some((start) => text.startsWith(start)) || isTaggedOpenCodeConversation(value)
}

function hasEmbeddedOpenCodeConversation(value: unknown) {
  if (isTaggedOpenCodeConversation(value)) return true
  return isOpenCodeCompactionUserPrompt(value) && contentText(value).includes(openCodeConversationHistoryMarker)
}

function compactInput(value: unknown) {
  if (!Array.isArray(value)) return value
  return value.filter((item, index) => {
    const record = asRecord(item)
    if (!record) return true
    if (record.role === "developer" && isOpenCodeCompactionDeveloperPrompt(record.content)) return false
    if (
      index === value.length - 1 &&
      record.role === "user" &&
      isOpenCodeCompactionUserPrompt(record.content) &&
      !hasEmbeddedOpenCodeConversation(record.content)
    ) {
      return false
    }
    return true
  })
}

function isKnownOpenCodeCompactionBody(body: AnyRecord) {
  if (isOpenCodeCompactionDeveloperPrompt(body.instructions)) return true
  if (!Array.isArray(body.input)) return false
  const last = asRecord(body.input.at(-1))
  return last?.role === "user" && isOpenCodeCompactionUserPrompt(last.content)
}

function truncateToolOutput(value: string) {
  if (value.length <= toolOutputMaxChars) return value
  const omitted = value.length - toolOutputMaxChars
  return `${value.slice(0, toolOutputMaxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

function structuredOpenAIInput(
  messages: MessageEntry[],
  providerID: string,
  sourceModel: string,
): AnyRecord[] | undefined {
  const input: AnyRecord[] = []

  for (const message of messages) {
    const info = message.info
    const parts = message.parts ?? []
    if (!info?.role || info.error) return undefined
    if (!parts.length) continue

    if (info.role === "user") {
      const content: AnyRecord[] = []
      for (const part of parts) {
        if (part.type === "text" && !part.ignored && part.text) {
          content.push({ type: "input_text", text: part.text })
          continue
        }
        if (part.type === "file") {
          if (typeof part.mime !== "string") return undefined
          if (part.mime === "text/plain" || part.mime === "application/x-directory") continue
          if (part.mime.startsWith("image/") || part.mime === "application/pdf") {
            content.push({ type: "input_text", text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` })
            continue
          }
          if (typeof part.url !== "string") return undefined
          content.push(
            part.url.startsWith("data:")
              ? { type: "input_file", filename: part.filename ?? "file", file_data: part.url }
              : { type: "input_file", file_url: part.url },
          )
          continue
        }
        if (part.type === "compaction") {
          content.push({ type: "input_text", text: openCodeCompactionQuestion })
          continue
        }
        if (part.type === "subtask") {
          content.push({ type: "input_text", text: "The following tool was executed by the user" })
        }
      }
      if (content.length) input.push({ role: "user", content })
      continue
    }

    if (info.role !== "assistant") return undefined
    const differentModel = `${providerID}/${sourceModel}` !== `${info.providerID}/${info.modelID}`
    const assistantItems: AnyRecord[] = []
    const toolOutputs: AnyRecord[] = []
    const reasoningByID = new Map<string, AnyRecord>()
    const hasSignedReasoning = parts.some(
      (part) => part.type === "reasoning" && asRecord(asRecord(part.metadata)?.anthropic)?.signature != null,
    )

    for (const part of parts) {
      if (part.type === "text") {
        const text = part.text === "" && hasSignedReasoning ? " " : part.text
        if (typeof text !== "string") return undefined
        const metadata = differentModel ? undefined : asRecord(asRecord(part.metadata)?.openai)
        const item: AnyRecord = {
          role: "assistant",
          content: [{ type: "output_text", text }],
        }
        if (typeof metadata?.itemId === "string") item.id = metadata.itemId
        if (metadata?.phase === "commentary" || metadata?.phase === "final_answer") item.phase = metadata.phase
        assistantItems.push(item)
        continue
      }

      if (part.type === "reasoning") {
        if (typeof part.text !== "string") return undefined
        if (differentModel) {
          if (part.text.trim()) {
            assistantItems.push({ role: "assistant", content: [{ type: "output_text", text: part.text }] })
          }
          continue
        }

        const metadata = asRecord(asRecord(part.metadata)?.openai)
        const encryptedContent = metadata?.reasoningEncryptedContent
        if (typeof encryptedContent !== "string") continue
        const summary = part.text ? [{ type: "summary_text", text: part.text }] : []
        const itemID = metadata?.itemId
        if (typeof itemID !== "string") {
          assistantItems.push({ type: "reasoning", encrypted_content: encryptedContent, summary })
          continue
        }

        const existing = reasoningByID.get(itemID)
        if (existing) {
          const existingSummary = existing.summary as AnyRecord[]
          existingSummary.push(...summary)
          existing.encrypted_content = encryptedContent
          continue
        }
        const item: AnyRecord = {
          type: "reasoning",
          id: itemID,
          encrypted_content: encryptedContent,
          summary,
        }
        reasoningByID.set(itemID, item)
        assistantItems.push(item)
        continue
      }

      if (part.type !== "tool") continue
      if (part.metadata?.providerExecuted === true) return undefined
      if (typeof part.tool !== "string" || typeof part.callID !== "string") return undefined
      const state = asRecord(part.state)
      if (!state || typeof state.status !== "string") return undefined

      let argumentsText: string
      try {
        argumentsText = JSON.stringify(state.input === undefined ? {} : state.input)
      } catch {
        return undefined
      }
      assistantItems.push({
        type: "function_call",
        call_id: part.callID,
        name: part.tool,
        arguments: argumentsText,
      })

      let output: string
      if (state.status === "completed") {
        const time = asRecord(state.time)
        if (time?.compacted) output = "[Old tool result content cleared]"
        else if (typeof state.output === "string") output = truncateToolOutput(state.output)
        else return undefined
      } else if (state.status === "error") {
        const metadata = asRecord(state.metadata)
        if (metadata?.interrupted === true && typeof metadata.output === "string") output = metadata.output
        else if (typeof state.error === "string") output = state.error
        else return undefined
      } else if (state.status === "pending" || state.status === "running") {
        output = "[Tool execution was interrupted]"
      } else {
        return undefined
      }
      toolOutputs.push({ type: "function_call_output", call_id: part.callID, output })
    }

    input.push(...assistantItems, ...toolOutputs)
  }

  return input.length ? input : undefined
}

function cloneMessages(messages: MessageEntry[]) {
  try {
    return structuredClone(messages)
  } catch {
    return undefined
  }
}

function messageHasText(value: unknown, role: "assistant" | "user", text: string) {
  const message = asRecord(value)
  return message?.role === role && contentText(message.content) === text
}

function postCompactionInput(input: unknown[], summary: string) {
  const start = input.findIndex(
    (item, index) =>
      messageHasText(item, "user", openCodeCompactionQuestion) &&
      messageHasText(input[index + 1], "assistant", summary),
  )
  if (start === -1) return input

  const result = [...input.slice(0, leadingInstructionCount(input)), ...input.slice(start + 2)]
  if (messageHasText(result.at(-1), "user", openCodeCompactionContinuation)) result.pop()
  return result
}

function compactBodyValue(key: string, value: unknown) {
  if (key === "input") {
    const input = compactInput(value)
    if (!Array.isArray(input)) return input
    return [
      ...input.filter((item) => asRecord(item)?.type !== "compaction_trigger"),
      { type: "compaction_trigger" },
    ]
  }
  if (key === "instructions" && (value === "" || isOpenCodeCompactionDeveloperPrompt(value))) return undefined
  return value
}

function leadingInstructionCount(input: unknown[]) {
  let index = 0
  while (true) {
    const role = asRecord(input[index])?.role
    if (role !== "developer" && role !== "system") return index
    index++
  }
}

function latestInstructionPrefix(input: unknown[]) {
  let start = 0
  for (let index = input.length - 1; index >= 0; index--) {
    const type = asRecord(input[index])?.type
    if (type === "compaction" || type === "compaction_summary") {
      start = index + 1
      break
    }
  }

  let end = start
  while (true) {
    const role = asRecord(input[end])?.role
    if (role !== "developer" && role !== "system") return input.slice(start, end)
    end++
  }
}

function stableInstructionsFrom(body: AnyRecord | undefined): StableInstructions | undefined {
  if (!body) return undefined

  const inputPrefix = Array.isArray(body.input) ? latestInstructionPrefix(body.input) : []
  const instructions = isOpenCodeCompactionDeveloperPrompt(body.instructions) ? undefined : body.instructions
  if (instructions === undefined && !inputPrefix.length) return undefined
  return { instructions, inputPrefix: structuredClone(inputPrefix) }
}

function instructionsFromSystem(system: unknown) {
  if (!Array.isArray(system)) return undefined
  if (!system.every((item): item is string => typeof item === "string")) return undefined
  const instructions = system.join("\n")
  if (!instructions || isOpenCodeCompactionDeveloperPrompt(instructions)) return undefined
  return instructions
}

function withStableInstructions(body: AnyRecord, stable: StableInstructions | undefined, allowInstructions: boolean): AnyRecord {
  if (!stable) return body

  const next = { ...body }
  if (allowInstructions && next.instructions === undefined && stable.instructions !== undefined) {
    next.instructions = structuredClone(stable.instructions)
  }
  if (stable.inputPrefix.length && Array.isArray(next.input)) {
    next.input = [...structuredClone(stable.inputPrefix), ...next.input.slice(leadingInstructionCount(next.input))]
  }
  return next
}

export function compactBody(
  body: AnyRecord,
  compactModel = defaultConfig.providers.openai.compactModel,
  config: OpenAICompactConfig = defaultConfig,
  reasoningEffort = defaultConfig.providers.openai.compactReasoningEffort,
): AnyRecord {
  const model = compactModel ?? (typeof body.model === "string" ? body.model : undefined)
  const result: AnyRecord = model ? { model } : {}
  for (const key of config.compactBodyKeys) {
    if (key === "model") continue
    const value = compactBodyValue(key, body[key])
    if (value !== undefined) result[key] = value
  }
  if (!config.compactBodyKeys.includes("input")) {
    const input = compactBodyValue("input", body.input)
    if (input !== undefined) result.input = input
  }
  const effort = reasoningEffort ?? compactReasoningEffort(asRecord(body.reasoning)?.effort)
  if (effort) result.reasoning = { ...(asRecord(result.reasoning) ?? {}), effort }
  result.tool_choice = "auto"
  result.store = false
  result.stream = true
  result.include = ["reasoning.encrypted_content"]
  return result
}

function parseJsonRecord(text: string | undefined): AnyRecord | undefined {
  if (!text) return undefined
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}

function usageFrom(value: AnyRecord | undefined): AnyRecord {
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
  }
}

function responseMessageID(responseID: string) {
  return `msg_${responseID.replace(/[^a-zA-Z0-9]/g, "_")}`
}

function compactedItemsForV2(input: unknown, compaction: AnyRecord): AnyRecord[] | undefined {
  if (!Array.isArray(input)) return undefined
  const retained = input.filter((item) => asRecord(item)?.role === "user")
  return compactedItemsFrom([...retained, compaction])
}

async function compactV2Payload(response: Response): Promise<AnyRecord | undefined> {
  const text = await response.text()
  const data: string[] = []
  let lines: string[] = []
  const flush = () => {
    if (lines.length) data.push(lines.join("\n"))
    lines = []
  }

  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    if (field !== "data") continue
    const value = separator === -1 ? "" : line.slice(separator + 1)
    lines.push(value.startsWith(" ") ? value.slice(1) : value)
  }
  flush()

  let completed: AnyRecord | undefined
  let compaction: AnyRecord | undefined
  let compactionCount = 0
  for (const value of data) {
    if (value === "[DONE]") continue
    let event: AnyRecord | undefined
    try {
      event = asRecord(JSON.parse(value))
    } catch {
      return undefined
    }
    if (
      !event ||
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      return undefined
    }
    if (event.type === "response.output_item.done") {
      const item = asRecord(event.item)
      if (item?.type === "compaction") {
        compactionCount++
        compaction ??= item
      }
    }
    if (event.type === "response.completed") {
      if (completed) return undefined
      completed = asRecord(event.response)
    }
  }

  if (
    !completed ||
    (completed.status !== undefined && completed.status !== "completed") ||
    compactionCount !== 1 ||
    !compaction ||
    typeof compaction.encrypted_content !== "string"
  ) {
    return undefined
  }
  return { ...completed, compaction }
}

function sseResponse(input: {
  responseID: string
  model: string
  createdAt: number
  summary: string
  usage?: AnyRecord
}): Response {
  const messageID = responseMessageID(input.responseID)
  const usage = usageFrom(input.usage)
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
  }
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
  }
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
  ]
  const stream = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  })
}

function messageCreatedAt(entry: MessageEntry) {
  const createdAt = entry.info?.time?.created
  return finiteNumber(createdAt) ? createdAt : undefined
}

function isOpenCodeCompactionContinuation(entry: MessageEntry) {
  return entry.parts?.some(
    (part) => part.type === "text" && part.synthetic === true && part.metadata?.compaction_continue === true,
  )
}

function selectCheckpoint(
  checkpoints: Checkpoint[],
  entries: MessageEntry[],
): { checkpoint?: Checkpoint; clearActive: boolean } {
  const messageIDs = new Set(
    entries
      .map((entry) => entry.info?.id)
      .filter((id): id is string => typeof id === "string"),
  )
  for (let index = checkpoints.length - 1; index >= 0; index--) {
    const checkpoint = checkpoints[index]
    if (messageIDs.has(checkpoint.afterMessageID)) return { checkpoint, clearActive: false }
  }

  const createdAts = entries.map(messageCreatedAt).filter((createdAt): createdAt is number => createdAt !== undefined)
  if (!createdAts.length || createdAts.length !== entries.length) {
    return { clearActive: false }
  }

  const minCreatedAt = Math.min(...createdAts)
  for (let index = checkpoints.length - 1; index >= 0; index--) {
    const checkpoint = checkpoints[index]
    if (minCreatedAt >= checkpoint.afterCreatedAt) return { checkpoint, clearActive: false }
  }

  return { clearActive: true }
}

function sessionIDFromMessages(messages: MessageEntry[]): string | undefined {
  for (const message of messages) {
    const sessionID = (message.info as AnyRecord | undefined)?.sessionID
    if (typeof sessionID === "string") return sessionID
  }
  return undefined
}

function sortCheckpoints(checkpoints: Checkpoint[]) {
  return checkpoints.sort((a, b) => a.afterCreatedAt - b.afterCreatedAt || a.createdAt - b.createdAt)
}

function getProviderSessionMap<T>(map: Map<string, Map<string, T>>, providerID: string) {
  const existing = map.get(providerID)
  if (existing) return existing

  const created = new Map<string, T>()
  map.set(providerID, created)
  return created
}

function getProviderID(input: unknown) {
  const record = asRecord(input)
  const model = asRecord(record?.model)
  if (typeof model?.providerID === "string") return model.providerID

  const provider = asRecord(record?.provider)
  if (typeof provider?.providerID === "string") return provider.providerID
  if (typeof provider?.id === "string") return provider.id
  return undefined
}

function messageProviderKey(sessionID: string, messageID: string) {
  return `${sessionID}\0${messageID}`
}

export function createCompactHooks(
  config: OpenAICompactConfig,
  store: CheckpointStore,
  baseFetch: FetchLike = fetch,
  options: CompactHookOptions = {},
): Hooks {
  store.prune(config.state.retentionDays)

  const configuredProviders = new Set(Object.keys(config.providers))
  const checkpointsByProvider = new Map<string, Map<string, Checkpoint[]>>()
  for (const { sessionID, checkpoint } of store.loadAll()) {
    const sessions = getProviderSessionMap(checkpointsByProvider, checkpoint.providerID)
    const checkpoints = sessions.get(sessionID) ?? []
    checkpoints.push(checkpoint)
    sessions.set(sessionID, sortCheckpoints(checkpoints))
  }
  const pendingCompactResults = new Map<string, PendingCompactResult>()
  const activeCheckpointByProvider = new Map<string, Map<string, Checkpoint>>()
  const stableInstructionsByProvider = new Map<string, Map<string, StableInstructions>>()
  const pendingSystemByProvider = new Map<string, Map<string, string>>()
  const providerByMessage = new Map<string, string>()
  const pendingCompactionCaptures = new Map<string, number>()
  const structuredCompactionSnapshots = new Map<string, StructuredCompactionSnapshot[]>()
  let openAIAuth: OpenAIOAuthAuth | undefined
  let openAIWrappedFetch: FetchLike | undefined
  const openAIOAuth = createOpenAIOAuth({
    getAuth: async () => openAIAuth,
    async setAuth(auth) {
      openAIAuth = auth
      await options.setOpenAIAuth?.(auth)
    },
    tokenFetch: options.tokenFetch,
  })

  function rememberMessageProvider(input: unknown, output: unknown) {
    const providerID = getProviderID(input)
    if (!providerID || !configuredProviders.has(providerID)) return

    const inputRecord = asRecord(input)
    const sessionID = inputRecord?.sessionID
    if (typeof sessionID !== "string") return

    const outputRecord = asRecord(output)
    const message = asRecord(outputRecord?.message)
    const messageID = typeof message?.id === "string" ? message.id : inputRecord?.messageID
    if (typeof messageID !== "string") return

    providerByMessage.set(messageProviderKey(sessionID, messageID), providerID)
  }

  function providerIDFromMessages(messages: MessageEntry[]) {
    for (const message of messages) {
      const sessionID = (message.info as AnyRecord | undefined)?.sessionID
      const messageID = message.info?.id
      if (typeof sessionID !== "string" || typeof messageID !== "string") continue
      const providerID = providerByMessage.get(messageProviderKey(sessionID, messageID))
      if (providerID) return providerID
    }
    return undefined
  }

  function providerIDFromTrimmedSessionCheckpoint(messages: MessageEntry[]) {
    const sessionID = sessionIDFromMessages(messages)
    if (!sessionID) return undefined

    const messageIDs = new Set(
      messages
        .map((message) => message.info?.id)
        .filter((id): id is string => typeof id === "string"),
    )
    let result: string | undefined
    for (const [providerID, sessions] of checkpointsByProvider) {
      const checkpoints = sessions.get(sessionID)
      if (!checkpoints?.length) continue
      if (checkpoints.some((checkpoint) => messageIDs.has(checkpoint.afterMessageID))) return undefined
      if (result) return undefined
      result = providerID
    }
    return result
  }

  function transformProviderID(input: unknown, messages: MessageEntry[]) {
    return getProviderID(input) ?? providerIDFromMessages(messages) ?? providerIDFromTrimmedSessionCheckpoint(messages)
  }

  function storeStableInstructions(providerID: string, sessionID: string, stable: StableInstructions) {
    const sessions = getProviderSessionMap(stableInstructionsByProvider, providerID)
    const previous = sessions.get(sessionID)
    sessions.set(sessionID, {
      instructions: stable.instructions !== undefined ? stable.instructions : previous?.instructions,
      inputPrefix: stable.inputPrefix.length ? stable.inputPrefix : (previous?.inputPrefix ?? []),
    })
  }

  function rememberStableInstructions(providerID: string, sessionID: string, body: AnyRecord | undefined) {
    const stable = stableInstructionsFrom(body)
    if (stable) storeStableInstructions(providerID, sessionID, stable)
  }

  function rememberPendingSystem(providerID: string, sessionID: string, system: unknown) {
    const sessions = getProviderSessionMap(pendingSystemByProvider, providerID)
    const instructions = instructionsFromSystem(system)
    if (instructions) sessions.set(sessionID, instructions)
    else sessions.delete(sessionID)
  }

  function promotePendingSystem(providerID: string, sessionID: string) {
    const sessions = pendingSystemByProvider.get(providerID)
    const instructions = sessions?.get(sessionID)
    if (!instructions) return
    storeStableInstructions(providerID, sessionID, { instructions, inputPrefix: [] })
    sessions?.delete(sessionID)
  }

  function addCheckpoint(
    providerID: string,
    sessionID: string,
    responseID: string,
    boundary: MessageBoundary,
    items: AnyRecord[],
  ): Checkpoint {
    const checkpoint: Checkpoint = {
      providerID,
      responseID,
      afterMessageID: boundary.messageID,
      afterCreatedAt: boundary.createdAt,
      createdAt: Date.now(),
      items,
    }
    const sessions = getProviderSessionMap(checkpointsByProvider, providerID)
    const checkpoints = sessions.get(sessionID) ?? []
    sessions.set(
      sessionID,
      sortCheckpoints([...checkpoints.filter((checkpoint) => checkpoint.responseID !== responseID), checkpoint]),
    )
    store.upsert(sessionID, checkpoint)
    store.prune(config.state.retentionDays)
    return checkpoint
  }

  function compactCheckpointFromEvent(event: AnyRecord) {
    if (event.type !== "message.part.updated") return undefined
    const properties = asRecord(event.properties)
    const sessionID = properties?.sessionID
    const pending = typeof sessionID === "string" ? pendingCompactResults.get(sessionID) : undefined
    const part = asRecord(properties?.part)
    const messageID = part?.messageID
    const createdAt = properties?.time
    if (!pending || part?.text !== config.summary) return undefined
    if (typeof sessionID !== "string" || typeof messageID !== "string" || !finiteNumber(createdAt)) return undefined
    return { providerID: pending.providerID, sessionID, responseID: pending.responseID, boundary: { messageID, createdAt } }
  }

  function trimMessagesAfterCheckpoint(providerID: string, messages: MessageEntry[]) {
    const sessionID = sessionIDFromMessages(messages)
    const checkpoints = sessionID ? checkpointsByProvider.get(providerID)?.get(sessionID) : undefined
    if (!sessionID || !checkpoints) return

    const { checkpoint, clearActive } = selectCheckpoint(checkpoints, messages)
    const activeCheckpoints = getProviderSessionMap(activeCheckpointByProvider, providerID)
    if (checkpoint) {
      activeCheckpoints.set(sessionID, checkpoint)
    } else if (clearActive && pendingCompactResults.get(sessionID)?.providerID !== providerID) {
      activeCheckpoints.delete(sessionID)
    }
    if (!checkpoint) return

    const index = messages.findIndex((message) => message.info?.id === checkpoint.afterMessageID)
    if (index === -1) return

    const trimmed = messages.slice(index + 1).filter((message) => !isOpenCodeCompactionContinuation(message))
    messages.splice(0, messages.length, ...trimmed)
  }

  function takeStructuredSnapshot(sessionID: string) {
    const snapshots = structuredCompactionSnapshots.get(sessionID)
    const snapshot = snapshots?.shift()
    if (!snapshots?.length) structuredCompactionSnapshots.delete(sessionID)
    return snapshot
  }

  function clearStructuredCapture(sessionID: string) {
    pendingCompactionCaptures.delete(sessionID)
    structuredCompactionSnapshots.delete(sessionID)
  }

  function structuredInputFor(
    providerID: string,
    sessionID: string,
    sourceModel: string,
    snapshot: StructuredCompactionSnapshot | undefined,
  ) {
    const messages = snapshot?.messages ? cloneMessages(snapshot.messages) : undefined
    if (!messages) return undefined

    try {
      trimMessagesAfterCheckpoint(providerID, messages)
      const history = structuredOpenAIInput(messages, providerID, sourceModel)
      if (!history) return undefined

      const checkpoint = activeCheckpointByProvider.get(providerID)?.get(sessionID)
      return checkpoint ? [...structuredClone(checkpoint.items), ...history] : history
    } catch {
      return undefined
    }
  }

  async function initWithCompactedInput(
    providerID: string,
    requestInput: RequestInfo | URL,
    init: RequestInit | undefined,
    headers: Headers,
    sessionID: string,
  ): Promise<RequestInit> {
    const body = parseJsonRecord(await bodyText(requestInput, init))
    if (!body || !Array.isArray(body.input)) {
      return fetchInitForReroute(requestInput, init, headers)
    }

    const checkpoint = activeCheckpointByProvider.get(providerID)?.get(sessionID)
    if (!checkpoint) return fetchInitForReroute(requestInput, init, headers)

    headers.set("content-type", "application/json")
    const input = postCompactionInput(body.input, config.summary)
    const next = {
      ...body,
      input: [...structuredClone(checkpoint.items), ...input],
    }
    return { ...fetchInitForReroute(requestInput, init, headers), body: JSON.stringify(next) }
  }

  function wrapFetch(base: FetchLike, providerID: string, provider: ProviderConfig): FetchLike {
    const previousBase = (base as unknown as AnyRecord)[wrappedBaseFetch]
    const baseFetch = typeof previousBase === "function" ? (previousBase as FetchLike) : base

    const wrapped = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(requestInput)
      const headers = requestHeaders(requestInput, init)
      const { sessionID: headerSessionID, shouldCompact } = compactMarkers(headers, config)
      const isResponsesRequest = url ? isResponsesUrl(url, config) : false
      const outboundHeaders = cleanedHeaders(headers, config)

      if (!isResponsesRequest) {
        return baseFetch(requestInput, fetchInit(init, outboundHeaders))
      }

      const sessionID = headerSessionID
      if (shouldCompact && !sessionID) {
        return new Response("OpenAI compact request is missing session header", { status: 400 })
      }

      const requestInit = sessionID
        ? await initWithCompactedInput(providerID, requestInput, init, outboundHeaders, sessionID)
        : fetchInitForReroute(requestInput, init, outboundHeaders)
      const openAIOAuthRequestInit = usesOpenAIOAuth(providerID, new Headers(requestInit.headers))
        ? await openAIOAuth.requestInit(requestInit)
        : undefined
      const routedRequestInput = openAIOAuthRequestInit ? chatGPTCodexResponsesEndpoint : requestInput
      const routedRequestInit = openAIOAuthRequestInit ?? requestInit
      if (!sessionID) {
        return baseFetch(routedRequestInput, routedRequestInit)
      }

      const body = parseJsonRecord(typeof routedRequestInit.body === "string" ? routedRequestInit.body : undefined)
      if (!shouldCompact) {
        rememberStableInstructions(providerID, sessionID, body)
        return baseFetch(routedRequestInput, routedRequestInit)
      }

      if (typeof body?.model !== "string" || !Array.isArray(body.input) || !url) {
        clearStructuredCapture(sessionID)
        return baseFetch(routedRequestInput, routedRequestInit)
      }

      const snapshot = takeStructuredSnapshot(sessionID)
      const conversation = snapshot?.conversation?.providerID === providerID ? snapshot.conversation : undefined
      const selectedModel = provider.compactModel ?? conversation?.modelID ?? body.model
      const selectedReasoningEffort =
        provider.compactReasoningEffort ??
        conversation?.reasoningEffort ??
        compactReasoningEffort(asRecord(body.reasoning)?.effort) ??
        null
      const structuredInput = structuredInputFor(providerID, sessionID, selectedModel, snapshot)
      if (!structuredInput) clearStructuredCapture(sessionID)
      if (!structuredInput && !isKnownOpenCodeCompactionBody(body)) {
        return baseFetch(routedRequestInput, routedRequestInit)
      }

      const outboundCompactHeaders = new Headers(routedRequestInit.headers)
      outboundCompactHeaders.set("content-type", "application/json")
      const compactBodyWithHistory = compactBody(body, selectedModel, config, selectedReasoningEffort)
      delete compactBodyWithHistory.instructions
      if (structuredInput) compactBodyWithHistory.input = [...structuredInput, { type: "compaction_trigger" }]
      const compactRequestBody = withStableInstructions(
        compactBodyWithHistory,
        stableInstructionsByProvider.get(providerID)?.get(sessionID),
        config.compactBodyKeys.includes("instructions"),
      )
      const compacted = await baseFetch(routedRequestInput, {
        ...routedRequestInit,
        method: "POST",
        headers: outboundCompactHeaders,
        body: JSON.stringify(compactRequestBody),
      })
      if (!compacted.ok) {
        return compacted
      }

      const payload = await compactV2Payload(compacted.clone()).catch(() => undefined)
      const compaction = asRecord(payload?.compaction)
      const items = compaction ? compactedItemsForV2(compactRequestBody.input, compaction) : undefined
      if (!items) {
        return new Response("OpenAI compact response stream must complete with exactly one valid compaction item", {
          status: 502,
        })
      }
      const responseID = typeof payload?.id === "string" ? payload.id : undefined
      if (!responseID) {
        return new Response("OpenAI compact response.completed event must contain a response id", { status: 502 })
      }

      const checkpoint = addCheckpoint(
        providerID,
        sessionID,
        responseID,
        { messageID: responseMessageID(responseID), createdAt: Date.now() },
        items,
      )
      pendingCompactResults.set(sessionID, { providerID, responseID, items })
      getProviderSessionMap(activeCheckpointByProvider, providerID).set(sessionID, checkpoint)
      return sseResponse({
        responseID,
        model: typeof payload?.model === "string" ? payload.model : selectedModel,
        createdAt: typeof payload?.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000),
        summary: config.summary,
        usage: asRecord(payload?.usage),
      })
    }) as FetchLike

    Object.defineProperty(wrapped, wrappedFetch, { value: true })
    Object.defineProperty(wrapped, wrappedBaseFetch, { value: baseFetch })
    return wrapped
  }

  function getOpenAIWrappedFetch(base: FetchLike = baseFetch) {
    const provider = config.providers.openai
    if (!provider) return undefined
    openAIWrappedFetch ??= wrapFetch(base, "openai", provider)
    return openAIWrappedFetch
  }

  async function handleEvent(event: AnyRecord) {
    if (event.type === "session.deleted") {
      const sessionID = asRecord(event.properties)?.sessionID
      if (typeof sessionID !== "string") return
      for (const sessions of checkpointsByProvider.values()) sessions.delete(sessionID)
      pendingCompactResults.delete(sessionID)
      for (const sessions of activeCheckpointByProvider.values()) sessions.delete(sessionID)
      for (const sessions of stableInstructionsByProvider.values()) sessions.delete(sessionID)
      for (const sessions of pendingSystemByProvider.values()) sessions.delete(sessionID)
      clearStructuredCapture(sessionID)
      for (const key of providerByMessage.keys()) {
        if (key.startsWith(`${sessionID}\0`)) providerByMessage.delete(key)
      }
      if (config.state.deleteOnSessionDeleted) store.deleteSession(sessionID)
      return
    }

    if (event.type === "message.removed") {
      const properties = asRecord(event.properties)
      const sessionID = properties?.sessionID
      const messageID = properties?.messageID
      if (typeof sessionID !== "string" || typeof messageID !== "string") return

      providerByMessage.delete(messageProviderKey(sessionID, messageID))
      clearStructuredCapture(sessionID)
      for (const [providerID, sessions] of checkpointsByProvider) {
        const checkpoints = sessions.get(sessionID)
        if (!checkpoints) continue

        const removed = checkpoints.filter((checkpoint) => checkpoint.afterMessageID === messageID)
        if (!removed.length) continue

        const remaining = checkpoints.filter((checkpoint) => checkpoint.afterMessageID !== messageID)
        if (remaining.length) sessions.set(sessionID, remaining)
        else sessions.delete(sessionID)

        const activeCheckpoints = activeCheckpointByProvider.get(providerID)
        if (activeCheckpoints?.get(sessionID)?.afterMessageID === messageID) activeCheckpoints.delete(sessionID)
        for (const checkpoint of removed) store.deleteCheckpoint(sessionID, providerID, checkpoint.responseID)
      }
      return
    }

    const compact = compactCheckpointFromEvent(event)
    if (!compact) return
    const pending = pendingCompactResults.get(compact.sessionID)
    if (pending?.responseID !== compact.responseID) return
    pendingCompactResults.delete(compact.sessionID)
    const checkpoint = addCheckpoint(compact.providerID, compact.sessionID, compact.responseID, compact.boundary, pending.items)
    getProviderSessionMap(activeCheckpointByProvider, compact.providerID).set(compact.sessionID, checkpoint)
  }

  const hooks: Hooks = {
    auth: {
      provider: "openai",
      methods: openAIAuthMethods,
      async loader(getAuth) {
        const auth = await getAuth()
        openAIAuth = asOpenAIOAuth(auth)
        const apiAuth = asRecord(auth)
        const fetch = getOpenAIWrappedFetch()
        if (openAIAuth) return { apiKey: openAIOAuthDummyKey, ...(fetch ? { fetch } : {}) }
        if (apiAuth?.type === "api" && typeof apiAuth.key === "string") {
          return { apiKey: apiAuth.key, ...(fetch ? { fetch } : {}) }
        }
        return {}
      },
    },

    async dispose() {
      store.close()
    },

    async config(cfg) {
      const root = cfg as AnyRecord
      root.provider ??= {}
      const providers = root.provider as AnyRecord
      for (const [providerID, compactProvider] of Object.entries(config.providers)) {
        providers[providerID] ??= {}
        const provider = providers[providerID] as AnyRecord
        provider.options ??= {}
        const options = provider.options as AnyRecord
        const currentFetch = (options.fetch as FetchLike | undefined) ?? baseFetch
        options.fetch =
          providerID === "openai"
            ? getOpenAIWrappedFetch(currentFetch)
            : wrapFetch(currentFetch, providerID, compactProvider)
      }
    },

    async event(input) {
      await handleEvent(input.event as AnyRecord)
    },

    "chat.message": async (input, output) => {
      rememberMessageProvider(input, output)
    },

    "chat.headers": async (input, output) => {
      const providerID = getProviderID(input)
      if (!providerID || !configuredProviders.has(providerID)) return
      if (typeof input.sessionID !== "string") return

      if (input.agent === "compaction") {
        pendingSystemByProvider.get(providerID)?.delete(input.sessionID)
        output.headers[config.headers.session] = input.sessionID
        output.headers[config.headers.compact] = "1"
        return
      }

      if (utilityAgents.has(input.agent)) {
        pendingSystemByProvider.get(providerID)?.delete(input.sessionID)
        return
      }

      promotePendingSystem(providerID, input.sessionID)
      output.headers[config.headers.session] = input.sessionID
    },

    "experimental.chat.messages.transform": async (input, output) => {
      const messages = output.messages as unknown as MessageEntry[]
      const sessionID = sessionIDFromMessages(messages)
      const pendingCaptures = sessionID ? pendingCompactionCaptures.get(sessionID) : undefined
      const snapshot = pendingCaptures
        ? { messages: cloneMessages(messages), conversation: conversationSettingsFrom(messages) }
        : undefined
      const providerID = transformProviderID(input, messages)
      if (providerID && configuredProviders.has(providerID)) trimMessagesAfterCheckpoint(providerID, messages)
      if (sessionID && pendingCaptures && snapshot) {
        if (pendingCaptures === 1) pendingCompactionCaptures.delete(sessionID)
        else pendingCompactionCaptures.set(sessionID, pendingCaptures - 1)
        const snapshots = structuredCompactionSnapshots.get(sessionID) ?? []
        snapshots.push(snapshot)
        structuredCompactionSnapshots.set(sessionID, snapshots)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const providerID = getProviderID(input)
      if (!providerID || !configuredProviders.has(providerID)) return
      if (typeof input.sessionID !== "string") return
      rememberPendingSystem(providerID, input.sessionID, output.system)
    },

    "experimental.session.compacting": async (input) => {
      if (typeof input.sessionID !== "string") return
      pendingCompactionCaptures.set(input.sessionID, (pendingCompactionCaptures.get(input.sessionID) ?? 0) + 1)
    },
  }

  return hooks
}
