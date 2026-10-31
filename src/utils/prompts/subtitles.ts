import type { TranslatePromptOptions, TranslatePromptResult } from "./translate"
import type { SubtitlePromptContext } from "@/types/content"
import { getLocalConfig } from "@/utils/config/storage"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { appendGlossaryToSystemPrompt } from "@/utils/glossary/prompt"
import { DEFAULT_CONFIG } from "../constants/config"
import {
  BATCH_SEPARATOR,
  BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS,
  DEFAULT_BATCH_TRANSLATE_PROMPT,
  DEFAULT_TRANSLATE_PROMPT_ID,
  getTokenCellText,
  SUBTITLE_INPUT,
  SUBTITLE_TARGET_LANGUAGE,
  SUBTITLE_WEB_DESCRIPTION,
  SUBTITLE_WEB_TITLE,
  VIDEO_SUMMARY,
} from "../constants/prompt"
import { resolvePromptReplacementValue } from "./translate"

const SUBTITLE_BATCH_ALIGNMENT_PROMPT = `## Subtitle Alignment Rules
These rules override any conflicting formatting instructions above:
- Translate each input subtitle into exactly one non-empty output segment in the original order, even if it contains multiple sentences or line breaks.
- Never split, merge, omit, duplicate, or add subtitles. Output only translations, without explanations or numbering.
- Put standalone ${BATCH_SEPARATOR} separator lines only between translations, never at the beginning or end. Do not output empty segments.`

export async function getSubtitlesTranslatePrompt(
  targetLang: string,
  input: string,
  options?: TranslatePromptOptions<SubtitlePromptContext>,
): Promise<TranslatePromptResult> {
  const config = (await getLocalConfig()) ?? DEFAULT_CONFIG
  const customPromptsConfig = config.videoSubtitles.customPromptsConfig
  const { patterns, promptId } = customPromptsConfig

  const resolvedPromptId = promptId || DEFAULT_TRANSLATE_PROMPT_ID
  const builtInPrompt = Object.hasOwn(BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS, resolvedPromptId)
    ? BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS[
        resolvedPromptId as keyof typeof BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS
      ]
    : undefined
  const customPrompt = patterns.find((pattern) => pattern.id === resolvedPromptId)
  const selectedPrompt =
    builtInPrompt ??
    customPrompt ??
    BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS[DEFAULT_TRANSLATE_PROMPT_ID]

  let { systemPrompt, prompt } = selectedPrompt

  // For batch mode, append batch rules to system prompt
  if (options?.isBatch) {
    systemPrompt = `${systemPrompt}

${DEFAULT_BATCH_TRANSLATE_PROMPT}

${SUBTITLE_BATCH_ALIGNMENT_PROMPT}`

    // Cache keys are built per subtitle before the final batch is known, so
    // keep the alignment rules there but add the count only at dispatch time.
    if (options.batchSize !== undefined) {
      systemPrompt += `
- This request contains exactly ${options.batchSize} subtitle items. Return exactly ${options.batchSize} translated segments and exactly ${options.batchSize - 1} standalone ${BATCH_SEPARATOR} separator lines.`
    }
  }

  // Build title and summary replacement values
  const title = resolvePromptReplacementValue(options?.context?.webTitle, "No title available")
  const description = resolvePromptReplacementValue(
    options?.context?.webDescription,
    "No description available",
  )
  const summary = resolvePromptReplacementValue(
    options?.context?.videoSummary,
    "No summary available",
  )

  // Replace tokens in both prompts
  const replaceTokens = (text: string) =>
    text
      .replaceAll(getTokenCellText(SUBTITLE_TARGET_LANGUAGE), targetLang)
      .replaceAll(getTokenCellText(SUBTITLE_INPUT), input)
      .replaceAll(getTokenCellText(SUBTITLE_WEB_TITLE), title)
      .replaceAll(getTokenCellText(SUBTITLE_WEB_DESCRIPTION), description)
      .replaceAll(getTokenCellText(VIDEO_SUMMARY), summary)

  // Same contract as the page-translation builder: appended AFTER token
  // replacement so a term cannot rewrite the prompt around it, and omitted
  // entirely when nothing matched so the prompt — which subtitles also fold into
  // their cache key (subtitles/processor/translator.ts:143) — stays identical
  // for a user whose glossary missed this cue.
  const resolvedSystemPrompt = replaceTokens(systemPrompt)
  const glossaryTerms =
    options?.glossaryTerms ??
    (await resolveGlossaryTerms(input, config.glossary.enabled, config.language.targetCode)).terms
  return {
    systemPrompt: appendGlossaryToSystemPrompt(resolvedSystemPrompt, glossaryTerms),
    prompt: replaceTokens(prompt),
  }
}
