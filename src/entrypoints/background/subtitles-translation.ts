import type { SubtitlePromptContext } from "@/types/content"
import type { SubtitleTranslationRequest, SubtitleTranslationResult } from "@/utils/message"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { normalizePromptContextValue } from "@/utils/host/translate/translate-text"
import { onMessage } from "@/utils/message"
import { getSubtitlesTranslatePrompt } from "@/utils/prompts/subtitles"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
  createSubtitlesTranslationQueues,
  getLocalProviderConfig,
  shouldUseBatchQueue,
} from "./translation-queues"

/** Register handlers synchronously while queue initialization runs in the background. */
export function setupSubtitlesTranslationHandlers(): void {
  const queuesPromise = createSubtitlesTranslationQueues()

  async function translateRequests(requests: SubtitleTranslationRequest[], immediate: boolean) {
    const { requestQueue, batchQueue } = await queuesPromise
    // Complete every lookup before admitting any item: a slow cache read must
    // not let the 100ms collector split a group that was selected together.
    const cached = await Promise.all(
      requests.map(async (request) =>
        request.hash ? db.translationCache.get(request.hash) : undefined,
      ),
    )
    const batchData = requests.flatMap((request, index) => {
      if (cached[index] || !shouldUseBatchQueue(request.providerRef)) return []
      const context: SubtitlePromptContext = {
        webTitle: normalizePromptContextValue(request.webTitle),
        webDescription: normalizePromptContextValue(request.webDescription),
        videoSummary: normalizePromptContextValue(request.summary),
      }
      return [
        {
          text: request.text,
          langConfig: request.langConfig,
          provider: request.providerRef,
          hostedFeature: "videoSubtitles" as const,
          hash: request.hash,
          scheduleAt: request.scheduleAt,
          context,
          glossaryTerms: request.glossaryTerms,
          glossaryRevision: request.glossaryRevision,
        },
      ]
    })
    const batchPromises = immediate
      ? batchQueue.enqueueBatch(batchData)
      : batchData.map((data) => batchQueue.enqueue(data))
    let batchIndex = 0
    return Promise.allSettled(
      requests.map(async (request, index) => {
        const hit = cached[index]
        if (hit) return hit.translation

        let translation: string
        if (shouldUseBatchQueue(request.providerRef)) {
          translation = await batchPromises[batchIndex++]!
        } else {
          const localConfig = getLocalProviderConfig(request.providerRef)
          if (!localConfig) {
            throw new Error("Built-in AI subtitle translation must use the batch queue")
          }
          const thunk = (signal?: AbortSignal) =>
            executeTranslate(
              request.text,
              request.langConfig,
              localConfig,
              getSubtitlesTranslatePrompt,
              {
                signal,
                glossaryTerms: request.glossaryTerms,
              },
            )
          translation = await requestQueue.enqueue(thunk, request.scheduleAt, request.hash)
        }
        if (translation && request.hash) {
          await db.translationCache.put({
            key: request.hash,
            translation,
            createdAt: new Date(),
          })
        }
        return translation
      }),
    )
  }

  // Keep the single-item protocol for content scripts already open across an update.
  onMessage("enqueueSubtitlesTranslateRequest", async ({ data }) => {
    const [result] = await translateRequests([data], false)
    if (result!.status === "rejected") throw result!.reason
    return result!.value
  })

  onMessage("enqueueSubtitlesTranslateBatch", async ({ data }) => {
    const results = await translateRequests(data.requests, true)
    return results.map((result): SubtitleTranslationResult =>
      result.status === "fulfilled"
        ? { translation: result.value }
        : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) },
    )
  })

  onMessage("getSubtitlesSummary", async (message) => {
    const { requestQueue } = await queuesPromise
    const { videoTitle, subtitlesContext, providerRef } = message.data

    // Guarded on both sides: the content script should not send this for a
    // provider with no model to prompt, and the queue must not admit a task
    // that can only throw if it does.
    if (!videoTitle || !subtitlesContext || !canProviderRefGenerateText(providerRef)) {
      return null
    }

    return await getOrGenerateTranslationContextSummary({
      title: videoTitle,
      textContent: subtitlesContext,
      providerRef,
      hostedFeature: "videoSubtitles",
      // Deliberately without the title, matching the previous key: a video's
      // transcript identifies it, and including a title that players mutate
      // would miss the cache on every re-render.
      cacheKeyParts: [Sha256Hex(cleanText(subtitlesContext))],
      requestQueue,
    })
  })
}
