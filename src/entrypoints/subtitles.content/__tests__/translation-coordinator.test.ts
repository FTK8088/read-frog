import type { Config } from "@/types/config/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { SUBTITLES_SUMMARY_WAIT_TIMEOUT_MS } from "@/utils/constants/subtitles"
import { TranslationCoordinator } from "../translation-coordinator"

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: vi.fn<() => Promise<Config | null>>(async () => null),
}))

beforeEach(() => {
  vi.mocked(getLocalConfig).mockResolvedValue(null)
})
afterEach(() => vi.restoreAllMocks())

describe("initial subtitle context deadline", () => {
  let coordinator: TranslationCoordinator

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    coordinator?.stop()
    vi.useRealTimers()
  })

  async function createWaitingSession() {
    const translator = await import("@/utils/subtitles/processor/translator")
    const spy = vi
      .spyOn(translator, "translateSubtitles")
      .mockImplementation(async (fragments) =>
        fragments.map((f) => ({ ...f, translation: `t:${f.text}` })),
      )
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const video = Object.assign(new EventTarget(), { currentTime: 0, playbackRate: 1 })
    const onTranslated = vi.fn<(...args: any[]) => any>()
    coordinator = new TranslationCoordinator({
      getFragments: () => [
        { text: "start", start: 0, end: 1000 },
        { text: "later", start: 70_000, end: 71_000 },
      ],
      getVideoElement: () => video as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      initialContext: { ready, deadline: Date.now() + SUBTITLES_SUMMARY_WAIT_TIMEOUT_MS },
      onTranslated,
      onStateChange: vi.fn<(...args: any[]) => any>(),
    })
    coordinator.start()
    return { spy, video, release, onTranslated }
  }

  it("keeps the original deadline across stop and resume", async () => {
    const { spy } = await createWaitingSession()
    await vi.advanceTimersByTimeAsync(3000)
    coordinator.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    coordinator.start()
    await vi.advanceTimersByTimeAsync(1999)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("does not wait again when resumed after the deadline", async () => {
    const { spy } = await createWaitingSession()
    coordinator.stop()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(spy).not.toHaveBeenCalled()
    coordinator.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("does not restart translation when context arrives after stopping", async () => {
    const { spy, release, onTranslated } = await createWaitingSession()
    coordinator.stop()
    release()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(spy).not.toHaveBeenCalled()
    expect(onTranslated).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    coordinator.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("does not restart a reset session on context completion or timeout", async () => {
    const { spy, release } = await createWaitingSession()
    coordinator.reset()
    release()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(spy).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("blocks every trigger while waiting and selects cues at the latest playback position", async () => {
    const { spy, video } = await createWaitingSession()
    video.currentTime = 70
    video.dispatchEvent(new Event("timeupdate"))
    video.dispatchEvent(new Event("seeked"))
    coordinator.requestTick()
    coordinator.noteFragmentListChanged()
    await vi.advanceTimersByTimeAsync(9999)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0].map((f) => f.text)).toEqual(["later"])
  })
})

describe("translation coordinator loading state", () => {
  it("sets loading for the active untranslated cue", () => {
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => [{ text: "hello", start: 0, end: 1000 }],
      getVideoElement: () => ({ currentTime: 0.5 }) as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    ;(coordinator as any).updateLoadingStateAt(500, [{ text: "hello", start: 0, end: 1000 }])

    expect(onStateChange).toHaveBeenCalledWith("loading")
  })

  it("does not keep loading in a cue gap just because the next cue is untranslated", () => {
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => [
        { text: "hello", start: 0, end: 1000 },
        { text: "world", start: 2000, end: 3000 },
      ],
      getVideoElement: () => ({ currentTime: 1.5 }) as HTMLVideoElement,
      getCurrentState: () => "loading",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    // Pretend we were loading on the previous cue.
    ;(coordinator as any).lastEmittedState = "loading"
    ;(coordinator as any).updateLoadingStateAt(1500, [
      { text: "hello", start: 0, end: 1000 },
      { text: "world", start: 2000, end: 3000 },
    ])

    expect(onStateChange).toHaveBeenCalledWith("idle")
  })

  it("clears adapter loading during a music intro with no active cue", () => {
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => [{ text: "lyrics start later", start: 30_000, end: 31_000 }],
      getVideoElement: () => ({ currentTime: 5 }) as HTMLVideoElement,
      // Scheduler was set to loading while source subtitles were fetched.
      getCurrentState: () => "loading",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    // Coordinator starts with lastEmittedState = "idle", which previously skipped clear.
    ;(coordinator as any).updateLoadingStateAt(5_000, [
      { text: "lyrics start later", start: 30_000, end: 31_000 },
    ])

    expect(onStateChange).toHaveBeenCalledWith("idle")
  })

  it("does not chain another translation tick after stop", async () => {
    const onTranslated = vi.fn<(...args: any[]) => any>()
    const onStateChange = vi.fn<(...args: any[]) => any>()
    let resolveTranslate!: (value: any) => void
    const translatePromise = new Promise((resolve) => {
      resolveTranslate = resolve
    })

    const translator = await import("@/utils/subtitles/processor/translator")
    const spy = vi
      .spyOn(translator, "translateSubtitles")
      .mockImplementation(() => translatePromise as any)

    const coordinator = new TranslationCoordinator({
      getFragments: () => [
        { text: "a", start: 0, end: 1000 },
        { text: "b", start: 1000, end: 2000 },
        { text: "c", start: 2000, end: 3000 },
        { text: "d", start: 3000, end: 4000 },
        { text: "e", start: 4000, end: 5000 },
        { text: "f", start: 5000, end: 6000 },
      ],
      getVideoElement: () =>
        ({
          currentTime: 0,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated,
      onStateChange,
    })

    coordinator.start()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))

    coordinator.stop()
    const firstCall = spy.mock.calls[0]!
    const batch = firstCall[0] as Array<{ text: string; start: number; end: number }>
    resolveTranslate(batch.map((f) => ({ ...f, translation: `t:${f.text}` })))
    await Promise.resolve()
    await Promise.resolve()

    // In-flight call may finish, but stop must not chain another nearby batch.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(onTranslated).not.toHaveBeenCalled()

    spy.mockRestore()
  })

  it("invalidates translated bookkeeping when the same start is recut", () => {
    let fragments = [{ text: "hello world", start: 0, end: 2000 }]
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => fragments,
      getVideoElement: () =>
        ({
          currentTime: 0.2,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    // noteFragmentListChanged is a no-op when inactive.
    ;(coordinator as any).active = true
    ;(coordinator as any).translatedStarts.add(0)
    ;(coordinator as any).knownIdentities.set(0, "2000\0hello world")

    // AI re-segmentation keeps start=0 but shortens the cue.
    fragments = [
      { text: "hello", start: 0, end: 1000 },
      { text: "world", start: 1000, end: 2000 },
    ]
    coordinator.noteFragmentListChanged()

    // Old completion must be invalidated so the recut line can be translated again.
    expect((coordinator as any).translatedStarts.has(0)).toBe(false)
    // Old baseline identity must not stick around as if still valid.
    expect((coordinator as any).knownIdentities.get(0)).not.toBe("2000\0hello world")
  })

  it("does not apply in-flight results after stop then start", async () => {
    const onTranslated = vi.fn<(...args: any[]) => any>()
    const resolvers: Array<(value: any) => void> = []
    const translator = await import("@/utils/subtitles/processor/translator")
    const spy = vi.spyOn(translator, "translateSubtitles").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }) as any,
    )

    const coordinator = new TranslationCoordinator({
      getFragments: () => [{ text: "a", start: 0, end: 1000 }],
      getVideoElement: () =>
        ({
          currentTime: 0.2,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated,
      onStateChange: vi.fn<(...args: any[]) => any>(),
    })

    coordinator.start()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))

    coordinator.stop()
    coordinator.start()
    // Resume must be able to start a new batch (isTranslating not stuck).
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2))

    // Stale first-run result.
    resolvers[0]!([{ text: "a", start: 0, end: 1000, translation: "STALE" }])
    await Promise.resolve()
    await Promise.resolve()
    expect(onTranslated).not.toHaveBeenCalled()

    // Current-run result.
    resolvers[1]!([{ text: "a", start: 0, end: 1000, translation: "FRESH" }])
    await Promise.resolve()
    await Promise.resolve()
    await vi.waitFor(() =>
      expect(onTranslated).toHaveBeenCalledWith([
        expect.objectContaining({ translation: "FRESH" }),
      ]),
    )

    spy.mockRestore()
  })

  it("widens the translation look-ahead window with playback rate", async () => {
    const translator = await import("@/utils/subtitles/processor/translator")

    async function firstBatchStartsAtRate(playbackRate: number): Promise<number[]> {
      const spy = vi
        .spyOn(translator, "translateSubtitles")
        .mockImplementation((batch: any) => Promise.resolve(batch) as any)

      const coordinator = new TranslationCoordinator({
        // near cue (in the 1x window) + far cue (only reachable at higher rates)
        getFragments: () => [
          { text: "near", start: 1000, end: 2000 },
          { text: "far", start: 60_000, end: 61_000 },
        ],
        getVideoElement: () =>
          ({
            currentTime: 0,
            playbackRate,
            addEventListener: vi.fn<(...args: any[]) => any>(),
            removeEventListener: vi.fn<(...args: any[]) => any>(),
          }) as unknown as HTMLVideoElement,
        getCurrentState: () => "idle",
        segmentationPipeline: null,
        onTranslated: vi.fn<(...args: any[]) => any>(),
        onStateChange: vi.fn<(...args: any[]) => any>(),
      })

      coordinator.start()
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      coordinator.stop()

      const batch = (spy.mock.calls[0]?.[0] ?? []) as Array<{ start: number }>
      spy.mockRestore()
      return batch.map((f) => f.start)
    }

    // 1x: 30s window excludes the 60s cue.
    expect(await firstBatchStartsAtRate(1)).toEqual([1000])
    // 3x: 90s window now reaches the 60s cue.
    expect(await firstBatchStartsAtRate(3)).toEqual([1000, 60_000])
  })

  it("does not publish stale batch cues on translation failure after a recut", async () => {
    let fragments = [
      { text: "hello world", start: 0, end: 2000 },
      { text: "next", start: 2000, end: 3000 },
    ]
    const onTranslated = vi.fn<(...args: any[]) => any>()
    const onStateChange = vi.fn<(...args: any[]) => any>()

    const translator = await import("@/utils/subtitles/processor/translator")
    let rejectTranslate!: (error: Error) => void
    const spy = vi.spyOn(translator, "translateSubtitles").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectTranslate = reject
        }),
    )

    const config = await import("@/utils/config/storage")
    const configSpy = vi.spyOn(config, "getLocalConfig").mockResolvedValue({
      ...DEFAULT_CONFIG,
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        style: { ...DEFAULT_CONFIG.videoSubtitles.style, displayMode: "bilingual" },
      },
    } as any)

    const coordinator = new TranslationCoordinator({
      getFragments: () => fragments,
      getVideoElement: () =>
        ({
          currentTime: 0.2,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated,
      onStateChange,
    })

    coordinator.start()
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    // Recut mid-request: original cue is gone; only identity-valid fallbacks may publish.
    fragments = [
      { text: "hello", start: 0, end: 1000 },
      { text: "world", start: 1000, end: 2000 },
      { text: "next", start: 2000, end: 3000 },
    ]
    rejectTranslate(new Error("translate failed"))
    await vi.waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith("error", { message: "translate failed" })
    })

    // Stale full-batch fallback would re-introduce the pre-recut cue as a zombie.
    const published = onTranslated.mock.calls.flatMap((call) => call[0] as any[])
    expect(published.every((f) => f.text !== "hello world")).toBe(true)
    // Empty translation fallbacks for still-valid cues are fine; identity-mismatched are not.
    expect(published.some((f) => f.start === 0 && f.end === 2000)).toBe(false)

    spy.mockRestore()
    configSpy.mockRestore()
  })
})

