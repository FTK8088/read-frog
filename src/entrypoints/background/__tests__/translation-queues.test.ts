import type { ProviderConfig } from "@/types/config/provider"
import type { MatchedTerm } from "@/utils/glossary/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR, NO_TRANSLATION_SENTINEL } from "@/utils/constants/prompt"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

const onMessageMock = vi.fn<(...args: any[]) => any>()
const ensureInitializedConfigMock = vi.fn<(...args: any[]) => any>()
const executeTranslateMock = vi.fn<(...args: any[]) => any>()
const generateArticleSummaryMock = vi.fn<(...args: any[]) => any>()
const generateTextForProviderRefMock = vi.fn<(...args: any[]) => any>()
const putBatchRequestRecordMock = vi.fn<(...args: any[]) => any>()
const articleSummaryCacheGetMock = vi.fn<(...args: any[]) => any>()
const articleSummaryCachePutMock = vi.fn<(...args: any[]) => any>()
const translationCacheGetMock = vi.fn<(...args: any[]) => any>()
const translationCachePutMock = vi.fn<(...args: any[]) => any>()
const translationCacheDeleteMock = vi.fn<(...args: any[]) => any>()
const runStreamTextInBackgroundMock = vi.fn<(...args: any[]) => any>()
const getTranslatePromptMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({
  onMessage: onMessageMock,
}))

vi.mock("../config", () => ({
  ensureInitializedConfig: ensureInitializedConfigMock,
}))

vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: executeTranslateMock,
}))

vi.mock("@/utils/content/summary", () => ({
  generateArticleSummary: generateArticleSummaryMock,
}))

vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: putBatchRequestRecordMock,
}))

vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    articleSummaryCache: {
      get: articleSummaryCacheGetMock,
      put: articleSummaryCachePutMock,
    },
    translationCache: {
      delete: translationCacheDeleteMock,
      get: translationCacheGetMock,
      put: translationCachePutMock,
    },
  },
}))

vi.mock("../background-stream", () => ({
  runStreamTextInBackground: runStreamTextInBackgroundMock,
  generateTextForProviderRef: generateTextForProviderRefMock,
}))

// Partial: the subtitles prompt builder pulls resolvePromptReplacementValue
// from this module, and the hosted path runs the real builder.
vi.mock("@/utils/prompts/translate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/prompts/translate")>()),
  getTranslatePrompt: getTranslatePromptMock,
}))

function getRegisteredMessageHandler(name: string) {
  const registration = onMessageMock.mock.calls.find((call) => call[0] === name)
  if (!registration) {
    throw new Error(`Message handler not registered: ${name}`)
  }
  const handler: unknown = registration[1]
  if (typeof handler !== "function") {
    throw new Error(`Registered message handler is not callable: ${name}`)
  }

  return async (message: {
    data: Record<string, unknown>
    sender?: { tab?: { id?: number } }
  }): Promise<unknown> => await handler(message)
}

function localProviderRef(config: ProviderConfig) {
  return { kind: "local" as const, config }
}

const llmProvider: ProviderConfig = {
  id: "openai-default",
  name: "OpenAI",
  provider: "openai",
  enabled: true,
  apiKey: "sk-test",
  model: { model: "gpt-5-mini", isCustomModel: false, customModel: null },
}

const googleProvider: ProviderConfig = {
  id: "google-translate-default",
  name: "Google Translate",
  provider: "google-translate",
  enabled: true,
}

const deepLProvider: ProviderConfig = {
  id: "deepl-default",
  name: "DeepL",
  provider: "deepl",
  enabled: true,
  apiKey: "test-key",
}

