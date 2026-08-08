import { describe, expect, test } from "vitest"
import { compactBody, compactedItemsFrom, compactUrl, createCompactHooks } from "../src/compact.js"
import { defaultConfig, OpenAICompactConfigSchema } from "../src/schema.js"
import { CheckpointStore } from "../src/state.js"

function jsonBody(init: RequestInit | undefined) {
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}")
}

const defaultCompactModel = defaultConfig.providers.openai.compactModel

describe("OpenAI compact hooks", () => {
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

  test("builds compact URL and compact request body", () => {
    expect(compactUrl(new URL("https://api.openai.com/v1/responses?x=1"))).toBe(
      "https://api.openai.com/v1/responses/compact?x=1",
    )
    expect(compactUrl(new URL("https://proxy.test/openai/v1/responses"))).toBe(
      "https://proxy.test/openai/v1/responses/compact",
    )

    const body = compactBody({ model: "ignored", input: [], stream: true, tools: [] })
    expect(body).toEqual({ model: defaultCompactModel, input: [], tools: [] })
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
      model: defaultCompactModel,
      input: [
        { role: "developer", content: "Keep the user's coding preferences." },
        { role: "user", content: "Create a new anchored summary from the conversation history. This is quoted." },
        { role: "assistant", content: [{ type: "output_text", text: "quoted response" }] },
        { role: "user", content: "real request" },
      ],
      tools: [{ type: "function", name: "test" }],
      parallel_tool_calls: true,
      reasoning: { effort: "medium", summary: "auto" },
      service_tier: "priority",
      prompt_cache_key: "cache-key",
      text: { verbosity: "low" },
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
      model: defaultCompactModel,
      input: [{ role: "user", content: [{ type: "input_text", text: content }] }],
    })
  })

  test("restores structured compact input from pre-serialization messages", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return new Response(
        JSON.stringify({
          id: "resp_structured",
          created_at: 1,
          output: [{ type: "compaction_summary", encrypted_content: "compacted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
                modelID: defaultCompactModel,
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

      const embedded = [
        "Create a new anchored summary from the conversation history.",
        "The following is the conversation history:",
        "[User]: flattened history that must not be sent",
      ].join("\n\n")
      await wrappedFetch("https://proxy.test/openai/v1/responses", {
        method: "POST",
        headers: {
          [defaultConfig.headers.compact]: "1",
          [defaultConfig.headers.session]: sessionID,
        },
        body: JSON.stringify({
          model: defaultCompactModel,
          instructions: "You are an anchored context summarization assistant for coding sessions.",
          input: [{ role: "user", content: [{ type: "input_text", text: embedded }] }],
        }),
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses/compact")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: defaultCompactModel,
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
        ],
      })
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
      return new Response(
        JSON.stringify({
          id: `resp_${call}`,
          created_at: call,
          output: [{ id: `cmp_${call}`, type: "compaction_summary", encrypted_content: `compacted-${call}` }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
        model: defaultCompactModel,
        instructions: "You are OpenCode.",
        input: [
          { role: "developer", content: "Stable developer context." },
          { id: "cmp_2", type: "compaction", encrypted_content: "compacted-2" },
          { role: "user", content: [{ type: "input_text", text: "structured tail" }] },
        ],
      })
    } finally {
      store.close()
    }
  })

  test("falls back to embedded history when structured messages cannot be cloned", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return new Response(
        JSON.stringify({
          id: "resp_fallback",
          created_at: 1,
          output: [{ type: "compaction_summary", encrypted_content: "compacted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
        "Create a new anchored summary from the conversation history.",
        "The following is the conversation history:",
        "[User]: preserved fallback history",
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

      expect(jsonBody(calls[0]?.init)).toEqual({
        model: defaultCompactModel,
        input: [{ role: "user", content: embedded }],
      })
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
      return new Response(
        JSON.stringify({
          id: "resp_compacted",
          created_at: 1,
          output: [{ type: "compaction_summary", encrypted_content: "compacted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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

      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses/compact")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: defaultCompactModel,
        instructions: "You are OpenCode.",
        input: [
          { role: "developer", content: "stable instructions" },
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "output_text", text: "done" }] },
        ],
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
      return new Response(
        JSON.stringify({
          id: "resp_compacted",
          created_at: 1,
          output: [{ type: "compaction_summary", encrypted_content: "compacted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
      const compactHeaders = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]?.(
        { sessionID: "ses_rendered", agent: "compaction", model: { providerID: "openai" } } as any,
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

      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses/compact")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: defaultCompactModel,
        instructions: "You are OpenCode.\n \nAGENTS instructions",
        input: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "output_text", text: "done" }] },
        ],
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
      return new Response(
        JSON.stringify({
          id: "resp_compacted",
          created_at: 1,
          output: [{ type: "compaction_summary", encrypted_content: "compacted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
        model: defaultCompactModel,
        input: [{ role: "developer", content: "stable instructions" }, { role: "user", content: "hello" }],
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
      return new Response(
        JSON.stringify({
          id: "resp_compacted",
          created_at: 1,
          output: [{ type: "compaction_summary", encrypted_content: "compacted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
        body: JSON.stringify({ model: "ignored", input: [] }),
      })

      expect(typeof cfg.provider.openai.options.fetch).toBe("function")
      expect(typeof cfg.provider["custom-openai"].options.fetch).toBe("function")
      expect(jsonBody(calls[0]?.init).model).toBe("custom-compact")
    } finally {
      store.close()
    }
  })

  test("routes compaction fetch and prepends stored checkpoint on the next request", async () => {
    const store = CheckpointStore.openMemory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(requestInput), init })
      return new Response(
        JSON.stringify({
          id: "resp_compacted",
          model: defaultCompactModel,
          created_at: 1,
          output: [
            { type: "message", role: "developer", content: "stale developer context" },
            { type: "message", role: "system", content: "stale system context" },
            { type: "message", role: "user", content: "retained user" },
            {
              id: "cmp_compacted",
              type: "compaction_summary",
              encrypted_content: "compacted",
              internal_chat_message_metadata_passthrough: { turn_id: "turn_compacted" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
        body: JSON.stringify({ model: "ignored", input: [{ role: "user", content: "hello" }], stream: true }),
      })

      expect(calls[0]?.url).toBe("https://proxy.test/openai/v1/responses/compact")
      expect(jsonBody(calls[0]?.init)).toEqual({
        model: defaultCompactModel,
        input: [{ role: "user", content: "hello" }],
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
        { type: "message", role: "user", content: "retained user" },
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
        { type: "message", role: "user", content: "retained user" },
        {
          id: "cmp_compacted",
          type: "compaction",
          encrypted_content: "compacted",
          internal_chat_message_metadata_passthrough: { turn_id: "turn_compacted" },
        },
        { role: "user", content: "after compact" },
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
      return new Response(
        JSON.stringify({
          id: "resp_undo",
          model: defaultCompactModel,
          created_at: 1,
          output: [{ type: "compaction_summary", encrypted_content: "undo-compacted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
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
        body: JSON.stringify({ model: "ignored", input: [{ role: "user", content: "before compact" }] }),
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
    [
      "multiple compactions",
      [
        { type: "compaction", encrypted_content: "first" },
        { type: "compaction_summary", encrypted_content: "second" },
      ],
    ],
  ])("rejects compact output with %s", async (_name, output) => {
    const store = CheckpointStore.openMemory()
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ id: "resp_invalid", output }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch

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
        body: JSON.stringify({ model: "ignored", input: [{ role: "user", content: "hello" }] }),
      })

      expect(response.status).toBe(502)
      expect(await response.text()).toContain("exactly one valid compaction item")
      expect(store.count()).toBe(0)
    } finally {
      store.close()
    }
  })

  test("adds compaction headers only for OpenAI compaction agent", async () => {
    const store = CheckpointStore.openMemory()
    try {
      const hooks = createCompactHooks(defaultConfig, store)
      const output = { headers: {} as Record<string, string> }

      await hooks["chat.headers"]?.(
        { model: { providerID: "openai" }, sessionID: "ses", agent: "compaction" } as any,
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