describe("configured AI subtitle groups", () => {
  function configWithBatchSize(size: number) {
    return {
      ...DEFAULT_CONFIG,
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        providerId: "openai-default",
        batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: size },
      },
    }
  }

  async function createSession(count = 23) {
    const translator = await import("@/utils/subtitles/processor/translator")
    const spy = vi
      .spyOn(translator, "translateSubtitles")
      .mockImplementation(async (fragments) =>
        fragments.map((f) => ({ ...f, translation: `t:${f.text}` })),
      )
    const fragments = Array.from({ length: count }, (_, index) => ({
      text: `line ${index}`,
      start: index * 10_000,
      end: index * 10_000 + 5000,
    }))
    const video = {
      currentTime: 0,
      playbackRate: 1,
      addEventListener: vi.fn<(...args: any[]) => any>(),
      removeEventListener: vi.fn<(...args: any[]) => any>(),
    } as unknown as HTMLVideoElement
    const coordinator = new TranslationCoordinator({
      getFragments: () => fragments,
      getVideoElement: () => video,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange: vi.fn<(...args: any[]) => any>(),
    })
    return { coordinator, spy, video }
  }

  it("selects ten lines beyond the window and waits until the next group is near", async () => {
    vi.mocked(getLocalConfig).mockResolvedValue(configWithBatchSize(10))
    const { coordinator, spy, video } = await createSession()
    coordinator.start()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]![0]).toHaveLength(10)
    expect(spy.mock.calls[0]![0].at(-1)!.start).toBe(90_000)

    video.currentTime = 69
    coordinator.requestTick()
    // Wait for the config read and the no-work pass, not just a single microtask.
    await vi.waitFor(() => expect((coordinator as any).isTranslating).toBe(false))
    expect(spy).toHaveBeenCalledTimes(1)
    video.currentTime = 70
    coordinator.requestTick()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(spy.mock.calls[1]![0].map((f) => f.start)).toEqual(
      Array.from({ length: 10 }, (_, i) => (10 + i) * 10_000),
    )

    video.currentTime = 170
    coordinator.requestTick()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3))
    expect(spy.mock.calls[2]![0]).toHaveLength(3)
    coordinator.stop()
  })

  it("reads a changed batch size for the next group", async () => {
    vi.mocked(getLocalConfig).mockResolvedValue(configWithBatchSize(10))
    const { coordinator, spy, video } = await createSession()
    coordinator.start()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    vi.mocked(getLocalConfig).mockResolvedValue(configWithBatchSize(3))
    video.currentTime = 70
    coordinator.requestTick()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(spy.mock.calls[1]![0]).toHaveLength(3)
    coordinator.stop()
  })

  it("keeps non-AI subtitles inside the old window regardless of the batch setting", async () => {
    const config = configWithBatchSize(10)
    config.videoSubtitles.providerId = "google-translate-default"
    vi.mocked(getLocalConfig).mockResolvedValue(config)
    const { coordinator, spy } = await createSession()
    coordinator.start()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]![0]).toHaveLength(4)
    coordinator.stop()
  })

  it("does not start a request after stopping during the config read", async () => {
    let resolveConfig!: (value: typeof DEFAULT_CONFIG) => void
    vi.mocked(getLocalConfig).mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve
      }),
    )
    const { coordinator, spy } = await createSession()
    coordinator.start()
    coordinator.stop()
    resolveConfig(configWithBatchSize(10))
    await Promise.resolve()
    await Promise.resolve()
    expect(spy).not.toHaveBeenCalled()
  })
})
