import { describe, expect, test } from "vitest"
import { compactBody, compactedItemsFrom, createCompactHooks } from "../src/compact.js"
import { defaultConfig, OpenAICompactConfigSchema } from "../src/schema.js"
import { CheckpointStore } from "../src/state.js"

function jsonBody(init: RequestInit | undefined) {
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}")
}

function compactResponse(payload: any) {
  const events = [
    ...(payload.output ?? []).map((item: any) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { ...payload, output: undefined } },
  ]
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const compactionInstructions = "You are an anchored context summarization assistant for coding sessions."
const currentModel = "gpt-current"
const embeddedOpenCodeHistory = [
  "Here is the conversation so far:",
  "<conversation>",
  "[User]: preserved history",
  "[Assistant]: preserved response",
  "</conversation>",
  "Here is the summary of the conversation before the <conversation> above:",
].join("\n\n")

function invalidCheckpointItems() {
  return [
    { role: "user", content: embeddedOpenCodeHistory },
    { type: "compaction", encrypted_content: "invalid-checkpoint" },
  ]
}

describe("OpenAI compact hooks", () => {
  test("defaults to following the conversation model and reasoning effort", () => {
    expect(defaultConfig.providers.openai).toEqual({
      compactModel: null,
      compactReasoningEffort: null,
    })
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(
        OpenAICompactConfigSchema.parse({ providers: { openai: { compactReasoningEffort: effort } } }).providers
          .openai,
      ).toEqual({ compactModel: null, compactReasoningEffort: effort })
    }
    expect(() =>
      OpenAICompactConfigSchema.parse({ providers: { openai: { compactReasoningEffort: "unsupported" } } }),
    ).toThrow()
  })

  test("wraps the configured provider fetch", async () => {
    const store = CheckpointStore.openMemory()
    try {
      const hooks = createCompactHooks(defaultConfig, store)
      const cfg: any = {}

      await hooks.config?.(cfg)

      expect(typeof cfg.provider.openai.options.fetch).toBe("function")
    } finally {
      store.close()
    }
  })

  test("builds compaction v2 request body", () => {
    const body = compactBody({
      model: "ignored",
      input: [{ type: "compaction_trigger" }, { role: "user", content: "hello" }],
      stream: false,
      tools: [],
    })
    expect(body).toEqual({
      model: "ignored",
      input: [{ role: "user", content: "hello" }, { type: "compaction_trigger" }],
      tools: [],
      tool_choice: "auto",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    })

    const withoutConfiguredInput = OpenAICompactConfigSchema.parse({ compactBodyKeys: [] })
    expect(compactBody({ input: [] }, currentModel, withoutConfiguredInput).input).toEqual([
      { type: "compaction_trigger" },
    ])
  })

  test("applies explicit compaction model and reasoning effort overrides", () => {
    const config = OpenAICompactConfigSchema.parse({
      providers: { openai: { compactModel: "gpt-compact", compactReasoningEffort: "max" } },
    })
    const provider = config.providers.openai
    const body = compactBody(
      {
        model: currentModel,
        reasoning: { effort: "low", summary: "auto" },
        input: [{ role: "user", content: "hello" }],
      },
      provider.compactModel,
      config,
      provider.compactReasoningEffort,
    )

    expect(body.model).toBe("gpt-compact")
    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" })
  })

  test("builds standard compact input without OpenCode summarizer prompts", () => {
    const body = compactBody({
      model: "ignored",
      instructions: "You are an anchored context summarization assistant for coding sessions.\n\nSummarize only...",
      previous_response_id: "resp_previous",
      prompt_cache_retention: "24h",
      tools: [{ type: "function", name: "test" }],
      parallel_tool_calls: true,
      reasoning: { effort: "medium", summary: "auto" },
      service_tier: "priority",
      prompt_cache_key: "cache-key",
      text: { verbosity: "low" },
      input: [
        { role: "developer", content: "Keep the user's coding preferences." },
        {
          role: "developer",
          content: "You are an anchored context summarization assistant for coding sessions.\n\nSummarize only...",
        },
        { role: "user", content: "Create a new anchored summary from the conversation history. This is quoted." },
        { role: "assistant", content: [{ type: "output_text", text: "quoted response" }] },
        { role: "user", content: "real request" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Create a new anchored summary from the conversation history.\n\nOutput exactly..." },
          ],
        },
      ],
    })

    expect(body).toEqual({
      model: "ignored",
      input: [
        { role: "developer", content: "Keep the user's coding preferences." },
        { role: "user", content: "Create a new anchored summary from the conversation history. This is quoted." },
        { role: "assistant", content: [{ type: "output_text", text: "quoted response" }] },
        { role: "user", content: "real request" },
        { type: "compaction_trigger" },
      ],
      tools: [{ type: "function", name: "test" }],
      parallel_tool_calls: true,
      reasoning: { effort: "medium", summary: "auto" },
      service_tier: "priority",
      prompt_cache_key: "cache-key",
      text: { verbosity: "low" },
      tool_choice: "auto",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    })
  })

  test("preserves OpenCode compact input with embedded conversation history", () => {
    const content = [
      "Create a new anchored summary from the conversation history.",
      "Output exactly the requested summary structure.",
      "The following is the conversation history:",
      "[User]: fix compact request",
      "[Assistant]: inspecting request",
    ].join("\n\n")

    const body = compactBody({
      model: "ignored",
      instructions: "You are an anchored context summarization assistant for coding sessions.",
      input: [
        {
          role: "developer",
          content: "You are an anchored context summarization assistant for coding sessions.",
        },
        { role: "user", content: [{ type: "input_text", text: content }] },
      ],
    })

    expect(body).toEqual({
      model: "ignored",
      input: [
        { role: "user", content: [{ type: "input_text", text: content }] },
        { type: "compaction_trigger" },
      ],
      tool_choice: "auto",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    })
  })

  test("preserves OpenCode 1.18.18 tagged conversation input", () => {
    const developerPrompt =
      "You are a context summarization agent. You are given a conversation between a user and an agent."
    const content = [
      "Here is the conversation so far:",
      "<conversation>",
      "[User]: fix compact request",
      "[Assistant]: inspecting request",
      "</conversation>",
      "Here is the summary of the conversation before the <conversation> above:",
      "<prior-summary>",
      "## Objective\n- Preserve the task",
      "</prior-summary>",
    ].join("\n\n")

    expect(
      compactBody({
        model: "ignored",
        instructions: developerPrompt,
        input: [
          { role: "developer", content: developerPrompt },
          { role: "user", content: [{ type: "input_text", text: content }] },
        ],
      }),
    ).toEqual({
      model: "ignored",
      input: [
        { role: "user", content: [{ type: "input_text", text: content }] },
        { type: "compaction_trigger" },
      ],
      tool_choice: "auto",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    })
  })

  test("restores structured compact input without inspecting the serialized prompt", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_structured",
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch
      const sessionID = "ses_structured"

      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        {},
        {
          messages: [
            {
              info: { id: "msg_user", sessionID, role: "user" },
              parts: [
                { type: "text", text: "fix compact request" },
                { type: "file", mime: "image/png", filename: "request.png", url: "data:image/png;base64,AA==" },
              ],
            },
            {
              info: {
                id: "msg_assistant",
                sessionID,
                role: "assistant",
                providerID: "openai",
                modelID: currentModel,
              },
              parts: [
                {
                  type: "reasoning",
                  text: "Inspected the request.",
                  metadata: {
                    openai: { itemId: "rs_structured", reasoningEncryptedContent: "encrypted-reasoning" },
                  },
                },
                {
                  type: "text",
                  text: "The request loses history.",
                  metadata: { openai: { itemId: "msg_structured", phase: "final_answer" } },
                },
                {
                  type: "tool",
                  tool: "read_file",
                  callID: "call_structured",
                  state: {
                    status: "completed",
                    input: { path: "src/compact.ts" },
                    output: "file contents",
                    time: { start: 1, end: 2 },
                  },
                },
              ],
            },
          ],
        } as any,
      )

      const embedded = "Unrecognized future compaction format with flattened history that must not be sent"
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify({
          model: currentModel,
          instructions: "Unrecognized future compaction agent instructions.",
          input: [{ role: "user", content: [{ type: "input_text", text: embedded }] }],
        }),
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: currentModel,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "fix compact request" },
              { type: "input_text", text: "[Attached image/png: request.png]" },
            ],
          },
          {
            type: "reasoning",
            id: "rs_structured",
            encrypted_content: "encrypted-reasoning",
            summary: [{ type: "summary_text", text: "Inspected the request." }],
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "The request loses history." }],
            id: "msg_structured",
            phase: "final_answer",
          },
          {
            type: "function_call",
            call_id: "call_structured",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/compact.ts" }),
          },
          { type: "function_call_output", call_id: "call_structured", output: "file contents" },
          { type: "compaction_trigger" },
        ],
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      })
    } finally {
      store.close()
    }
  })

  test("follows the latest conversation settings without inspecting the serialized prompt", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ init?: RequestInit }> = []
    const fakeFetch = (async (_requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      return compactResponse({
        id: "resp_follow_conversation",
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const sessionID = "ses_follow_conversation"

      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        {},
        {
          messages: [
            {
              info: {
                id: "msg_old",
                sessionID,
                role: "assistant",
                providerID: "openai",
                modelID: "gpt-old",
                variant: "low",
              },
              parts: [{ type: "text", text: "old response" }],
            },
            {
              info: {
                id: "msg_latest",
                sessionID,
                role: "user",
                model: { providerID: "openai", modelID: "gpt-latest", variant: "xhigh" },
              },
              parts: [{ type: "text", text: "latest request" }],
            },
          ],
        } as any,
      )

      const embedded = "Unrecognized future compaction format with flattened history"
      await cfg.provider.openai.options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify({
          model: "compaction-agent-model",
          instructions: "Unrecognized future compaction agent instructions.",
          reasoning: { effort: "medium", summary: "auto" },
          input: [{ role: "user", content: embedded }],
        }),
      })

      const body = jsonBody(calls[0]?.init)
      expect(body.model).toBe("gpt-latest")
      expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" })
    } finally {
      store.close()
    }
  })

  test("orders stable instructions, checkpoint, and restored structured history", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      const call = calls.length
      return compactResponse({
        id: `resp_${call}`,
        created_at: call,
        output: [{ id: `cmp_${call}`, type: "compaction", encrypted_content: `compacted-${call}` }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch
      const sessionID = "ses_structured_checkpoint"

      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: sessionID },
        body: JSON.stringify({
          model: "gpt",
          instructions: "You are OpenCode.",
          input: [{ role: "developer", content: "Stable developer context." }, { role: "user", content: "hello" }],
        }),
      })
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: "You are an anchored context summarization assistant for coding sessions.",
          input: [
            {
              role: "developer",
              content: "You are an anchored context summarization assistant for coding sessions.",
            },
            { role: "user", content: "old history" },
            { role: "user", content: "Create a new anchored summary from the conversation history." },
          ],
        }),
      })

      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: { id: "msg_tail", sessionID, role: "user" },
              parts: [{ type: "text", text: "structured tail" }],
            },
          ],
        } as any,
      )

      const embedded = [
        "Create a new anchored summary from the conversation history.",
        "The following is the conversation history:",
        "[User]: flattened tail",
      ].join("\n\n")
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: "You are an anchored context summarization assistant for coding sessions.",
          input: [{ role: "user", content: embedded }],
        }),
      })

      expect(jsonBody(calls.at(-1)?.init)).toEqual({
        model: "ignored",
        instructions: "You are OpenCode.",
        input: [
          { role: "developer", content: "Stable developer context." },
          { role: "user", content: "old history" },
          { id: "cmp_2", type: "compaction", encrypted_content: "compacted-2" },
          { role: "user", content: [{ type: "input_text", text: "structured tail" }] },
          { type: "compaction_trigger" },
        ],
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      })
    } finally {
      store.close()
    }
  })

  test("reuses a persisted checkpoint when repeated compaction omits the prior boundary", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ init?: RequestInit }> = []
    const fakeFetch = (async (_requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      return compactResponse({
        id: "resp_repeated",
        model: "gpt",
        output: [{ type: "compaction", encrypted_content: "repeated" }],
      })
    }) as typeof fetch
    const sessionID = "ses_repeated_without_boundary"
    const now = Date.now()
    store.upsert(sessionID, {
      providerID: "openai",
      responseID: "resp_previous",
      afterMessageID: "msg_hidden_boundary",
      afterCreatedAt: now,
      createdAt: now,
      items: [
        { role: "user", content: "previous history" },
        { type: "compaction", encrypted_content: "previous" },
      ],
    })
    store.upsertControlMessage({
      providerID: "openai",
      sessionID,
      messageID: "msg_old_continue",
      createdAt: now + 1,
      contentText: "old internal request",
    })

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: { id: "msg_old_continue", sessionID, role: "user", time: { created: now + 1 } },
              parts: [{ type: "text", text: "text and metadata changed" }],
            },
            {
              info: {
                id: "msg_tail",
                sessionID,
                role: "user",
                model: { providerID: "openai", modelID: "gpt" },
                time: { created: now + 2 },
              },
              parts: [{ type: "text", text: "retained tail" }],
            },
          ],
        } as any,
      )
      const headers = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        {
          sessionID,
          agent: "another-internal-name",
          model: { providerID: "openai" },
          message: { id: "msg_new_compaction", time: { created: now + 3 }, agent: "build" },
        } as any,
        headers,
      )
      await cfg.provider.openai.options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: headers.headers,
        body: JSON.stringify({
          model: "ignored",
          instructions: "Completely changed OpenCode compaction prompt.",
          input: [{ role: "user", content: "Unknown flattened format." }],
        }),
      })

      expect(jsonBody(calls[0]?.init).input).toEqual([
        { role: "user", content: "previous history" },
        { type: "compaction", encrypted_content: "previous" },
        { role: "user", content: [{ type: "input_text", text: "retained tail" }] },
        { type: "compaction_trigger" },
      ])
    } finally {
      store.close()
    }
  })

  test("falls back to embedded history when structured messages cannot be cloned", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_fallback",
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch
      const sessionID = "ses_structured_fallback"

      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        {},
        {
          messages: [
            {
              info: { id: "msg_uncloneable", sessionID, role: "user" },
              parts: [{ type: "text", text: "history", metadata: { uncloneable: () => undefined } }],
            },
          ],
        } as any,
      )

      const embedded = [
        "Here is the conversation so far:",
        "<conversation>",
        "[User]: preserved fallback history",
        "</conversation>",
        "Here is the summary of the conversation before the <conversation> above:",
        "<prior-summary>",
        "## Objective\n- Preserve the fallback",
        "</prior-summary>",
      ].join("\n\n")
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify({
          model: "ignored",
          instructions:
            "You are a context summarization agent. You are given a conversation between a user and an agent.",
          input: [{ role: "user", content: embedded }],
        }),
      })

      expect(jsonBody(calls[0]?.init)).toEqual({
        model: "ignored",
        input: [{ role: "user", content: embedded }, { type: "compaction_trigger" }],
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      })
    } finally {
      store.close()
    }
  })

  test("fails closed when a captured compaction transaction cannot clone its history", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ init?: RequestInit }> = []
    const fakeFetch = (async (_requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      return new Response("must not be called")
    }) as typeof fetch
    const sessionID = "ses_failed_transaction_capture"

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: { id: "msg_uncloneable", sessionID, role: "user" },
              parts: [{ type: "text", text: "history", metadata: { uncloneable: () => undefined } }],
            },
          ],
        } as any,
      )
      const headers = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        {
          sessionID,
          agent: "changed-compaction-agent",
          model: { providerID: "openai" },
          message: { id: "msg_compaction", time: { created: Date.now() }, agent: "build" },
        } as any,
        headers,
      )
      const response = await cfg.provider.openai.options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: headers.headers,
        body: JSON.stringify({ model: "gpt", input: [{ role: "user", content: "changed prompt" }] }),
      })

      expect(response.status).toBe(502)
      expect(await response.text()).toContain("could not be captured safely")
      expect(calls).toEqual([])
      expect(store.count()).toBe(0)
    } finally {
      store.close()
    }
  })

  test("uses native compaction for an invalid checkpoint, clears its session state, then resumes plugin compaction", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ init?: RequestInit }> = []
    let callCount = 0
    const fakeFetch = (async (_requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      callCount++
      if (callCount === 2) return new Response("checkpoint rejected", { status: 422 })
      if (callCount === 3) return new Response("native summary", { status: 200 })
      if (jsonBody(init).input?.at(-1)?.type === "compaction_trigger") {
        return compactResponse({
          id: "resp_after_native",
          model: currentModel,
          created_at: 1,
          output: [{ type: "compaction", encrypted_content: "healthy-checkpoint" }],
        })
      }
      return new Response("ok")
    }) as typeof fetch
    const sessionID = "ses_invalid_checkpoint_native_fallback"
    const now = Date.now()
    store.upsert(sessionID, {
      providerID: "openai",
      responseID: "resp_invalid_checkpoint",
      afterMessageID: "msg_invalid_checkpoint",
      afterCreatedAt: now,
      createdAt: now,
      items: invalidCheckpointItems(),
    })
    store.upsertControlMessage({
      providerID: "openai",
      sessionID,
      messageID: "msg_old_control",
      createdAt: now,
      contentText: "old control",
    })

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)

      await cfg.provider.openai.options.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: sessionID },
        body: JSON.stringify({ model: currentModel, input: [{ role: "user", content: "before checkpoint check" }] }),
      })
      expect(jsonBody(calls[0]?.init).input).toEqual([{ role: "user", content: "before checkpoint check" }])

      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: { id: "msg_invalid_checkpoint", sessionID, role: "user", time: { created: now } },
              parts: [{ type: "compaction" }],
            },
            {
              info: {
                id: "msg_invalid_summary",
                sessionID,
                role: "assistant",
                parentID: "msg_invalid_checkpoint",
                summary: true,
                time: { created: now + 1 },
              },
              parts: [{ type: "text", text: defaultConfig.summary }],
            },
            {
              info: {
                id: "msg_native_tail",
                sessionID,
                role: "user",
                model: { providerID: "openai", modelID: currentModel },
                time: { created: now + 2 },
              },
              parts: [{ type: "text", text: "tail for native summary" }],
            },
          ],
        } as any,
      )
      const nativeHeaders = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        {
          sessionID,
          agent: "renamed-compaction-agent",
          model: { providerID: "openai" },
          message: { id: "msg_native_compaction", time: { created: now + 3 }, agent: "build" },
        } as any,
        nativeHeaders,
      )
      expect(nativeHeaders.headers[defaultConfig.headers.compact]).toBe("native")

      const nativeBody = {
        model: currentModel,
        instructions: compactionInstructions,
        input: [{ role: "user", content: "OpenCode native compaction request" }],
      }
      const nativeResponse = await cfg.provider.openai.options.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: nativeHeaders.headers,
        body: JSON.stringify(nativeBody),
      })

      expect(await nativeResponse.text()).toBe("native summary")
      expect(jsonBody(calls[1]?.init).input).toEqual([
        ...invalidCheckpointItems(),
        { role: "user", content: "OpenCode native compaction request" },
      ])
      expect(jsonBody(calls[2]?.init)).toEqual(nativeBody)
      expect(store.count()).toBe(1)
      expect(store.loadControlMessages()).toHaveLength(1)

      await hooks.event?.({ event: { type: "session.compacted", properties: { sessionID } } as any })
      expect(store.count()).toBe(0)
      expect(store.loadControlMessages()).toEqual([])

      await cfg.provider.openai.options.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: sessionID },
        body: JSON.stringify({ model: currentModel, input: [{ role: "user", content: "after native compaction" }] }),
      })
      expect(jsonBody(calls[3]?.init).input).toEqual([{ role: "user", content: "after native compaction" }])

      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: {
                id: "msg_healthy_history",
                sessionID,
                role: "user",
                model: { providerID: "openai", modelID: currentModel },
                time: { created: now + 4 },
              },
              parts: [{ type: "text", text: "healthy history" }],
            },
          ],
        } as any,
      )
      const pluginHeaders = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        {
          sessionID,
          agent: "renamed-compaction-agent",
          model: { providerID: "openai" },
          message: { id: "msg_plugin_compaction", time: { created: now + 5 }, agent: "build" },
        } as any,
        pluginHeaders,
      )
      expect(pluginHeaders.headers[defaultConfig.headers.compact]).toBe("1")

      await cfg.provider.openai.options.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: pluginHeaders.headers,
        body: JSON.stringify({ model: currentModel, instructions: compactionInstructions, input: [] }),
      })
      expect(store.loadAll().map((entry) => entry.checkpoint.responseID)).toEqual(["resp_after_native"])
    } finally {
      store.close()
    }
  })

  test("keeps session state when native fallback and its checkpoint-free retry both fail", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ init?: RequestInit }> = []
    const fakeFetch = (async (_requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      return calls.length === 1
        ? new Response("checkpoint rejected", { status: 400 })
        : new Response("native failed", { status: 500 })
    }) as typeof fetch
    const sessionID = "ses_failed_native_fallback"
    const now = Date.now()
    store.upsert(sessionID, {
      providerID: "openai",
      responseID: "resp_failed_native",
      afterMessageID: "msg_failed_native",
      afterCreatedAt: now,
      createdAt: now,
      items: invalidCheckpointItems(),
    })
    store.upsertControlMessage({
      providerID: "openai",
      sessionID,
      messageID: "msg_failed_control",
      createdAt: now,
      contentText: "failed control",
    })

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: { id: "msg_failed_native", sessionID, role: "user", time: { created: now } },
              parts: [{ type: "compaction" }],
            },
          ],
        } as any,
      )
      const headers = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        {
          sessionID,
          agent: "compaction",
          model: { providerID: "openai" },
          message: { id: "msg_retry_failure", time: { created: now + 1 }, agent: "build" },
        } as any,
        headers,
      )
      const response = await cfg.provider.openai.options.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: headers.headers,
        body: JSON.stringify({ model: currentModel, input: [{ role: "user", content: "native request" }] }),
      })

      expect(response.status).toBe(400)
      expect(calls).toHaveLength(2)
      await hooks.event?.({ event: { type: "session.compacted", properties: { sessionID } } as any })
      expect(store.count()).toBe(1)
      expect(store.loadControlMessages()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test("passes through an unknown compaction format after capture fails and clears its state", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return new Response("original summary response", { status: 200 })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const sessionID = "ses_unknown_compaction"
      await hooks["experimental.session.compacting"]?.(
        { sessionID } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        {},
        {
          messages: [
            {
              info: { id: "msg_uncloneable_unknown", sessionID, role: "user" },
              parts: [{ type: "text", text: "history", metadata: { uncloneable: () => undefined } }],
            },
          ],
        } as any,
      )
      const body = {
        model: currentModel,
        instructions: "Unknown future summarizer instructions.",
        input: [{ role: "user", content: "Unknown future serialized summary request." }],
      }
      const response = await cfg.provider.openai.options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify(body),
      })

      expect(await response.text()).toBe("original summary response")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses")
      expect(jsonBody(calls[0]?.init)).toEqual(body)
      expect(new Headers(calls[0]?.init?.headers).has(defaultConfig.headers.compact)).toBe(false)
      expect(new Headers(calls[0]?.init?.headers).has(defaultConfig.headers.session)).toBe(false)
      expect(store.count()).toBe(0)

      await hooks["experimental.chat.messages.transform"]?.(
        {},
        {
          messages: [
            {
              info: { id: "msg_after_failed_capture", sessionID, role: "user" },
              parts: [{ type: "text", text: "must not become a stale snapshot" }],
            },
          ],
        } as any,
      )
      const second = await cfg.provider.openai.options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify(body),
      })
      expect(await second.text()).toBe("original summary response")
      expect(store.count()).toBe(0)
    } finally {
      store.close()
    }
  })

  test("normalizes exactly one compaction while preserving passthrough fields", () => {
    expect(
      compactedItemsFrom([
        { type: "message", role: "developer", content: "stale developer context" },
        { type: "message", role: "system", content: "stale system context" },
        { type: "message", role: "user", content: "retained user" },
        {
          id: "cmp_123",
          type: "compaction_summary",
          encrypted_content: "compacted",
          internal_chat_message_metadata_passthrough: { turn_id: "turn_123" },
          status: "completed",
        },
      ]),
    ).toEqual([
      { type: "message", role: "user", content: "retained user" },
      {
        id: "cmp_123",
        type: "compaction",
        encrypted_content: "compacted",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_123" },
        status: "completed",
      },
    ])
    expect(compactedItemsFrom([{ type: "message", role: "user", content: "no compaction" }])).toBeUndefined()
    expect(
      compactedItemsFrom([
        { type: "compaction", encrypted_content: "first" },
        { type: "compaction_summary", encrypted_content: "second" },
      ]),
    ).toBeUndefined()
  })

  test("keeps session instructions when routing compaction", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_compacted",
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch

      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: "ses_instructions" },
        body: JSON.stringify({
          model: "gpt",
          instructions: "You are OpenCode.",
          input: [{ role: "developer", content: "stable instructions" }, { role: "user", content: "hello" }],
        }),
      })

      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: "ses_instructions" },
        body: JSON.stringify({
          model: "gpt",
          input: [{ role: "developer", content: "stable instructions" }, { role: "user", content: "next" }],
        }),
      })

      calls.length = 0
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: "ses_instructions",
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: "You are an anchored context summarization assistant for coding sessions.\n\nSummarize only...",
          input: [
            {
              role: "developer",
              content: "You are an anchored context summarization assistant for coding sessions.\n\nSummarize only...",
            },
            { role: "user", content: "hello" },
            { role: "assistant", content: [{ type: "output_text", text: "done" }] },
            { role: "user", content: "Create a new anchored summary from the conversation history.\n\nOutput exactly..." },
          ],
        }),
      })

      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: "ignored",
        instructions: "You are OpenCode.",
        input: [
          { role: "developer", content: "stable instructions" },
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "output_text", text: "done" }] },
          { type: "compaction_trigger" },
        ],
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      })
    } finally {
      store.close()
    }
  })

  test("keeps rendered system instructions when routing compaction", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_compacted",
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch

      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "ses_rendered", model: { providerID: "openai" } } as any,
        { system: ["You are OpenCode.", " ", "AGENTS instructions"] },
      )
      await hooks["chat.headers"]?.(
        { sessionID: "ses_rendered", agent: "build", model: { providerID: "openai" } } as any,
        { headers: {} },
      )

      for (const agent of ["title", "summary"]) {
        const utilityHeaders = { headers: {} as Record<string, string> }
        await hooks["experimental.chat.system.transform"]?.(
          { sessionID: "ses_rendered", model: { providerID: "openai" } } as any,
          { system: [`${agent} prompt`] },
        )
        await hooks["chat.headers"]?.(
          { sessionID: "ses_rendered", agent, model: { providerID: "openai" } } as any,
          utilityHeaders,
        )
        expect(utilityHeaders.headers).toEqual({})
        await wrappedFetch("https://proxy.test/openai/v1/responses", {
          method: "POST",
          headers: utilityHeaders.headers,
          body: JSON.stringify({
            model: "gpt",
            instructions: `${agent} instructions`,
            input: [
              { role: "developer", content: `${agent} developer prompt` },
              { role: "user", content: `${agent} request` },
            ],
          }),
        })
      }
      calls.length = 0

      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "ses_rendered", model: { providerID: "openai" } } as any,
        { system: ["You are an anchored context summarization assistant for coding sessions.\n\nSummarize only..."] },
      )
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "ses_rendered" } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: {
                id: "msg_rendered_user",
                sessionID: "ses_rendered",
                role: "user",
                model: { providerID: "openai", modelID: "gpt" },
              },
              parts: [{ type: "text", text: "hello" }],
            },
            {
              info: {
                id: "msg_rendered_assistant",
                sessionID: "ses_rendered",
                role: "assistant",
                providerID: "openai",
                modelID: "gpt",
              },
              parts: [{ type: "text", text: "done" }],
            },
          ],
        } as any,
      )
      const compactHeaders = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        {
          sessionID: "ses_rendered",
          agent: "renamed-internal-agent",
          model: { providerID: "openai" },
          message: { id: "msg_compaction", time: { created: 3 }, agent: "build" },
        } as any,
        compactHeaders,
      )

      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: compactHeaders.headers,
        body: JSON.stringify({
          model: "ignored",
          instructions: "You are an anchored context summarization assistant for coding sessions.\n\nSummarize only...",
          input: [
            {
              role: "developer",
              content: "You are an anchored context summarization assistant for coding sessions.\n\nSummarize only...",
            },
            { role: "user", content: "hello" },
            { role: "assistant", content: [{ type: "output_text", text: "done" }] },
            { role: "user", content: "Create a new anchored summary from the conversation history.\n\nOutput exactly..." },
          ],
        }),
      })

      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: "gpt",
        instructions: "You are OpenCode.\n \nAGENTS instructions",
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          { role: "assistant", content: [{ type: "output_text", text: "done" }] },
          { type: "compaction_trigger" },
        ],
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      })
    } finally {
      store.close()
    }
  })

  test("does not restore stable instructions when config omits instructions", async () => {
    const config = OpenAICompactConfigSchema.parse({ compactBodyKeys: ["input"] })
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_compacted",
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(config, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch

      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [config.headers.session]: "ses_no_instructions" },
        body: JSON.stringify({
          model: "gpt",
          instructions: "You are OpenCode.",
          input: [{ role: "developer", content: "stable instructions" }, { role: "user", content: "hello" }],
        }),
      })

      calls.length = 0
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [config.headers.compact]: "1",
          [config.headers.session]: "ses_no_instructions",
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: "You are an anchored context summarization assistant for coding sessions.",
          input: [
            { role: "developer", content: "You are an anchored context summarization assistant for coding sessions." },
            { role: "user", content: "hello" },
            { role: "user", content: "Create a new anchored summary from the conversation history.\n\nOutput exactly..." },
          ],
        }),
      })

      expect(jsonBody(calls[0]?.init)).toEqual({
        model: "ignored",
        input: [
          { role: "developer", content: "stable instructions" },
          { role: "user", content: "hello" },
          { type: "compaction_trigger" },
        ],
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      })
    } finally {
      store.close()
    }
  })

  test("wraps multiple providers with their own compact models", async () => {
    const config = OpenAICompactConfigSchema.parse({
      providers: {
        openai: { compactModel: "openai-compact" },
        "custom-openai": { compactModel: "custom-compact" },
      },
    })
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_compacted",
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(config, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)

      await cfg.provider["custom-openai"].options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [config.headers.compact]: "1",
          [config.headers.session]: "ses_custom",
        },
        body: JSON.stringify({ model: "ignored", instructions: compactionInstructions, input: [] }),
      })

      expect(typeof cfg.provider.openai.options.fetch).toBe("function")
      expect(typeof cfg.provider["custom-openai"].options.fetch).toBe("function")
      expect(jsonBody(calls[0]?.init).model).toBe("custom-compact")
      expect(jsonBody(calls[0]?.init).input.at(-1)).toEqual({ type: "compaction_trigger" })
    } finally {
      store.close()
    }
  })

  test("routes compaction fetch and prepends stored checkpoint on the next request", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_compacted",
        model: currentModel,
        created_at: 1,
        output: [
          {
            id: "cmp_compacted",
            type: "compaction",
            encrypted_content: "compacted",
            internal_chat_message_metadata_passthrough: { turn_id: "turn_compacted" },
          },
        ],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch

      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: "ses_request",
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: compactionInstructions,
          input: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      })

      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: "ignored",
        input: [{ role: "user", content: "hello" }, { type: "compaction_trigger" }],
        tool_choice: "auto",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      })
      expect(new Headers(calls[0]?.init?.headers).has(defaultConfig.headers.compact)).toBe(false)
      expect(new Headers(calls[0]?.init?.headers).has(defaultConfig.headers.session)).toBe(false)

      const messagesBeforeBoundaryEvent = [
        { info: { id: "msg_original", sessionID: "ses_request", time: { created: 1 } }, parts: [] },
      ]
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        { messages: messagesBeforeBoundaryEvent } as any,
      )
      expect(messagesBeforeBoundaryEvent).toHaveLength(1)

      calls.length = 0
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: "ses_request" },
        body: JSON.stringify({
          model: "gpt",
          input: [
            { role: "developer", content: "stable instructions" },
            { role: "system", content: "more stable instructions" },
            { role: "user", content: [{ type: "input_text", text: "retained user" }] },
            { role: "user", content: [{ type: "input_text", text: "What did we do so far?" }] },
            { role: "assistant", content: [{ type: "output_text", text: defaultConfig.summary }] },
            { role: "user", content: "after compact" },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
                },
              ],
            },
          ],
        }),
      })

      const followupBody = jsonBody(calls[0]?.init)
      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses")
      expect(followupBody.input).toEqual([
        { role: "user", content: "hello" },
        {
          id: "cmp_compacted",
          type: "compaction",
          encrypted_content: "compacted",
          internal_chat_message_metadata_passthrough: { turn_id: "turn_compacted" },
        },
        { role: "developer", content: "stable instructions" },
        { role: "system", content: "more stable instructions" },
        { role: "user", content: "after compact" },
      ])

      await hooks.event?.({
        event: {
          type: "message.part.updated",
          properties: {
            sessionID: "ses_request",
            part: { messageID: "msg_checkpoint", type: "text", text: defaultConfig.summary },
            time: 2,
          },
        } as any,
      })

      const unknownProviderMessages = [
        { info: { id: "msg_checkpoint", sessionID: "ses_request" } },
        { info: { id: "msg_after", sessionID: "ses_request" } },
      ]
      await hooks["experimental.chat.messages.transform"]?.({}, { messages: unknownProviderMessages } as any)
      expect(unknownProviderMessages.map((message) => message.info.id)).toEqual(["msg_checkpoint", "msg_after"])

      await hooks["chat.message"]?.(
        { model: { providerID: "openai" }, sessionID: "ses_request", messageID: "msg_after" } as any,
        { message: { id: "msg_after" }, parts: [] } as any,
      )
      const inferredProviderMessages = [
        { info: { id: "msg_checkpoint", sessionID: "ses_request" } },
        {
          info: { id: "msg_continue", sessionID: "ses_request" },
          parts: [{ type: "text", synthetic: true, metadata: { compaction_continue: true } }],
        },
        { info: { id: "msg_after", sessionID: "ses_request" } },
      ]
      await hooks["experimental.chat.messages.transform"]?.({}, { messages: inferredProviderMessages } as any)
      expect(inferredProviderMessages.map((message) => message.info.id)).toEqual(["msg_after"])

      calls.length = 0
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: "ses_request",
        },
        body: JSON.stringify({
          model: "ignored",
          input: [
            {
              role: "developer",
              content: "You are an anchored context summarization assistant for coding sessions.\n\nSummarize only...",
            },
            { role: "user", content: "after compact" },
            { role: "user", content: "Create a new anchored summary from the conversation history.\n\nOutput exactly..." },
          ],
        }),
      })

      expect(jsonBody(calls[0]?.init).input).toEqual([
        { role: "developer", content: "stable instructions" },
        { role: "system", content: "more stable instructions" },
        { role: "user", content: "hello" },
        {
          id: "cmp_compacted",
          type: "compaction",
          encrypted_content: "compacted",
          internal_chat_message_metadata_passthrough: { turn_id: "turn_compacted" },
        },
        { role: "user", content: "after compact" },
        { type: "compaction_trigger" },
      ])
    } finally {
      store.close()
    }
  })

  test("tracks auto-continue by message id and removes it across later turns and plugin restarts", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ init?: RequestInit }> = []
    const fakeFetch = (async (_requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      return new Response("ok")
    }) as typeof fetch
    const sessionID = "ses_control_message"
    const controlText = "A future OpenCode version may use completely different continuation text."
    const startedAt = Date.now()

    store.upsert(sessionID, {
      providerID: "openai",
      responseID: "resp_control",
      afterMessageID: "msg_compaction_boundary",
      afterCreatedAt: startedAt,
      createdAt: startedAt,
      items: [
        { role: "user", content: "before compaction" },
        { role: "user", content: [{ type: "input_text", text: controlText }] },
        { type: "compaction", encrypted_content: "checkpoint" },
      ],
    })

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)

      await hooks["experimental.compaction.autocontinue"]?.(
        {
          sessionID,
          model: { providerID: "openai" },
          message: { id: "msg_compaction_boundary", time: { created: startedAt } },
        } as any,
        { enabled: true },
      )

      const firstContinuation = [
        {
          info: { id: "msg_compaction_boundary", sessionID, role: "user", time: { created: startedAt } },
          parts: [{ type: "compaction" }],
        },
        {
          info: {
            id: "msg_summary",
            sessionID,
            role: "assistant",
            parentID: "msg_compaction_boundary",
            summary: true,
            time: { created: startedAt + 1 },
          },
          parts: [{ type: "text", text: "A changed summary placeholder." }],
        },
        {
          info: { id: "msg_internal_continue", sessionID, role: "user", time: { created: startedAt + 2 } },
          parts: [{ type: "text", text: controlText, synthetic: true }],
        },
      ]
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        { messages: firstContinuation } as any,
      )
      expect(firstContinuation).toEqual([])
      expect(store.loadControlMessages().map((entry) => entry.messageID)).toEqual(["msg_internal_continue"])
      expect(store.loadAll()[0]?.checkpoint.items).toEqual([
        { role: "user", content: "before compaction" },
        { type: "compaction", encrypted_content: "checkpoint" },
      ])

      const laterMessages = [
        {
          info: { id: "msg_compaction_boundary", sessionID, role: "user", time: { created: startedAt } },
          parts: [{ type: "compaction" }],
        },
        {
          info: {
            id: "msg_summary",
            sessionID,
            role: "assistant",
            parentID: "msg_compaction_boundary",
            summary: true,
            time: { created: startedAt + 1 },
          },
          parts: [{ type: "text", text: "A changed summary placeholder." }],
        },
        {
          info: { id: "msg_internal_continue", sessionID, role: "user", time: { created: startedAt + 2 } },
          parts: [{ type: "text", text: controlText }],
        },
        {
          info: {
            id: "msg_continued_assistant",
            sessionID,
            role: "assistant",
            providerID: "openai",
            modelID: "gpt",
            time: { created: startedAt + 3 },
          },
          parts: [{ type: "text", text: "continued work" }],
        },
        {
          info: {
            id: "msg_real_user",
            sessionID,
            role: "user",
            model: { providerID: "openai", modelID: "gpt" },
            time: { created: startedAt + 4 },
          },
          parts: [{ type: "text", text: controlText }],
        },
      ]
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        { messages: laterMessages } as any,
      )
      expect(laterMessages.map((message) => message.info.id)).toEqual(["msg_continued_assistant", "msg_real_user"])

      await cfg.provider.openai.options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: sessionID },
        body: JSON.stringify({
          model: "gpt",
          input: [
            { role: "assistant", content: [{ type: "output_text", text: "continued work" }] },
            { role: "user", content: controlText },
          ],
        }),
      })
      expect(jsonBody(calls[0]?.init).input).toEqual([
        { role: "user", content: "before compaction" },
        { type: "compaction", encrypted_content: "checkpoint" },
        { role: "assistant", content: [{ type: "output_text", text: "continued work" }] },
        { role: "user", content: controlText },
      ])

      const restartedHooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const afterRestart = [
        {
          info: { id: "msg_compaction_boundary", sessionID, role: "user", time: { created: startedAt } },
          parts: [{ type: "compaction" }],
        },
        {
          info: {
            id: "msg_summary",
            sessionID,
            role: "assistant",
            parentID: "msg_compaction_boundary",
            summary: true,
            time: { created: startedAt + 1 },
          },
          parts: [{ type: "text", text: "A changed summary placeholder." }],
        },
        {
          info: { id: "msg_internal_continue", sessionID, role: "user", time: { created: startedAt + 2 } },
          parts: [{ type: "text", text: "metadata and text can both change later" }],
        },
        {
          info: { id: "msg_after_restart", sessionID, role: "user", time: { created: startedAt + 5 } },
          parts: [{ type: "text", text: "real request" }],
        },
      ]
      await restartedHooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        { messages: afterRestart } as any,
      )
      expect(afterRestart.map((message) => message.info.id)).toEqual(["msg_after_restart"])
    } finally {
      store.close()
    }
  })

  test("does not classify the newest real user when pending first observes an older marked continuation", async () => {
    const store = CheckpointStore.openMemory()
    const sessionID = "ses_pending_with_real_user"
    const now = Date.now()
    try {
      const hooks = createCompactHooks(defaultConfig, store)
      await hooks["experimental.compaction.autocontinue"]?.(
        {
          sessionID,
          agent: "plan",
          model: { providerID: "openai" },
          message: { id: "msg_compaction", time: { created: now } },
        } as any,
        { enabled: true },
      )

      const messages = [
        {
          info: { id: "msg_internal_continue", sessionID, role: "user", agent: "plan", time: { created: now + 1 } },
          parts: [
            {
              type: "text",
              text: "changed internal continuation",
              synthetic: true,
              metadata: { compaction_continue: true },
            },
          ],
        },
        {
          info: { id: "msg_real_user", sessionID, role: "user", agent: "plan", time: { created: now + 2 } },
          parts: [{ type: "text", text: "real user request" }],
        },
      ]
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        { messages } as any,
      )

      expect(messages.map((message) => message.info.id)).toEqual(["msg_real_user"])
      expect(store.loadControlMessages().map((message) => message.messageID)).toEqual(["msg_internal_continue"])
    } finally {
      store.close()
    }
  })

  test("uses chat.message as proof that a pending message is real user input", async () => {
    const store = CheckpointStore.openMemory()
    const sessionID = "ses_real_user_proof"
    const now = Date.now()
    try {
      const hooks = createCompactHooks(defaultConfig, store)
      await hooks["experimental.compaction.autocontinue"]?.(
        {
          sessionID,
          agent: "plan",
          model: { providerID: "openai" },
          message: { id: "msg_compaction", time: { created: now } },
        } as any,
        { enabled: true },
      )
      await hooks["chat.message"]?.(
        { sessionID, agent: "plan", model: { providerID: "openai", modelID: "gpt" }, messageID: "msg_real" } as any,
        {
          message: { id: "msg_real", role: "user", agent: "plan" },
          parts: [{ type: "text", text: "real request" }],
        } as any,
      )
      const messages = [
        {
          info: { id: "msg_real", sessionID, role: "user", agent: "plan", time: { created: now + 1 } },
          parts: [{ type: "text", text: "real request" }],
        },
      ]
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        { messages } as any,
      )

      expect(messages.map((message) => message.info.id)).toEqual(["msg_real"])
      expect(store.loadControlMessages()).toEqual([])
    } finally {
      store.close()
    }
  })

  test("captures markerless auto-continue from chat headers and removes its request user item", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ init?: RequestInit }> = []
    const fakeFetch = (async (_requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      return new Response("ok")
    }) as typeof fetch
    const sessionID = "ses_header_auto_continue"
    const now = Date.now() - 60_000
    const continuationCreatedAt = Date.now()
    store.upsert(sessionID, {
      providerID: "openai",
      responseID: "resp_header_auto_continue",
      afterMessageID: "msg_compaction",
      afterCreatedAt: now,
      createdAt: now,
      items: [
        { role: "user", content: "checkpoint history" },
        { type: "compaction", encrypted_content: "checkpoint" },
      ],
    })

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      await hooks["experimental.compaction.autocontinue"]?.(
        {
          sessionID,
          agent: "plan",
          model: { providerID: "openai" },
          message: { id: "msg_compaction", time: { created: now } },
        } as any,
        { enabled: true },
      )
      const messages = [
        {
          info: { id: "msg_compaction", sessionID, role: "user", agent: "plan", time: { created: now } },
          parts: [{ type: "compaction" }],
        },
        {
          info: {
            id: "msg_summary",
            sessionID,
            role: "assistant",
            parentID: "msg_compaction",
            summary: true,
            time: { created: now + 1 },
          },
          parts: [{ type: "text", text: "summary" }],
        },
      ]
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        { messages } as any,
      )
      const headers = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        {
          sessionID,
          agent: "plan",
          model: { providerID: "openai" },
          message: { id: "msg_markerless_continue", time: { created: continuationCreatedAt }, agent: "plan" },
        } as any,
        headers,
      )
      await cfg.provider.openai.options.fetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: headers.headers,
        body: JSON.stringify({
          model: "gpt",
          input: [
            { role: "user", content: "retained tail" },
            { role: "user", content: "markerless internal continuation" },
          ],
        }),
      })

      expect(jsonBody(calls[0]?.init).input).toEqual([
        { role: "user", content: "checkpoint history" },
        { type: "compaction", encrypted_content: "checkpoint" },
        { role: "user", content: "retained tail" },
      ])
      expect(store.loadControlMessages()).toEqual([
        {
          providerID: "openai",
          sessionID,
          messageID: "msg_markerless_continue",
          createdAt: continuationCreatedAt,
          contentText: "",
        },
      ])
    } finally {
      store.close()
    }
  })

  test("keeps checkpoints through undo and redo until undo removes the boundary", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return compactResponse({
        id: "resp_undo",
        model: currentModel,
        created_at: 1,
        output: [{ type: "compaction", encrypted_content: "undo-compacted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch

      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: "ses_undo",
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: compactionInstructions,
          input: [{ role: "user", content: "before compact" }],
        }),
      })
      await hooks.event?.({
        event: {
          type: "message.part.updated",
          properties: {
            sessionID: "ses_undo",
            part: { messageID: "msg_checkpoint", type: "text", text: defaultConfig.summary },
            time: 2,
          },
        } as any,
      })
      expect(store.count()).toBe(1)

      await hooks.event?.({
        event: {
          type: "session.updated",
          properties: { sessionID: "ses_undo", info: { id: "ses_undo", revert: { messageID: "msg_before" } } },
        } as any,
      })
      expect(store.count()).toBe(1)

      await hooks.event?.({
        event: { type: "session.updated", properties: { sessionID: "ses_undo", info: { id: "ses_undo" } } } as any,
      })

      calls.length = 0
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: "ses_undo" },
        body: JSON.stringify({ model: "gpt", input: [{ role: "user", content: "after redo" }] }),
      })
      expect(jsonBody(calls[0]?.init).input).toEqual([
        { role: "user", content: "before compact" },
        { type: "compaction", encrypted_content: "undo-compacted" },
        { role: "user", content: "after redo" },
      ])

      await hooks.event?.({
        event: {
          type: "message.removed",
          properties: { sessionID: "ses_undo", messageID: "msg_after_checkpoint" },
        } as any,
      })
      expect(store.count()).toBe(1)

      await hooks.event?.({
        event: { type: "message.removed", properties: { sessionID: "ses_undo", messageID: "msg_checkpoint" } } as any,
      })
      expect(store.count()).toBe(0)

      calls.length = 0
      const afterCommittedUndo = [{ role: "user", content: "new branch" }]
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: { [defaultConfig.headers.session]: "ses_undo" },
        body: JSON.stringify({ model: "gpt", input: afterCommittedUndo }),
      })
      expect(jsonBody(calls[0]?.init).input).toEqual(afterCommittedUndo)
    } finally {
      store.close()
    }
  })

  test.each([
    ["no compaction", []],
    ["a legacy compaction summary", [{ type: "compaction_summary", encrypted_content: "legacy" }]],
    [
      "multiple compactions",
      [
        { type: "compaction", encrypted_content: "first" },
        { type: "compaction", encrypted_content: "second" },
      ],
    ],
  ])("rejects compact output with %s", async (_name, output) => {
    const store = CheckpointStore.openMemory()
    const fakeFetch = (async () => compactResponse({ id: "resp_invalid", output })) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const wrappedFetch = cfg.provider.openai.options.fetch as typeof fetch

      const response = await wrappedFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: "ses_invalid",
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: compactionInstructions,
          input: [{ role: "user", content: "hello" }],
        }),
      })

      expect(response.status).toBe(502)
      expect(await response.text()).toContain("exactly one valid compaction item")
      expect(store.count()).toBe(0)
    } finally {
      store.close()
    }
  })

  test.each([
    ["a missing completed event", `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "encrypted" } })}\n\n`],
    [
      "a completed event without an id",
      `${[
        { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "encrypted" } },
        { type: "response.completed", response: {} },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("")}data: [DONE]\n\n`,
    ],
    [
      "a failed event",
      `data: ${JSON.stringify({ type: "response.failed", response: { id: "resp_failed" } })}\n\ndata: [DONE]\n\n`,
    ],
  ])("rejects compaction v2 stream with %s", async (_name, stream) => {
    const store = CheckpointStore.openMemory()
    const fakeFetch = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch

    try {
      const hooks = createCompactHooks(defaultConfig, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      const response = await cfg.provider.openai.options.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: "ses_invalid_stream",
        },
        body: JSON.stringify({
          model: "ignored",
          instructions: compactionInstructions,
          input: [{ role: "user", content: "hello" }],
        }),
      })

      expect(response.status).toBe(502)
      expect(store.count()).toBe(0)
    } finally {
      store.close()
    }
  })

  test("ignores deprecated compactEndpointPath", async () => {
    const config = OpenAICompactConfigSchema.parse({
      responses: { endpointPath: "/responses", compactEndpointPath: "/removed/compact" },
    })
    const store = CheckpointStore.openMemory()
    const calls: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return compactResponse({
        id: "resp_deprecated_path",
        output: [{ type: "compaction", encrypted_content: "encrypted" }],
      })
    }) as typeof fetch

    try {
      const hooks = createCompactHooks(config, store, fakeFetch)
      const cfg: any = {}
      await hooks.config?.(cfg)
      await cfg.provider.openai.options.fetch("https://proxy.test/v1/responses", {
        method: "POST",
        headers: { [config.headers.compact]: "1", [config.headers.session]: "ses_deprecated_path" },
        body: JSON.stringify({
          model: "ignored",
          instructions: compactionInstructions,
          input: [{ role: "user", content: "hello" }],
        }),
      })

      expect(calls).toEqual(["https://proxy.test/v1/responses"])
      expect(store.count()).toBe(1)
    } finally {
      store.close()
    }
  })

  test("adds compaction headers from the captured transaction without relying on the agent name", async () => {
    const store = CheckpointStore.openMemory()
    try {
      const hooks = createCompactHooks(defaultConfig, store)
      const output = { headers: {} as Record<string, string> }

      await hooks["experimental.session.compacting"]?.(
        { sessionID: "ses" } as any,
        { context: [], prompt: undefined },
      )
      await hooks["experimental.chat.messages.transform"]?.(
        { model: { providerID: "openai" } } as any,
        {
          messages: [
            {
              info: {
                id: "msg_user",
                sessionID: "ses",
                role: "user",
                model: { providerID: "openai", modelID: "gpt" },
              },
              parts: [{ type: "text", text: "history" }],
            },
          ],
        } as any,
      )

      await hooks["chat.headers"]?.(
        {
          model: { providerID: "openai" },
          sessionID: "ses",
          agent: "renamed-internal-agent",
          message: { id: "msg_compaction", time: { created: 2 }, agent: "build" },
        } as any,
        output,
      )

      expect(output.headers[defaultConfig.headers.session]).toBe("ses")
      expect(output.headers[defaultConfig.headers.compact]).toBe("1")

      const unsupported = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        { model: { providerID: "anthropic" }, sessionID: "ses", agent: "compaction" } as any,
        unsupported,
      )
      expect(unsupported.headers).toEqual({})
    } finally {
      store.close()
    }
  })
})