describe("translation queue helpers", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    ensureInitializedConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        enableAIContentAware: true,
      },
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        providerId: llmProvider.id,
        requestQueueConfig: {
          rate: 10,
          capacity: 10,
        },
        batchQueueConfig: {
          maxCharactersPerBatch: 1000,
          maxItemsPerBatch: 1,
        },
      },
    })

    executeTranslateMock.mockResolvedValue("translated subtitle")
    generateArticleSummaryMock.mockResolvedValue("Generated summary")
    putBatchRequestRecordMock.mockResolvedValue(undefined)
    articleSummaryCacheGetMock.mockResolvedValue(undefined)
    articleSummaryCachePutMock.mockResolvedValue(undefined)
    translationCacheGetMock.mockResolvedValue(undefined)
    translationCachePutMock.mockResolvedValue(undefined)
    translationCacheDeleteMock.mockResolvedValue(undefined)
    runStreamTextInBackgroundMock.mockResolvedValue({
      output: "hosted translation",
      thinking: { status: "complete", text: "" },
    })
    getTranslatePromptMock.mockResolvedValue({
      systemPrompt: "Translate accurately",
      prompt: "Source text",
    })
  })

  it("routes only llm providers through the batch queue", async () => {
    const { shouldUseBatchQueue } = await import("../translation-queues")

    const deeplProvider: ProviderConfig = {
      id: "deepl",
      name: "DeepL",
      provider: "deepl",
      enabled: true,
      apiKey: "key",
    }

    const deeplxProvider: ProviderConfig = {
      id: "deeplx",
      name: "DeepLX",
      provider: "deeplx",
      enabled: true,
      baseURL: "https://api.deeplx.org",
    }

    expect(shouldUseBatchQueue(deeplProvider)).toBe(false)
    expect(shouldUseBatchQueue(deeplxProvider)).toBe(false)
    expect(shouldUseBatchQueue(llmProvider)).toBe(true)
    expect(
      shouldUseBatchQueue({
        kind: "system",
        providerId: "read-frog-free-ai",
        modelTier: "normal",
        modelRevision: "normal-r1",
      }),
    ).toBe(true)
  }, 15_000)

  it("registers translation handlers before queue configuration resolves", async () => {
    let resolveConfig!: (config: typeof DEFAULT_CONFIG) => void
    const configPromise = new Promise<typeof DEFAULT_CONFIG>((resolve) => {
      resolveConfig = resolve
    })
    ensureInitializedConfigMock.mockReturnValue(configPromise)
    const { setupPageTranslationHandlers } = await import("../page-translation")
    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")

    setupPageTranslationHandlers()
    setupSubtitlesTranslationHandlers()

    expect(onMessageMock.mock.calls.map(([name]) => name)).toEqual([
      "enqueueTranslateRequest",
      "getOrGenerateWebPageSummary",
      "cancelPageTranslationRequests",
      "enqueueSubtitlesTranslateRequest",
      "enqueueSubtitlesTranslateBatch",
      "getSubtitlesSummary",
    ])
    resolveConfig(DEFAULT_CONFIG)
  })

  it("reuses the hosted requestId when RequestQueue retries the same model call", async () => {
    runStreamTextInBackgroundMock
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({
        output: "hosted translation",
        thinking: { status: "complete", text: "" },
      })

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")

    await expect(
      handler({
        data: {
          text: "hello",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: {
            kind: "system",
            providerId: "read-frog-free-ai",
            modelTier: "normal",
            modelRevision: "normal-r1",
          },
          scheduleAt: Date.now(),
          hash: "hosted-retry-hash",
          hostedFeature: "pageTranslation",
        },
      }),
    ).resolves.toBe("hosted translation")

    expect(runStreamTextInBackgroundMock).toHaveBeenCalledTimes(2)
    const firstPayload = runStreamTextInBackgroundMock.mock.calls[0]![0]
    const secondPayload = runStreamTextInBackgroundMock.mock.calls[1]![0]
    expect(firstPayload).toMatchObject({
      providerId: "read-frog-free-ai",
      modelTier: "normal",
      instructions: "Translate accurately",
      prompt: "Source text",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    })
    expect(secondPayload.requestId).toBe(firstPayload.requestId)
    expect(putBatchRequestRecordMock).not.toHaveBeenCalled()
  }, 5_000)

  it("routes hosted tasks through the shared user-configured request queue", async () => {
    ensureInitializedConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        requestQueueConfig: { rate: 0.1, capacity: 1 },
        batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 1 },
      },
    })
    const abortSignals: (AbortSignal | undefined)[] = []
    runStreamTextInBackgroundMock.mockImplementation(
      (_payload: unknown, options?: { signal?: AbortSignal }) => {
        abortSignals.push(options?.signal)
        return new Promise(() => {})
      },
    )

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    const enqueue = getRegisteredMessageHandler("enqueueTranslateRequest")
    const cancel = getRegisteredMessageHandler("cancelPageTranslationRequests")

    const sender = { tab: { id: 7 } }
    const requests = ["shared-queue-one", "shared-queue-two"].map((hash) =>
      enqueue({
        data: {
          text: `text for ${hash}`,
          langConfig: DEFAULT_CONFIG.language,
          providerRef: {
            kind: "system",
            providerId: "read-frog-free-ai",
            modelTier: "normal",
            modelRevision: "normal-r1",
          },
          scheduleAt: Date.now(),
          hash,
          sessionId: "session-a",
          hostedFeature: "pageTranslation",
        },
        sender,
      }),
    )
    for (const request of requests) request.catch(() => {})

    // capacity 1 admits exactly one in-flight hosted call; the second waits
    // ~10s (rate 0.1) for the next token. The former dedicated hosted queue
    // (rate 2 / capacity 2) would have started both immediately.
    await vi.waitFor(() => expect(runStreamTextInBackgroundMock).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(runStreamTextInBackgroundMock).toHaveBeenCalledTimes(1)

    await cancel({ data: { sessionId: "session-a" }, sender })

    const settled = await Promise.allSettled(requests)
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"])
    const cancelledReasons = settled.map(
      (result) => result.status === "rejected" && isTranslationCancelledError(result.reason),
    )
    expect(cancelledReasons).toEqual([true, true])
    expect(abortSignals[0]?.aborted).toBe(true)
  }, 5_000)

  it("keeps request-local marker zero isolated across LLM batch items", async () => {
    ensureInitializedConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        providerId: llmProvider.id,
        batchQueueConfig: {
          maxCharactersPerBatch: 1000,
          maxItemsPerBatch: 10,
        },
      },
    })
    executeTranslateMock.mockResolvedValueOnce(
      `<span data-rf-attr="0">Bonjour</span>\n\n%%\n\n<a data-rf-attr="0">Lire</a>`,
    )

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")

    const results = await Promise.all([
      handler({
        data: {
          text: `<span data-rf-attr="0">Hello</span>`,
          langConfig: DEFAULT_CONFIG.language,
          providerRef: localProviderRef(llmProvider),
          scheduleAt: Date.now(),
          hash: "marker-batch-one",
          textFormat: "html",
        },
      }),
      handler({
        data: {
          text: `<a data-rf-attr="0">Read</a>`,
          langConfig: DEFAULT_CONFIG.language,
          providerRef: localProviderRef(llmProvider),
          scheduleAt: Date.now(),
          hash: "marker-batch-two",
          textFormat: "html",
        },
      }),
    ])

    expect(results).toEqual([
      `<span data-rf-attr="0">Bonjour</span>`,
      `<a data-rf-attr="0">Lire</a>`,
    ])
    expect(executeTranslateMock).toHaveBeenCalledTimes(1)
    expect(executeTranslateMock).toHaveBeenCalledWith(
      `<span data-rf-attr="0">Hello</span>\n\n%%\n\n<a data-rf-attr="0">Read</a>`,
      DEFAULT_CONFIG.language,
      llmProvider,
      expect.any(Function),
      expect.objectContaining({ isBatch: true }),
    )
  })

  it("coalesces concurrent identical translate requests into one provider call", async () => {
    executeTranslateMock.mockResolvedValue("translated")

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")

    const makeRequest = () =>
      handler({
        data: {
          text: "hello",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: localProviderRef(llmProvider),
          scheduleAt: Date.now(),
          hash: "same-request-hash",
        },
      })

    // both requests arrive before the first result lands in the translation cache
    const results = await Promise.all([makeRequest(), makeRequest()])

    expect(results).toEqual(["translated", "translated"])
    expect(executeTranslateMock).toHaveBeenCalledTimes(1)
    // the shared item is sent once, not as a two-item batch
    expect(executeTranslateMock.mock.calls[0]![0]).toBe("hello")
  })

  it("returns a cached LLM translation without calling the provider", async () => {
    translationCacheGetMock.mockResolvedValueOnce({
      key: "llm-cache-hit",
      translation: "cached translation",
    })
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")

    await expect(
      handler({
        data: {
          text: "hello",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: localProviderRef(llmProvider),
          scheduleAt: Date.now(),
          hash: "llm-cache-hit",
        },
      }),
    ).resolves.toBe("cached translation")

    expect(executeTranslateMock).not.toHaveBeenCalled()
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  describe("explicit subtitle batches", () => {
    async function setupBatch(maxCharactersPerBatch = 1000) {
      ensureInitializedConfigMock.mockResolvedValue({
        ...DEFAULT_CONFIG,
        videoSubtitles: {
          ...DEFAULT_CONFIG.videoSubtitles,
          requestQueueConfig: { rate: 100, capacity: 20 },
          batchQueueConfig: { maxCharactersPerBatch, maxItemsPerBatch: 10 },
        },
      })
      executeTranslateMock.mockImplementation(async (text: string) =>
        text
          .split(`\n\n${BATCH_SEPARATOR}\n\n`)
          .map((line) => `t:${line}`)
          .join(`\n\n${BATCH_SEPARATOR}\n\n`),
      )
      const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
      setupSubtitlesTranslationHandlers()
      return getRegisteredMessageHandler("enqueueSubtitlesTranslateBatch")
    }

    function requests(count: number, prefix = "line") {
      return Array.from({ length: count }, (_, index) => ({
        text: `${prefix}${index}`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(llmProvider),
        scheduleAt: Date.now(),
        hash: `${prefix}-hash-${index}`,
        webTitle: "Video",
      }))
    }

    it("sends ten lines in one AI call", async () => {
      const handler = await setupBatch()
      const group = requests(10)
      const result = await handler({ data: { requests: group } })
      expect(result).toEqual(group.map((r) => ({ translation: `t:${r.text}` })))
      expect(executeTranslateMock).toHaveBeenCalledTimes(1)
      expect(executeTranslateMock.mock.calls[0]![0]).toBe(
        group.map((r) => r.text).join(`\n\n${BATCH_SEPARATOR}\n\n`),
      )
      expect(executeTranslateMock.mock.calls[0]![4]).toMatchObject({ batchSize: 10 })
      expect(translationCachePutMock).toHaveBeenCalledTimes(10)
    })

    it("waits for all cache lookups before sending the uncached lines together", async () => {
      const handler = await setupBatch()
      let releaseLookup!: (value: undefined) => void
      translationCacheGetMock.mockImplementation(async (hash: string) => {
        if (hash === "line-hash-0") return { translation: "cached zero" }
        if (hash === "line-hash-1")
          return new Promise((resolve) => {
            releaseLookup = resolve
          })
        return undefined
      })
      const group = requests(10)
      const pending = handler({ data: { requests: group } })
      await vi.waitFor(() => expect(releaseLookup).toBeTypeOf("function"))
      // More than the old collection delay elapses while one lookup is held.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(executeTranslateMock).not.toHaveBeenCalled()
      releaseLookup(undefined)
      await expect(pending).resolves.toEqual([
        { translation: "cached zero" },
        ...group.slice(1).map((r) => ({ translation: `t:${r.text}` })),
      ])
      expect(executeTranslateMock).toHaveBeenCalledTimes(1)
      expect(executeTranslateMock.mock.calls[0]![0]).not.toContain("line0")
      expect(executeTranslateMock.mock.calls[0]![4]).toMatchObject({ batchSize: 9 })
      expect(translationCachePutMock).toHaveBeenCalledTimes(9)
    })

    it("avoids every AI call when the whole group is cached", async () => {
      const handler = await setupBatch()
      translationCacheGetMock.mockImplementation(async (hash: string) => ({ translation: hash }))
      const group = requests(10)
      await expect(handler({ data: { requests: group } })).resolves.toEqual(
        group.map((r) => ({ translation: r.hash })),
      )
      expect(executeTranslateMock).not.toHaveBeenCalled()
    })

    it("sends the trailing partial group immediately", async () => {
      const handler = await setupBatch()
      const group = requests(3)
      await expect(handler({ data: { requests: group } })).resolves.toEqual(
        group.map((r) => ({ translation: `t:${r.text}` })),
      )
      expect(executeTranslateMock).toHaveBeenCalledTimes(1)
      expect(executeTranslateMock.mock.calls[0]![4]).toMatchObject({ batchSize: 3 })
    })

    it("splits a group at the character limit while preserving result order", async () => {
      const handler = await setupBatch(10)
      const group = requests(5) // Each line is 5 characters, so 2 + 2 + 1.
      await expect(handler({ data: { requests: group } })).resolves.toEqual(
        group.map((r) => ({ translation: `t:${r.text}` })),
      )
      expect(executeTranslateMock.mock.calls.map((call) => call[0])).toEqual([
        `line0\n\n${BATCH_SEPARATOR}\n\nline1`,
        `line2\n\n${BATCH_SEPARATOR}\n\nline3`,
        "line4",
      ])
      expect(executeTranslateMock.mock.calls.map((call) => call[4].batchSize)).toEqual([2, 2, 1])
    })

    it("uses the uncached batch size in hosted subtitle instructions", async () => {
      const handler = await setupBatch()
      const group = requests(3).map((request) => ({
        ...request,
        providerRef: {
          kind: "system" as const,
          providerId: "read-frog-advance-ai",
          modelTier: "advance" as const,
          modelRevision: "advance-r1",
        },
      }))
      translationCacheGetMock.mockImplementation(async (hash: string) =>
        hash === "line-hash-0" ? { translation: "cached zero" } : undefined,
      )
      runStreamTextInBackgroundMock.mockResolvedValue({
        output: `t:line1\n\n${BATCH_SEPARATOR}\n\nt:line2`,
      })

      await expect(handler({ data: { requests: group } })).resolves.toEqual([
        { translation: "cached zero" },
        { translation: "t:line1" },
        { translation: "t:line2" },
      ])

      expect(executeTranslateMock).not.toHaveBeenCalled()
      expect(runStreamTextInBackgroundMock).toHaveBeenCalledTimes(1)
      expect(runStreamTextInBackgroundMock).toHaveBeenCalledWith(
        expect.objectContaining({
          hostedFeature: "videoSubtitles",
          instructions: expect.stringContaining(
            "Return exactly 2 translated segments and exactly 1 standalone %% separator lines",
          ),
        }),
        expect.anything(),
      )
    })

    it("keeps simultaneous groups separate even when neither fills the configured size", async () => {
      const handler = await setupBatch()
      await Promise.all([
        handler({ data: { requests: requests(3, "first") } }),
        handler({ data: { requests: requests(3, "second") } }),
      ])
      expect(executeTranslateMock).toHaveBeenCalledTimes(2)
      const payloads = executeTranslateMock.mock.calls.map((call) => call[0] as string)
      expect(
        payloads.filter((text) => text.includes("first") && text.includes("second")),
      ).toHaveLength(0)
    })

    it("retries a mismatched AI group without falling back to single-line calls", async () => {
      const handler = await setupBatch()
      vi.useFakeTimers()
      try {
        executeTranslateMock.mockResolvedValue("wrong result count")
        const pending = handler({ data: { requests: requests(3) } })
        await vi.advanceTimersByTimeAsync(8000)
        const result = (await pending) as Array<{ error: string }>
        expect(result).toHaveLength(3)
        expect(result.every((item) => item.error.includes("Batch result count mismatch"))).toBe(
          true,
        )
        expect(executeTranslateMock).toHaveBeenCalledTimes(4)
        expect(executeTranslateMock.mock.calls.map((call) => call[4].batchSize)).toEqual([
          3, 3, 3, 3,
        ])
        expect(
          executeTranslateMock.mock.calls.every(([text]) =>
            (text as string).includes(BATCH_SEPARATOR),
          ),
        ).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it("keeps non-AI translation requests individual", async () => {
      const handler = await setupBatch()
      const group = requests(3).map((request) => ({
        ...request,
        providerRef: localProviderRef(googleProvider),
      }))
      await expect(handler({ data: { requests: group } })).resolves.toEqual(
        group.map((r) => ({ translation: `t:${r.text}` })),
      )
      expect(executeTranslateMock).toHaveBeenCalledTimes(3)
    })
  })

  it("passes subtitle summary through the translation queue without generating a new summary", async () => {
    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueSubtitlesTranslateRequest")
    const result = await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: { kind: "local" as const, config: llmProvider },
        scheduleAt: Date.now(),
        hash: "subtitle-hash",
        webTitle: "Video title",
        webDescription: "Video description",
        summary: "Ready summary",
      },
    })

    expect(result).toBe("translated subtitle")
    expect(generateArticleSummaryMock).not.toHaveBeenCalled()
    expect(executeTranslateMock).toHaveBeenCalledWith(
      "hello",
      DEFAULT_CONFIG.language,
      llmProvider,
      expect.any(Function),
      expect.objectContaining({
        isBatch: true,
        context: {
          webTitle: "Video title",
          webDescription: "Video description",
          videoSummary: "Ready summary",
        },
      }),
    )
  })

  it("keeps subtitle translations with different video context in separate batches", async () => {
    ensureInitializedConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        enableAIContentAware: true,
      },
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        providerId: llmProvider.id,
        requestQueueConfig: {
          rate: 10,
          capacity: 10,
        },
        batchQueueConfig: {
          maxCharactersPerBatch: 1000,
          maxItemsPerBatch: 10,
        },
      },
    })

    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueSubtitlesTranslateRequest")
    const requests = [
      handler({
        data: {
          text: "hello",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: { kind: "local" as const, config: llmProvider },
          scheduleAt: Date.now(),
          hash: "subtitle-hash-one",
          webTitle: "First video",
          webDescription: "First description",
        },
      }),
      handler({
        data: {
          text: "hello",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: { kind: "local" as const, config: llmProvider },
          scheduleAt: Date.now(),
          hash: "subtitle-hash-two",
          webTitle: "Second video",
          webDescription: "Second description",
        },
      }),
    ]

    await expect(Promise.all(requests)).resolves.toEqual([
      "translated subtitle",
      "translated subtitle",
    ])
    expect(executeTranslateMock).toHaveBeenCalledTimes(2)
    expect(executeTranslateMock).toHaveBeenNthCalledWith(
      1,
      "hello",
      DEFAULT_CONFIG.language,
      llmProvider,
      expect.any(Function),
      expect.objectContaining({
        isBatch: true,
        context: expect.objectContaining({
          webTitle: "First video",
          webDescription: "First description",
        }),
      }),
    )
    expect(executeTranslateMock).toHaveBeenNthCalledWith(
      2,
      "hello",
      DEFAULT_CONFIG.language,
      llmProvider,
      expect.any(Function),
      expect.objectContaining({
        isBatch: true,
        context: expect.objectContaining({
          webTitle: "Second video",
          webDescription: "Second description",
        }),
      }),
    )
  })

  it("passes webpage context through the translation queue without generating a new summary", async () => {
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(llmProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
        webTitle: "Page title",
        webDescription: "Page description",
        webContent: "Page body",
        webSummary: "Ready summary",
      },
    })

    expect(result).toBe("translated subtitle")
    expect(generateArticleSummaryMock).not.toHaveBeenCalled()
    expect(executeTranslateMock).toHaveBeenCalledWith(
      "hello",
      DEFAULT_CONFIG.language,
      llmProvider,
      expect.any(Function),
      expect.objectContaining({
        context: {
          webTitle: "Page title",
          webDescription: "Page description",
          webContent: "Page body",
          webSummary: "Ready summary",
        },
      }),
    )
  })

  // Cached values are already decoded once by executeTranslate; a second decode
  // would corrupt legitimate entity mentions ("Tom &amp; Jerry" -> "Tom & Jerry").
  // The fixtures below intentionally contain semicolon-terminated entities so a
  // re-introduced decode call fails these tests.
  it("returns cached Google translations verbatim without re-decoding", async () => {
    translationCacheGetMock.mockResolvedValueOnce({
      key: "webpage-hash",
      translation: "Tom &amp; Jerry — It's on https://example.com/?page=1&copy=true <span>",
    })

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
      },
    })

    expect(result).toBe("Tom &amp; Jerry — It's on https://example.com/?page=1&copy=true <span>")
    expect(executeTranslateMock).not.toHaveBeenCalled()
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("bypasses a cached value and replaces the same key after forced translation succeeds", async () => {
    translationCacheGetMock.mockResolvedValue({
      key: "webpage-hash",
      translation: "stale translation",
    })
    executeTranslateMock.mockResolvedValue("fresh translation")

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")

    await expect(
      handler({
        data: {
          text: "hello",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: localProviderRef(googleProvider),
          scheduleAt: Date.now(),
          hash: "webpage-hash",
          forceRetranslation: true,
        },
      }),
    ).resolves.toBe("fresh translation")

    expect(translationCacheGetMock).not.toHaveBeenCalled()
    expect(executeTranslateMock).toHaveBeenCalledTimes(1)
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "webpage-hash",
        translation: "fresh translation",
      }),
    )
  })

  it("preserves the previous cache entry when forced translation fails", async () => {
    translationCacheGetMock.mockResolvedValue({
      key: "webpage-hash",
      translation: "still usable",
    })
    executeTranslateMock.mockReset().mockRejectedValue(new Error("provider unavailable"))

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")

    await expect(
      handler({
        data: {
          text: "hello",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: localProviderRef(googleProvider),
          scheduleAt: Date.now(),
          hash: "webpage-hash",
          forceRetranslation: true,
        },
      }),
    ).rejects.toThrow("provider unavailable")

    expect(translationCacheGetMock).not.toHaveBeenCalled()
    expect(translationCacheDeleteMock).not.toHaveBeenCalled()
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("returns and caches fresh Google translations verbatim without re-decoding", async () => {
    executeTranslateMock.mockResolvedValue("write &amp; for ampersand — It's fine")

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
      },
    })

    expect(result).toBe("write &amp; for ampersand — It's fine")
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "webpage-hash",
        translation: "write &amp; for ampersand — It's fine",
      }),
    )
  })

  it("caches a translation whose inline atom placeholders all came back", async () => {
    executeTranslateMock.mockResolvedValue("设 {{1}} 大于 {{0}}。")

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "Let {{0}} be smaller than {{1}}.",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "atom-hash",
      },
    })

    expect(result).toBe("设 {{1}} 大于 {{0}}。")
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "atom-hash", translation: "设 {{1}} 大于 {{0}}。" }),
    )
  })

  it("returns but does not cache a translation that lost an inline atom placeholder", async () => {
    executeTranslateMock.mockResolvedValue("设 {{0}} 大于。")

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "Let {{0}} be smaller than {{1}}.",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "atom-hash",
      },
    })

    expect(result).toBe("设 {{0}} 大于。")
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("caches the no-translation sentinel for a paragraph that carried placeholders", async () => {
    // The sentinel replaces the whole translation, so the placeholder audit sees
    // a total loss. Failing it would make every already-in-target-language
    // paragraph with a formula re-hit the provider on every page load.
    executeTranslateMock.mockResolvedValue(NO_TRANSLATION_SENTINEL)

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "设 {{0}} 大于 {{1}}。",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "atom-hash",
      },
    })

    expect(result).toBe(NO_TRANSLATION_SENTINEL)
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "atom-hash", translation: NO_TRANSLATION_SENTINEL }),
    )
  })

  it("uses cached HTML translations when all attribute markers remain on their tags", async () => {
    translationCacheGetMock.mockResolvedValueOnce({
      key: "webpage-hash",
      translation: `<a data-rf-attr="1">Lire</a><span data-rf-attr="0">Bonjour</span>`,
    })

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: `<span data-rf-attr="0">Hello</span><a data-rf-attr="1">Read</a>`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
        textFormat: "html",
      },
    })

    expect(result).toBe(`<a data-rf-attr="1">Lire</a><span data-rf-attr="0">Bonjour</span>`)
    expect(executeTranslateMock).not.toHaveBeenCalled()
    expect(translationCacheDeleteMock).not.toHaveBeenCalled()
  })

  it("deletes an invalid cached HTML translation and replaces it with a valid fresh result", async () => {
    translationCacheGetMock.mockResolvedValueOnce({
      key: "webpage-hash",
      translation: `<span>Bonjour</span>`,
    })
    executeTranslateMock.mockResolvedValueOnce(`<span data-rf-attr="0">Bonjour</span>`)

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: `<span data-rf-attr="0">Hello</span>`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
        textFormat: "html",
      },
    })

    expect(result).toBe(`<span data-rf-attr="0">Bonjour</span>`)
    expect(translationCacheDeleteMock).toHaveBeenCalledWith("webpage-hash")
    expect(executeTranslateMock).toHaveBeenCalledTimes(1)
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "webpage-hash",
        translation: `<span data-rf-attr="0">Bonjour</span>`,
      }),
    )
  })

  it("validates escaped page-marker fallback results before using or caching them", async () => {
    translationCacheGetMock.mockResolvedValueOnce({
      key: "legacy-marker-hash",
      translation: `<span>Cached without the protected page attribute</span>`,
    })
    executeTranslateMock.mockResolvedValueOnce(
      `<span data-rf-attr="rf-page-0">Fresh translation</span>`,
    )

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: `<span data-rf-attr="rf-page-0">Hello</span>`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "legacy-marker-hash",
        textFormat: "html",
      },
    })

    expect(result).toBe(`<span data-rf-attr="rf-page-0">Fresh translation</span>`)
    expect(translationCacheDeleteMock).toHaveBeenCalledWith("legacy-marker-hash")
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "legacy-marker-hash",
        translation: `<span data-rf-attr="rf-page-0">Fresh translation</span>`,
      }),
    )
  })

  it("throws and does not cache a fresh translation with invalid HTML markers", async () => {
    executeTranslateMock.mockResolvedValueOnce(`<div data-rf-attr="0">Bonjour</div>`)

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const request = handler({
      data: {
        text: `<span data-rf-attr="0">Hello</span>`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
        textFormat: "html",
      },
    })

    await expect(request).rejects.toMatchObject({
      code: "HTML_ATTR_MARKER_INTEGRITY",
      reason: "wrong-output-tag",
    })
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("treats an empty provider result as a missing-marker integrity failure", async () => {
    executeTranslateMock.mockResolvedValueOnce("")

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const request = handler({
      data: {
        text: `<span data-rf-attr="0">Hello</span>`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "empty-html-result",
        textFormat: "html",
      },
    })

    await expect(request).rejects.toMatchObject({
      code: "HTML_ATTR_MARKER_INTEGRITY",
      reason: "missing-output-marker",
    })
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("rejects duplicate input marker IDs before reading the cache or translating", async () => {
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const request = handler({
      data: {
        text: `<span data-rf-attr="0">Hello</span><a data-rf-attr="0">Read</a>`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
        textFormat: "html",
      },
    })

    await expect(request).rejects.toMatchObject({
      code: "HTML_ATTR_MARKER_INTEGRITY",
      reason: "duplicate-input-marker",
    })
    expect(translationCacheGetMock).not.toHaveBeenCalled()
    expect(executeTranslateMock).not.toHaveBeenCalled()
    expect(translationCacheDeleteMock).not.toHaveBeenCalled()
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("does not treat marker-shaped plain text as the translationOnly HTML protocol", async () => {
    executeTranslateMock.mockResolvedValueOnce("translated plain text")

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: `Explain <span data-rf-attr="0">this example</span>`,
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "plain-marker-shaped-text",
        textFormat: "plain",
      },
    })

    expect(result).toBe("translated plain text")
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "plain-marker-shaped-text",
        translation: "translated plain text",
      }),
    )
  })

  it("returns and caches the no-translation sentinel RAW (mapping is content-side)", async () => {
    executeTranslateMock.mockResolvedValue(NO_TRANSLATION_SENTINEL)

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "already in target language",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "sentinel-hash",
      },
    })

    // Mapping the sentinel to "" here would fall out of the truthy-only cache
    // write and re-hit the provider on every request; translateTextCore maps it.
    expect(result).toBe(NO_TRANSLATION_SENTINEL)
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "sentinel-hash",
        translation: NO_TRANSLATION_SENTINEL,
      }),
    )
  })

  it("forwards the textFormat to executeTranslate for non-batch providers", async () => {
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    await handler({
      data: {
        text: "<b>hello</b>",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(googleProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
        textFormat: "html",
      },
    })

    expect(executeTranslateMock).toHaveBeenCalledWith(
      "<b>hello</b>",
      DEFAULT_CONFIG.language,
      googleProvider,
      expect.any(Function),
      { textFormat: "html", signal: expect.any(AbortSignal) },
    )
  })

  it("returns cached Google subtitle translations verbatim without re-decoding", async () => {
    translationCacheGetMock.mockResolvedValueOnce({
      key: "subtitle-hash",
      translation: "Tom &amp; Jerry — It's a subtitle",
    })

    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueSubtitlesTranslateRequest")
    const result = await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: { kind: "local" as const, config: googleProvider },
        scheduleAt: Date.now(),
        hash: "subtitle-hash",
      },
    })

    expect(result).toBe("Tom &amp; Jerry — It's a subtitle")
    expect(executeTranslateMock).not.toHaveBeenCalled()
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("returns and caches fresh Google subtitle translations verbatim without re-decoding", async () => {
    executeTranslateMock.mockResolvedValue("write &amp; for ampersand — It's a subtitle")

    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueSubtitlesTranslateRequest")
    const result = await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: { kind: "local" as const, config: googleProvider },
        scheduleAt: Date.now(),
        hash: "subtitle-hash",
      },
    })

    expect(result).toBe("write &amp; for ampersand — It's a subtitle")
    expect(translationCachePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "subtitle-hash",
        translation: "write &amp; for ampersand — It's a subtitle",
      }),
    )
  })

  it("does not normalize cached non-Google translations", async () => {
    translationCacheGetMock.mockResolvedValueOnce({
      key: "webpage-hash",
      translation: "A&amp;B",
    })

    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const result = await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: localProviderRef(deepLProvider),
        scheduleAt: Date.now(),
        hash: "webpage-hash",
      },
    })

    expect(result).toBe("A&amp;B")
    expect(executeTranslateMock).not.toHaveBeenCalled()
    expect(translationCachePutMock).not.toHaveBeenCalled()
  })

  it("bills hosted subtitle translations against videoSubtitles, not page translation", async () => {
    // The queue's route was briefly declared but never threaded through, which
    // would have billed every subtitle line to the page-translation quota.
    runStreamTextInBackgroundMock.mockResolvedValue({ output: "译文" })
    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueSubtitlesTranslateRequest")
    await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: {
          kind: "system" as const,
          providerId: "read-frog-advance-ai",
          modelTier: "advance",
          modelRevision: "advance-r1",
        },
        scheduleAt: Date.now(),
        hash: "subtitle-hosted-hash",
      },
    })

    expect(runStreamTextInBackgroundMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostedFeature: "videoSubtitles" }),
      expect.anything(),
    )
  })

  it("bills a hosted request against its explicit route", async () => {
    // Input translation shares the webpage queue; without the per-request
    // route it would bill the page-translation quota it never gated on.
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    await handler({
      data: {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        providerRef: {
          kind: "system" as const,
          providerId: "read-frog-free-ai",
          modelTier: "normal",
          modelRevision: "normal-r1",
        },
        scheduleAt: Date.now(),
        hash: "hosted-input-route-hash",
        hostedFeature: "inputTranslation",
      },
    })

    expect(runStreamTextInBackgroundMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostedFeature: "inputTranslation" }),
      expect.anything(),
    )
  })

  it.each([undefined, null, "", "unknownFeature", "toString"])(
    "rejects invalid hosted routing (%s) before reading caches or enqueueing",
    async (hostedFeature) => {
      const { setupPageTranslationHandlers } = await import("../page-translation")
      setupPageTranslationHandlers()
      translationCacheGetMock.mockResolvedValue({ translation: "cached translation" })
      articleSummaryCacheGetMock.mockResolvedValue({ summary: "cached summary" })
      const data = {
        text: "hello",
        langConfig: DEFAULT_CONFIG.language,
        scheduleAt: Date.now(),
        hash: "cached",
        webTitle: "Title",
        webContent: "Body",
        providerRef: {
          kind: "system",
          providerId: "read-frog-free-ai",
          modelTier: "normal",
          modelRevision: "r1",
        },
        hostedFeature,
      }
      for (const name of ["enqueueTranslateRequest", "getOrGenerateWebPageSummary"]) {
        const handler = getRegisteredMessageHandler(name)
        await expect(handler({ data })).rejects.toThrow("valid hostedFeature is required")
      }
      expect(translationCacheGetMock).not.toHaveBeenCalled()
      expect(articleSummaryCacheGetMock).not.toHaveBeenCalled()
      expect(runStreamTextInBackgroundMock).not.toHaveBeenCalled()
      expect(generateArticleSummaryMock).not.toHaveBeenCalled()
    },
  )

  it("keeps requests for different hosted routes in separate billing batches", async () => {
    ensureInitializedConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 4 },
      },
    })
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("enqueueTranslateRequest")
    const base = {
      langConfig: DEFAULT_CONFIG.language,
      providerRef: {
        kind: "system" as const,
        providerId: "read-frog-free-ai",
        modelTier: "normal",
        modelRevision: "normal-r1",
      },
      scheduleAt: Date.now(),
    }
    await Promise.all([
      handler({
        data: {
          ...base,
          text: "page paragraph",
          hash: "route-batch-page-hash",
          hostedFeature: "pageTranslation",
        },
      }),
      handler({
        data: {
          ...base,
          text: "typed input",
          hash: "route-batch-input-hash",
          hostedFeature: "inputTranslation",
        },
      }),
    ])

    // A batch bills as one unit, so the route is part of the batch key: one
    // merged batch here would bill the input request to the page quota.
    expect(runStreamTextInBackgroundMock).toHaveBeenCalledTimes(2)
    const billedFeatures = runStreamTextInBackgroundMock.mock.calls
      .map((call) => (call[0] as { hostedFeature?: string }).hostedFeature)
      .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
    expect(billedFeatures).toEqual(["inputTranslation", "pageTranslation"])
  })

  it("bills the webpage summary against the sender's route and stamps an idempotency key", async () => {
    generateTextForProviderRefMock.mockResolvedValue("hosted summary")
    generateArticleSummaryMock.mockImplementation(
      async (
        _title: string,
        _text: string,
        routing: { providerRef: unknown; hostedFeature: string },
        options: {
          generate: (payload: unknown, runOptions: unknown) => Promise<string>
        },
      ) =>
        options.generate(
          {
            ...routing,
            instructions: "sys",
            prompt: "user",
          },
          { signal: undefined },
        ),
    )
    const hostedRef = {
      kind: "system" as const,
      providerId: "read-frog-advance-ai",
      modelTier: "advance",
      modelRevision: "advance-r1",
    }
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("getOrGenerateWebPageSummary")
    const result = await handler({
      data: {
        webTitle: "Page title",
        webContent: "page body",
        providerRef: hostedRef,
        hostedFeature: "inputTranslation",
      },
    })

    expect(result).toBe("hosted summary")
    // The summary is a sub-call of the triggering feature: gate (content side)
    // and billing (here) must name the same route.
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(
      "Page title",
      "page body",
      { providerRef: hostedRef, hostedFeature: "inputTranslation" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(generateTextForProviderRefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostedFeature: "inputTranslation",
        requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i),
      }),
      expect.anything(),
    )
  })

  it("exposes webpage summary generation as a separate background handler", async () => {
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()

    const handler = getRegisteredMessageHandler("getOrGenerateWebPageSummary")
    const result = await handler({
      data: {
        webTitle: "Page title",
        webContent: "page body",
        providerRef: { kind: "local" as const, config: llmProvider },
      },
    })

    expect(result).toBe("Generated summary")
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(
      "Page title",
      "page body",
      { providerRef: { kind: "local", config: llmProvider } },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("exposes subtitle summary generation as a separate background handler", async () => {
    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("getSubtitlesSummary")
    const result = await handler({
      data: {
        videoTitle: "Video title",
        subtitlesContext: "subtitle transcript",
        providerRef: { kind: "local" as const, config: llmProvider },
      },
    })

    expect(result).toBe("Generated summary")
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(
      "Video title",
      "subtitle transcript",
      { providerRef: { kind: "local", config: llmProvider }, hostedFeature: "videoSubtitles" },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("refuses a summary for a provider with no model to prompt", async () => {
    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("getSubtitlesSummary")
    // Google is a legal videoSubtitles provider — the capability admits any
    // translate provider — but it cannot be prompted. Admitting this to the
    // queue means a task that throws and burns its retries at the start of
    // every video.
    const result = await handler({
      data: {
        videoTitle: "Video title",
        subtitlesContext: "subtitle transcript",
        providerRef: { kind: "local" as const, config: googleProvider },
      },
    })

    expect(result).toBeNull()
    expect(generateArticleSummaryMock).not.toHaveBeenCalled()
  })

  it("returns null for invalid subtitle summary requests", async () => {
    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("getSubtitlesSummary")
    const result = await handler({
      data: {
        videoTitle: "",
        subtitlesContext: "subtitle transcript",
        providerRef: { kind: "local" as const, config: llmProvider },
      },
    })

    expect(result).toBeNull()
    expect(generateArticleSummaryMock).not.toHaveBeenCalled()
  })

  it("returns null when subtitle summary generation has no result", async () => {
    generateArticleSummaryMock.mockResolvedValue(null)

    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("getSubtitlesSummary")
    const result = await handler({
      data: {
        videoTitle: "Video title",
        subtitlesContext: "subtitle transcript",
        providerRef: { kind: "local" as const, config: llmProvider },
      },
    })

    expect(result).toBeNull()
  })

  it("deduplicates concurrent subtitle summary generation requests", async () => {
    let resolveSummary: ((summary: string) => void) | undefined
    generateArticleSummaryMock.mockImplementation(
      () =>
        new Promise((resolve: (summary: string) => void) => {
          resolveSummary = resolve
        }),
    )

    const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
    setupSubtitlesTranslationHandlers()

    const handler = getRegisteredMessageHandler("getSubtitlesSummary")
    const firstRequest = handler({
      data: {
        videoTitle: "Video title",
        subtitlesContext: "subtitle transcript",
        providerRef: { kind: "local" as const, config: llmProvider },
      },
    })
    const secondRequest = handler({
      data: {
        videoTitle: "Video title",
        subtitlesContext: "subtitle transcript",
        providerRef: { kind: "local" as const, config: llmProvider },
      },
    })

    // The handler chain awaits queue init + cache lookups before the summary
    // thunk runs; poll until the mock's resolver is captured.
    for (let i = 0; i < 100; i++) {
      if (resolveSummary) break
      await Promise.resolve()
    }
    resolveSummary!("Generated summary")

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      "Generated summary",
      "Generated summary",
    ])
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1)
  })

  describe("batch glossary term merge", () => {
    // Never reached on the local-provider path (executeTranslate is mocked);
    // present only to satisfy executeBatchTranslation's signature.
    const promptResolver = async () => ({
      systemPrompt: "Translate accurately",
      prompt: "Source text",
    })

    function glossaryTerm(matchKey: string, target: string): MatchedTerm {
      return { matchKey, source: matchKey, target, keepOriginal: target === "" }
    }

    function batchMember(
      text: string,
      glossary: { terms?: readonly MatchedTerm[]; revision?: number } = {},
    ) {
      return {
        provider: localProviderRef(llmProvider),
        text,
        langConfig: DEFAULT_CONFIG.language,
        hash: `glossary-merge-${text}`,
        scheduleAt: Date.now(),
        glossaryTerms: glossary.terms,
        glossaryRevision: glossary.revision,
      }
    }

    /** The terms the batch actually sent, as executeBatchTranslation merged them. */
    async function mergedTermsFor(dataList: ReturnType<typeof batchMember>[]) {
      const { executeBatchTranslation } = await import("../translation-queues")
      await executeBatchTranslation(dataList, promptResolver)
      const options = executeTranslateMock.mock.calls.at(-1)![4] as {
        glossaryTerms?: readonly MatchedTerm[]
      }
      return options.glossaryTerms
    }

    it("settles a matchKey collision by the higher revision, whichever order it arrives in", async () => {
      const oldWording = glossaryTerm("api", "接口")
      const newWording = glossaryTerm("api", "API 接口")

      // Members race through prompt rendering, so dataList order is a coin
      // flip: the same revision has to win from either end.
      await expect(
        mergedTermsFor([
          batchMember("newer first", { terms: [newWording], revision: 7 }),
          batchMember("older second", { terms: [oldWording], revision: 3 }),
        ]),
      ).resolves.toEqual([newWording])

      await expect(
        mergedTermsFor([
          batchMember("older first", { terms: [oldWording], revision: 3 }),
          batchMember("newer second", { terms: [newWording], revision: 7 }),
        ]),
      ).resolves.toEqual([newWording])
    })

    it("never lets a member with no revision displace one that has a revision", async () => {
      const revisioned = glossaryTerm("api", "API 接口")
      // A sender that predates the field — an old content script still live
      // across an update — cannot say how fresh its terms are.
      const unversioned = glossaryTerm("api", "接口")

      await expect(
        mergedTermsFor([
          batchMember("unversioned first", { terms: [unversioned] }),
          batchMember("revisioned second", { terms: [revisioned], revision: 5 }),
        ]),
      ).resolves.toEqual([revisioned])

      await expect(
        mergedTermsFor([
          batchMember("revisioned first", { terms: [revisioned], revision: 5 }),
          batchMember("unversioned second", { terms: [unversioned] }),
        ]),
      ).resolves.toEqual([revisioned])
    })

    it("drops a term two members disagree on at the same revision", async () => {
      // One glossary state cannot hold two wordings for one key, so equal
      // revisions carrying different ones means the stamp is untrustworthy for
      // that key. Sending nothing costs the wording once; guessing sends the
      // wrong one half the time and then caches it.
      const oneWording = glossaryTerm("api", "接口")
      const otherWording = glossaryTerm("api", "API 接口")
      const untouched = glossaryTerm("queue", "队列")

      await expect(
        mergedTermsFor([
          batchMember("first", { terms: [oneWording, untouched], revision: 4 }),
          batchMember("second", { terms: [otherWording], revision: 4 }),
        ]),
      ).resolves.toEqual([untouched])
    })

    it("keeps a term both members agree on at the same revision", async () => {
      // The overwhelmingly normal case: two paragraphs matched the same term
      // against the same compiled matcher.
      const api = glossaryTerm("api", "接口")

      await expect(
        mergedTermsFor([
          batchMember("first", { terms: [api], revision: 4 }),
          batchMember("second", { terms: [glossaryTerm("api", "接口")], revision: 4 }),
        ]),
      ).resolves.toEqual([api])
    })

    it("lets a strictly newer revision settle a key an earlier tie left unresolvable", async () => {
      const oneWording = glossaryTerm("api", "接口")
      const otherWording = glossaryTerm("api", "API 接口")
      const newest = glossaryTerm("api", "应用接口")

      // The tie must not survive a member that can actually answer, in either
      // order relative to it.
      await expect(
        mergedTermsFor([
          batchMember("tie a", { terms: [oneWording], revision: 4 }),
          batchMember("tie b", { terms: [otherWording], revision: 4 }),
          batchMember("newest", { terms: [newest], revision: 9 }),
        ]),
      ).resolves.toEqual([newest])

      await expect(
        mergedTermsFor([
          batchMember("newest", { terms: [newest], revision: 9 }),
          batchMember("tie a", { terms: [oneWording], revision: 4 }),
          batchMember("tie b", { terms: [otherWording], revision: 4 }),
        ]),
      ).resolves.toEqual([newest])
    })

    it("unions terms from different members when nothing collides", async () => {
      const api = glossaryTerm("api", "接口")
      const queue = glossaryTerm("queue", "队列")

      await expect(
        mergedTermsFor([
          batchMember("first", { terms: [queue], revision: 2 }),
          batchMember("second", { terms: [api], revision: 9 }),
        ]),
      ).resolves.toEqual([api, queue])
    })

    it("returns undefined when no member resolved terms, so the prompt resolver can", async () => {
      await expect(
        mergedTermsFor([batchMember("first"), batchMember("second")]),
      ).resolves.toBeUndefined()
    })

    it("returns an empty list when any member resolved nothing, suppressing that fallback", async () => {
      await expect(
        mergedTermsFor([batchMember("first"), batchMember("second", { terms: [], revision: 4 })]),
      ).resolves.toEqual([])
    })
  })

  describe("glossary terms on the individual fallback", () => {
    it("sends each item's own terms when a batch exhausts its retries", async () => {
      ensureInitializedConfigMock.mockResolvedValue({
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: llmProvider.id,
          requestQueueConfig: { rate: 10, capacity: 10 },
          batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
        },
      })

      const apiTerm: MatchedTerm = {
        matchKey: "api",
        source: "api",
        target: "接口",
        keepOriginal: false,
      }
      const queueTerm: MatchedTerm = {
        matchKey: "queue",
        source: "queue",
        target: "队列",
        keepOriginal: false,
      }

      // One segment back for a two-item batch is a BatchCountMismatchError,
      // the only failure BatchQueue retries and then falls back on.
      executeTranslateMock.mockImplementation(async (text: string) =>
        text.includes(BATCH_SEPARATOR) ? "single segment" : `translated ${text}`,
      )

      const { setupPageTranslationHandlers } = await import("../page-translation")
      setupPageTranslationHandlers()
      const handler = getRegisteredMessageHandler("enqueueTranslateRequest")

      const results = await Promise.all([
        handler({
          data: {
            text: "alpha",
            langConfig: DEFAULT_CONFIG.language,
            providerRef: localProviderRef(llmProvider),
            scheduleAt: Date.now(),
            hash: "fallback-glossary-one",
            glossaryTerms: [apiTerm],
            glossaryRevision: 4,
          },
        }),
        handler({
          data: {
            text: "beta",
            langConfig: DEFAULT_CONFIG.language,
            providerRef: localProviderRef(llmProvider),
            scheduleAt: Date.now(),
            hash: "fallback-glossary-two",
            glossaryTerms: [queueTerm],
            glossaryRevision: 4,
          },
        }),
      ])

      expect(results).toEqual(["translated alpha", "translated beta"])

      const optionsFor = (text: string) =>
        executeTranslateMock.mock.calls.find(([sent]) => sent === text)![4] as {
          isBatch?: boolean
          glossaryTerms?: readonly MatchedTerm[]
        }

      // The batch that failed carried the union...
      const batchOptions = executeTranslateMock.mock.calls
        .filter(([sent]) => String(sent).includes(BATCH_SEPARATOR))
        .at(-1)![4]
      expect(batchOptions).toMatchObject({ isBatch: true, glossaryTerms: [apiTerm, queueTerm] })

      // ...each fallback request carries only its own item's terms. Dropping
      // them here would cache a glossary-less translation under a hash taken
      // over a prompt that had the terms in it.
      expect(optionsFor("alpha").glossaryTerms).toEqual([apiTerm])
      expect(optionsFor("beta").glossaryTerms).toEqual([queueTerm])
      expect(optionsFor("alpha").isBatch).toBeUndefined()
    }, 15_000)
  })

  // The merge above runs BELOW the batch key, so it can only ever see members
  // the key already agreed to put together. These go through the real
  // `enqueueTranslateRequest` handler so the BatchQueue actually applies
  // `getBatchKey`.
  describe("glossary revision in the batch key", () => {
    const apiTerm: MatchedTerm = {
      matchKey: "api",
      source: "api",
      target: "接口",
      keepOriginal: false,
    }

    const queueTerm: MatchedTerm = {
      matchKey: "queue",
      source: "queue",
      target: "队列",
      keepOriginal: false,
    }

    // Byte-identical on every member, so `context` — the only other per-page
    // component of the key — cannot be what separates them.
    const pageContext = {
      webTitle: "Page title",
      webDescription: "Page description",
      webContent: "Page body",
    }

    const JOINED = `\n\n${BATCH_SEPARATOR}\n\n`

    /** Room for every member of these tests in one batch, so a split is the key's doing. */
    function useBatchingConfig() {
      ensureInitializedConfigMock.mockResolvedValue({
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: llmProvider.id,
          requestQueueConfig: { rate: 10, capacity: 10 },
          batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
        },
      })

      // Echo one segment per segment received. A batch that came back with the
      // wrong count would retry and then fall back to individual requests,
      // which would inflate the call count these tests read.
      executeTranslateMock.mockImplementation(async (text: string) =>
        text
          .split(JOINED)
          .map((segment) => `translated ${segment}`)
          .join(JOINED),
      )
    }

    async function startHandler() {
      const { setupPageTranslationHandlers } = await import("../page-translation")
      setupPageTranslationHandlers()
      return getRegisteredMessageHandler("enqueueTranslateRequest")
    }

    function enqueue(
      handler: ReturnType<typeof getRegisteredMessageHandler>,
      text: string,
      glossary: { terms?: readonly MatchedTerm[]; revision?: number } = {},
    ) {
      return handler({
        data: {
          ...pageContext,
          text,
          langConfig: DEFAULT_CONFIG.language,
          providerRef: localProviderRef(llmProvider),
          scheduleAt: Date.now(),
          // Distinct per member: the dedup key is the hash, and two members
          // sharing one would collapse into a single task before any batching.
          hash: `revision-key-${text}`,
          glossaryTerms: glossary.terms,
          glossaryRevision: glossary.revision,
        },
      })
    }

    /** What each model call was asked to translate, in call order. */
    const sentTexts = () => executeTranslateMock.mock.calls.map(([text]) => text as string)

    const optionsFor = (text: string) =>
      executeTranslateMock.mock.calls.find(([sent]) => sent === text)![4] as {
        isBatch?: boolean
        glossaryTerms?: readonly MatchedTerm[]
      }

    it("splits the batch when one member's term list was emptied mid-page", async () => {
      useBatchingConfig()
      const handler = await startHandler()

      // Both texts contain the term, and the context is identical, so without
      // the revision in the key these are one batch. B was resolved after the
      // user deleted the term: an EMPTY list at a NEWER revision. Absence is
      // not a vote in `mergeBatchGlossaryTerms` — it cannot out-vote A — so a
      // shared batch would apply the deleted wording to B's text and cache the
      // result under a hash built with no terms at all, the same hash a
      // re-translation computes, so nothing would ever evict it.
      await expect(
        Promise.all([
          enqueue(handler, "the api is fast", { terms: [apiTerm], revision: 3 }),
          enqueue(handler, "the api is slow", { terms: [], revision: 4 }),
        ]),
      ).resolves.toEqual(["translated the api is fast", "translated the api is slow"])

      expect(sentTexts()).toHaveLength(2)
      expect(sentTexts()).toEqual(expect.arrayContaining(["the api is fast", "the api is slow"]))
      // Two calls could also mean the batch failed and fell back per item; these
      // are two batches of one, each still on the batch path.
      expect(optionsFor("the api is fast")).toMatchObject({
        isBatch: true,
        glossaryTerms: [apiTerm],
      })
      // The removal survives as a removal, which is the whole point.
      expect(optionsFor("the api is slow")).toMatchObject({ isBatch: true, glossaryTerms: [] })
    }, 15_000)

    it("splits the batch when a member carries no revision because the feature was switched off", async () => {
      useBatchingConfig()
      const handler = await startHandler()

      // Switching the glossary off mid-page bumps NO revision: the resolver
      // returns {terms: [], revision: 0}. Revision 0 loses every comparison in
      // `mergeBatchGlossaryTerms`, so no merge rule can reach this case — it is
      // the batch key or nothing.
      await expect(
        Promise.all([
          enqueue(handler, "the api is fast", { terms: [apiTerm], revision: 3 }),
          enqueue(handler, "the api is slow", { terms: [], revision: 0 }),
        ]),
      ).resolves.toEqual(["translated the api is fast", "translated the api is slow"])

      expect(sentTexts()).toHaveLength(2)
      expect(sentTexts()).toEqual(expect.arrayContaining(["the api is fast", "the api is slow"]))
      expect(optionsFor("the api is fast")).toMatchObject({
        isBatch: true,
        glossaryTerms: [apiTerm],
      })
      expect(optionsFor("the api is slow")).toMatchObject({ isBatch: true, glossaryTerms: [] })
    }, 15_000)

    it("still batches every paragraph of a page together at one revision", async () => {
      useBatchingConfig()
      const handler = await startHandler()

      // The steady state: the revision is one global counter, so every
      // paragraph of a page carries the same value and the component is inert.
      // If this ever splits, batching is off for everyone using a glossary.
      //
      // The four term LISTS deliberately all differ, because that is the
      // regression this guards: real paragraphs each match a different subset,
      // so anyone who puts the term list back into `getBatchKey` would give
      // every paragraph its own batch. Four identical lists could not see that.
      const members = [
        { text: "first para", terms: [apiTerm] },
        { text: "second para", terms: [] },
        { text: "third para", terms: [apiTerm, queueTerm] },
        { text: "fourth para", terms: [queueTerm] },
      ]
      await expect(
        Promise.all(
          members.map((member) =>
            enqueue(handler, member.text, { terms: member.terms, revision: 4 }),
          ),
        ),
      ).resolves.toEqual(members.map((member) => `translated ${member.text}`))

      expect(sentTexts()).toEqual([members.map((member) => member.text).join(JOINED)])
    }, 15_000)

    it("still batches paragraphs that carry no revision at all", async () => {
      useBatchingConfig()
      const handler = await startHandler()

      // Everyone not using a glossary, plus any content script that predates
      // the field. The mixture is the point: `?? 0` is only load-bearing when an
      // explicit 0 sits beside an absent one — an old content script alongside a
      // new one with the glossary switched off, on one page. Four absent values
      // would fold onto one key with or without it.
      const members = [
        { text: "first para", glossary: {} },
        { text: "second para", glossary: { revision: 0 } },
        { text: "third para", glossary: {} },
        { text: "fourth para", glossary: { terms: [], revision: 0 } },
      ]
      await expect(
        Promise.all(members.map((member) => enqueue(handler, member.text, member.glossary))),
      ).resolves.toEqual(members.map((member) => `translated ${member.text}`))

      expect(sentTexts()).toEqual([members.map((member) => member.text).join(JOINED)])
    }, 15_000)
  })
})
