import { areSpeechPhoneticNeighbors, speechPhoneticKey } from './phonetics'

export const DEFAULT_CONTEXT_MESSAGE_COUNT = 5
export const MAX_CONTEXT_MESSAGE_COUNT = 20
export const DEFAULT_REFERENCE_CACHE_LIMIT = 30
export const MAX_REFERENCE_CACHE_LIMIT = 200
export const DEFAULT_REFERENCE_ADMISSION_OCCURRENCES = 1
export const MAX_REFERENCE_ADMISSION_OCCURRENCES = 5
export const MAX_CONTEXT_CHARACTERS = 12_000
export const NORMALIZATION_RECENT_MESSAGE_COUNT = 2
export const NORMALIZATION_RECENT_CONTEXT_CHARACTERS = 4_000
export const MAX_CONVERSATION_REFERENCE_CHARACTERS = 2_000

export interface ContextSourceMessage {
  role: 'system' | 'user' | 'assistant'
  content: unknown
  extra?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ContextMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ContextSelection {
  messages: ContextMessage[]
  selectedCount: number
  omittedCount: number
  characterCount: number
  truncated: boolean
}

export interface ConversationReferenceCorrection {
  text: string
  correctedTerms: Array<{ heard: string; canonical: string }>
}

export function clampContextMessageCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONTEXT_MESSAGE_COUNT
  return Math.min(MAX_CONTEXT_MESSAGE_COUNT, Math.max(0, Math.trunc(value)))
}

export function clampReferenceCacheLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REFERENCE_CACHE_LIMIT
  return Math.min(MAX_REFERENCE_CACHE_LIMIT, Math.max(0, Math.floor(value)))
}

export function clampReferenceAdmissionOccurrences(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return DEFAULT_REFERENCE_ADMISSION_OCCURRENCES
  return Math.min(MAX_REFERENCE_ADMISSION_OCCURRENCES, Math.max(1, Math.floor(value)))
}

export function selectRecentContext(
  source: readonly ContextSourceMessage[],
  requestedCount: number,
  characterLimit = MAX_CONTEXT_CHARACTERS,
): ContextSelection {
  const count = clampContextMessageCount(requestedCount)
  if (count === 0 || characterLimit <= 0) {
    return {
      messages: [],
      selectedCount: 0,
      omittedCount: eligibleCount(source),
      characterCount: 0,
      truncated: false,
    }
  }

  const eligible = source.filter(isEligible)
  const newest = eligible.slice(-count).reverse()
  const selectedNewestFirst: ContextMessage[] = []
  let remaining = Math.max(0, Math.trunc(characterLimit))
  let truncated = false

  for (const message of newest) {
    if (remaining === 0) break
    const content = message.content.trim()
    if (content.length <= remaining) {
      selectedNewestFirst.push({ role: message.role, content })
      remaining -= content.length
      continue
    }
    selectedNewestFirst.push({ role: message.role, content: content.slice(-remaining) })
    remaining = 0
    truncated = true
  }

  const messages = selectedNewestFirst.reverse()
  return {
    messages,
    selectedCount: messages.length,
    omittedCount: eligible.length - messages.length,
    characterCount: messages.reduce((total, message) => total + message.content.length, 0),
    truncated,
  }
}

export function selectRecentReferenceContext(
  source: readonly ContextSourceMessage[],
  requestedCount: number,
  characterLimit = MAX_CONTEXT_CHARACTERS,
): ContextSelection {
  const count = clampContextMessageCount(requestedCount)
  if (count === 0 || characterLimit <= 0) return selectRecentContext(source, 0, characterLimit)

  const eligible = source.filter(isEligible)
  const selectedCandidates = new Set([
    ...eligible.slice(-count),
    ...eligible.filter((message) => message.role === 'assistant').slice(-count),
  ])
  const newest = eligible.filter((message) => selectedCandidates.has(message)).reverse()
  const selectedNewestFirst: ContextMessage[] = []
  let remaining = Math.max(0, Math.trunc(characterLimit))
  let truncated = false

  for (const message of newest) {
    if (remaining === 0) break
    const content = message.content.trim()
    if (content.length <= remaining) {
      selectedNewestFirst.push({ role: message.role, content })
      remaining -= content.length
      continue
    }
    selectedNewestFirst.push({ role: message.role, content: content.slice(-remaining) })
    remaining = 0
    truncated = true
  }

  const messages = selectedNewestFirst.reverse()
  return {
    messages,
    selectedCount: messages.length,
    omittedCount: eligible.length - messages.length,
    characterCount: messages.reduce((total, message) => total + message.content.length, 0),
    truncated,
  }
}

/** Consecutive capitalized chat words are candidates, not automatic casing authority. */
export function extractCapitalizedPhraseCandidates(messages: readonly ContextMessage[]): string[] {
  const candidates = new Map<string, string>()
  for (const message of messages) {
    for (const match of message.content.matchAll(
      /(?<![\p{L}\p{M}\p{N}])\p{Lu}[\p{L}\p{M}]*(?:[-'’][\p{L}\p{M}]+)*(?:[ \t]+\p{Lu}[\p{L}\p{M}]*(?:[-'’][\p{L}\p{M}]+)*)+(?![\p{L}\p{M}\p{N}])/gu,
    )) {
      const phrase = normalizeReferenceCasing(match[0].replace(/[ \t]+/gu, ' '))
      if (phrase.length <= 200) candidates.set(referenceEvidenceKey(phrase), phrase)
    }
  }
  return [...candidates.values()]
}

export function extractConversationReferences(
  messages: readonly ContextMessage[],
  characterLimit = MAX_CONVERSATION_REFERENCE_CHARACTERS,
  lowercaseExemptions: readonly string[] = [],
): string[] {
  if (characterLimit <= 0) return []
  const references: string[] = []
  const seen = new Set<string>()
  // A capitalized occurrence alone is weak evidence: it may only begin a sentence.
  // If the selected source also uses the same token lowercase, treat it as ordinary
  // vocabulary and never promote that single token into a casing reference.
  const lowercaseEvidence = new Set<string>()
  const exemptLowercaseKeys = new Set(lowercaseExemptions.map(referenceEvidenceKey))
  for (const message of messages) {
    const terms = message.content.match(/[\p{L}\p{M}\d]+(?:[-'’][\p{L}\p{M}\d]+)*/gu) ?? []
    for (const term of terms) {
      if (/^\p{Ll}/u.test(term)) {
        const key = referenceEvidenceKey(stripPossessiveSuffix(term))
        if (!exemptLowercaseKeys.has(key)) lowercaseEvidence.add(key)
      }
    }
  }
  let size = 0

  const add = (value: string) => {
    const normalized = normalizeReferenceCasing(value.trim())
    const key = referenceEvidenceKey(normalized)
    if (!/\s/u.test(normalized) && lowercaseEvidence.has(key)) return
    if (!normalized || seen.has(key) || size + normalized.length > characterLimit) return
    seen.add(key)
    references.push(normalized)
    size += normalized.length
  }

  for (const message of messages) {
    // Names never continue across sentence or clause punctuation, so “Hana Sato. Later, Marcus”
    // yields “Hana Sato” and “Marcus”, not one combined phrase.
    for (const segment of message.content.split(/[.!?;:,\n\r]+/u)) {
      const terms = segment.match(/[\p{L}\p{M}\d]+(?:[-'’][\p{L}\p{M}\d]+)*/gu) ?? []
      let sequence: string[] = []
      const flushSequence = () => {
        const supported = sequence.filter(
          (term) => !lowercaseEvidence.has(referenceEvidenceKey(term)),
        )
        if (supported.length > 1) add(supported.slice(0, 4).join(' '))
        for (const term of supported) add(term)
        sequence = []
      }

      for (const term of terms) {
        if (isReferenceTerm(term)) {
          sequence.push(term)
        } else {
          flushSequence()
        }
      }
      flushSequence()
    }
  }

  return references
}

/**
 * Returns only inferred references with enough contextual evidence to alter casing.
 * The broader reference list remains available for unique fuzzy identification.
 */
export function extractAuthoritativeCasingReferences(
  messages: readonly ContextMessage[],
  options: {
    allowRepeatedWithinSource?: boolean
    allowMidSentenceCapitalized?: boolean
    allowRepeatedSentenceOpenings?: boolean
    minimumOccurrences?: number
    lowercaseExemptions?: readonly string[]
  } = {},
): string[] {
  const extracted = extractConversationReferences(
    messages,
    MAX_CONVERSATION_REFERENCE_CHARACTERS,
    options.lowercaseExemptions,
  )
  const phraseCandidates = extracted.filter((reference) => /\s/u.test(reference))
  const candidates = extracted.filter((reference) => !/\s/u.test(reference))
  const candidateByKey = new Map(
    candidates.map((candidate) => [referenceCanonicalKey(candidate), candidate]),
  )
  const evidence = new Map<
    string,
    { strong: boolean; occurrences: number; messageIndexes: Set<number> }
  >()

  messages.forEach((message, messageIndex) => {
    const tokens = [...message.content.matchAll(/[\p{L}\p{M}\d]+(?:[-'’][\p{L}\p{M}\d]+)*/gu)].map(
      (match) => ({
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      }),
    )
    tokens.forEach((token, tokenIndex) => {
      if (!/^\p{Lu}/u.test(token.value)) return
      const possessive = token.value.match(/(['’]s)$/iu)?.[0] ?? ''
      const base = possessive ? token.value.slice(0, -possessive.length) : token.value
      const key = referenceEvidenceKey(normalizeReferenceCasing(base))
      if (!candidateByKey.has(key)) return
      const previous = tokens[tokenIndex - 1]
      const next = tokens[tokenIndex + 1]
      const adjacentCapitalizedCandidate = [previous, next].some((neighbor) => {
        if (!neighbor || !/^\p{Lu}/u.test(neighbor.value)) return false
        const between = message.content.slice(
          Math.min(token.end, neighbor.end),
          Math.max(token.start, neighbor.start),
        )
        return /^\s*$/u.test(between) && candidateByKey.has(referenceCanonicalKey(neighbor.value))
      })
      const supportedMidSentenceUse =
        !isSentenceOpeningAt(message.content, token.start) && !adjacentCapitalizedCandidate
      const current = evidence.get(key) ?? {
        strong: false,
        occurrences: 0,
        messageIndexes: new Set<number>(),
      }
      current.strong ||= supportedMidSentenceUse
      current.occurrences += 1
      current.messageIndexes.add(messageIndex)
      evidence.set(key, current)
    })
  })

  const supportedSingles = candidates.filter((candidate) => {
    const item = evidence.get(referenceCanonicalKey(candidate))
    if (!item) return false
    return (
      item.strong ||
      (options.allowRepeatedSentenceOpenings !== false &&
        item.occurrences >= (options.minimumOccurrences ?? 2))
    )
  })
  const supportedKeys = new Set(
    [...phraseCandidates, ...supportedSingles].map(referenceEvidenceKey),
  )
  return extracted.filter((reference) => supportedKeys.has(referenceEvidenceKey(reference)))
}

export function extractLowercaseReferenceKeys(messages: readonly ContextSourceMessage[]): string[] {
  const keys = new Set<string>()
  for (const message of messages) {
    if (!isEligible(message)) continue
    const terms = message.content.match(/[\p{L}\p{M}\d]+(?:[-'’][\p{L}\p{M}\d]+)*/gu) ?? []
    for (const term of terms) {
      if (/^\p{Ll}/u.test(term)) keys.add(referenceEvidenceKey(stripPossessiveSuffix(term)))
    }
  }
  return [...keys]
}

export function extractCardCasingReferences(title: string, cardText: string): string[] {
  const titleReferences = title.trim()
    ? extractConversationReferences([{ role: 'assistant', content: title }])
    : []
  const bodyIdentification = cardText.trim()
    ? extractConversationReferences([{ role: 'assistant', content: cardText }])
    : []
  const bodyKeys = new Set(bodyIdentification.map(referenceEvidenceKey))
  const confirmedTitleReferences = titleReferences.filter((reference) =>
    bodyKeys.has(referenceEvidenceKey(reference)),
  )
  const selectedTitleReferences = confirmedTitleReferences.length
    ? confirmedTitleReferences
    : titleReferences
  const bodyCasingReferences = cardText.trim()
    ? extractAuthoritativeCasingReferences([{ role: 'assistant', content: cardText }], {
        allowRepeatedWithinSource: true,
        allowMidSentenceCapitalized: true,
      })
    : []
  return uniqueReferences([...selectedTitleReferences, ...bodyCasingReferences])
}

export function extractCardCharacterReferences(title: string, cardText: string): string[] {
  const normalizedTitle = title.trim()
  const titleReferences = normalizedTitle
    ? extractConversationReferences([{ role: 'assistant', content: normalizedTitle }])
    : []
  const cardReferences = cardText.trim()
    ? extractConversationReferences([{ role: 'assistant', content: cardText }])
    : []
  const cardKeys = new Set(cardReferences.map((reference) => reference.toLocaleLowerCase()))
  const confirmedTitleReferences = titleReferences.filter((reference) =>
    cardKeys.has(reference.toLocaleLowerCase()),
  )
  const selectedTitleReferences = confirmedTitleReferences.length
    ? confirmedTitleReferences
    : titleReferences
  const references = new Map<string, string>()
  for (const reference of [...selectedTitleReferences, ...cardReferences]) {
    const key = reference.toLocaleLowerCase()
    if (!references.has(key)) references.set(key, reference)
  }
  return [...references.values()]
}

function uniqueReferences(references: readonly string[]): string[] {
  const selected = new Map<string, string>()
  for (const reference of references) {
    const key = referenceEvidenceKey(reference)
    if (!selected.has(key)) selected.set(key, reference)
  }
  return [...selected.values()]
}

export function correctFromConversationReferences(
  text: string,
  references: readonly string[],
  protectedTerms: readonly string[] = [],
): ConversationReferenceCorrection {
  return correctReferenceTerms(text, references, protectedTerms, true)
}

/** Edit targets may be lowercased even when they name a proper noun. */
export function correctEditTargetFromConversationReferences(
  text: string,
  references: readonly string[],
  protectedTerms: readonly string[] = [],
): ConversationReferenceCorrection {
  return correctReferenceTerms(text, references, protectedTerms, false)
}

/**
 * Adopts canonical casing only when a payload token already matches a known
 * reference case-insensitively. This does not perform fuzzy substitution.
 */
export function canonicalizeExactConversationReferences(
  text: string,
  references: readonly string[],
  protectedTerms: readonly string[] = [],
): ConversationReferenceCorrection {
  const protectedKeys = new Set(protectedTerms.map((term) => term.toLocaleLowerCase()))
  const referenceByKey = referenceMap(references)
  const correctedTerms: Array<{ heard: string; canonical: string }> = []
  let correctedText = text
  const phraseReferences = [
    ...new Map(
      references
        .map((reference) => normalizeReferenceCasing(reference.trim()))
        .filter((reference) => /\s/u.test(reference))
        .map((reference) => [reference.toLocaleLowerCase(), reference]),
    ).values(),
  ].sort((left, right) => right.length - left.length)
  for (const canonical of phraseReferences) {
    if (protectedKeys.has(canonical.toLocaleLowerCase())) continue
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeReferencePattern(canonical).replace(/\s+/gu, '\\s+')}(?![\\p{L}\\p{N}])`,
      'giu',
    )
    correctedText = correctedText.replace(pattern, (heard) => {
      if (heard === canonical) return heard
      correctedTerms.push({ heard, canonical })
      return canonical
    })
  }
  correctedText = correctedText.replace(
    /\p{L}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*/gu,
    (heard, offset: number) => {
      const possessive = heard.match(/(['’]s)$/iu)?.[0] ?? ''
      const base = possessive ? heard.slice(0, -possessive.length) : heard
      const baseKey = base.toLocaleLowerCase()
      const canonical = referenceByKey.get(baseKey)
      if (!canonical || canonical === base || protectedKeys.has(baseKey)) return heard
      if (
        (isLikelyOneSyllable(canonical) ||
          AUXILIARY_WORDS.has(baseKey) ||
          PARTICLE_WORDS.has(baseKey)) &&
        (hasProtectedOrdinaryWordUsage(correctedText, offset, offset + heard.length, baseKey) ||
          hasPrecedingQuantity(correctedText, offset))
      )
        return heard
      correctedTerms.push({ heard: base, canonical })
      return `${canonical}${possessive}`
    },
  )
  return { text: correctedText, correctedTerms }
}

function correctReferenceTerms(
  text: string,
  references: readonly string[],
  protectedTerms: readonly string[],
  requireInitialUppercase: boolean,
): ConversationReferenceCorrection {
  const protectedKeys = new Set(protectedTerms.map((term) => term.toLocaleLowerCase()))
  const referenceByKey = referenceMap(references)
  const correctedTerms: Array<{ heard: string; canonical: string }> = []

  let correctedText = text.replace(
    /(\p{L}[\p{L}\p{M}\d-]*)\s+(\p{L}[\p{L}\p{M}\d-]*)(['’]s)\b/gu,
    (heard, first: string, second: string, possessive: string) => {
      if (requireInitialUppercase && !/^\p{Lu}/u.test(first)) return heard
      const combined = `${first}${second}`.toLocaleLowerCase()
      if (combined.length < 6) return heard
      const candidates = [...referenceByKey.values()].filter((reference) => {
        const key = reference.toLocaleLowerCase()
        return (
          reference.length >= 5 &&
          Math.abs(combined.length - key.length) <= 2 &&
          !protectedKeys.has(key) &&
          areSpeechPhoneticNeighbors(combined, key)
        )
      })
      const uniqueCandidates = [
        ...new Map(candidates.map((value) => [value.toLocaleLowerCase(), value])).values(),
      ]
      if (uniqueCandidates.length !== 1) return heard
      const canonical = uniqueCandidates[0]!
      correctedTerms.push({ heard: `${first} ${second}`, canonical })
      return `${canonical}${possessive}`
    },
  )

  correctedText = correctedText.replace(
    /\p{L}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*/gu,
    (heard, offset: number) => {
      const possessive = heard.match(/(['’]s)$/iu)?.[0] ?? ''
      const base = possessive ? heard.slice(0, -possessive.length) : heard
      const baseKey = base.toLocaleLowerCase()
      if (
        base.length < 3 ||
        (requireInitialUppercase && !/^\p{Lu}/u.test(base)) ||
        protectedKeys.has(baseKey) ||
        referenceByKey.has(baseKey)
      )
        return heard

      // A provider may omit the apostrophe from a spoken possessive ("Megs").
      if (!possessive && !hasProtectedOrdinaryWordUsage(correctedText, offset, offset + heard.length, baseKey)) {
        const possessiveNames = [...referenceByKey.values()].filter((reference) => {
          const key = reference.toLocaleLowerCase()
          return !protectedKeys.has(key) &&
            (baseKey === `${key}s` || (/[sxz]$/u.test(key) && (baseKey === `${key}is` || baseKey === `${key}es`)))
        })
        if (possessiveNames.length === 1) {
          const canonical = possessiveNames[0]!
          correctedTerms.push({ heard, canonical: `${canonical}’s` })
          return `${canonical}’s`
        }
      }

      if (
        requireInitialUppercase &&
        !possessive &&
        (MODAL_WORDS.has(baseKey) || baseKey === 'then') &&
        !hasPositiveNameSignal(text, offset)
      )
        return heard

      const candidates = [...referenceByKey.values()].filter((reference) => {
        if (
          requireInitialUppercase &&
          !possessive &&
          (isLikelyOneSyllable(reference) || PARTICLE_WORDS.has(reference.toLocaleLowerCase())) &&
          hasProtectedOrdinaryWordUsage(correctedText, offset, offset + heard.length, baseKey)
        )
          return false
        return isHighConfidenceReferenceMatch(baseKey, reference.toLocaleLowerCase())
      })
      // A spelling-close reference wins over phonetic-only neighbours, so "Kensai" resolves to
      // "Kansai" even when "Kenji" also sounds similar.
      const spellingClose = candidates.filter((reference) =>
        editDistanceAtMost(baseKey, reference.toLocaleLowerCase(), 1),
      )
      const pool = spellingClose.length ? spellingClose : candidates
      const uniqueCandidates = [
        ...new Map(pool.map((value) => [value.toLocaleLowerCase(), value])).values(),
      ]
      if (uniqueCandidates.length !== 1) return heard

      const canonical = uniqueCandidates[0]
      correctedTerms.push({ heard: base, canonical })
      return `${canonical}${possessive}`
    },
  )

  return { text: correctedText, correctedTerms }
}

function referenceMap(references: readonly string[]): Map<string, string> {
  const referenceByKey = new Map<string, string>()
  for (const reference of references) {
    const possessive = reference.match(/(['’]s)$/iu)?.[0] ?? ''
    const canonical = normalizeReferenceCasing(
      possessive ? reference.slice(0, -possessive.length) : reference,
    )
    if (!/^\p{Lu}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*$/u.test(canonical)) continue
    referenceByKey.set(canonical.toLocaleLowerCase(), canonical)
  }
  return referenceByKey
}

function normalizeReferenceCasing(value: string): string {
  return value.replace(/\p{L}[\p{L}\p{M}]*(?:[-'’][\p{L}\p{M}]+)*/gu, (token) => {
    const letters = token.match(/\p{L}/gu) ?? []
    if (letters.length < 2 || letters.some((letter) => letter !== letter.toLocaleUpperCase()))
      return token
    const lower = token.toLocaleLowerCase()
    return lower.replace(/(^|-)\p{Ll}/gu, (opening) => opening.toLocaleUpperCase())
  })
}

function referenceEvidenceKey(value: string): string {
  return value.toLocaleLowerCase().replace(/\u2019/gu, "'")
}

function stripPossessiveSuffix(value: string): string {
  const possessive = value.match(/(['’]s)$/iu)?.[0] ?? ''
  return possessive ? value.slice(0, -possessive.length) : value
}

function referenceCanonicalKey(value: string): string {
  const possessive = value.match(/(['’]s)$/iu)?.[0] ?? ''
  return referenceEvidenceKey(
    normalizeReferenceCasing(possessive ? value.slice(0, -possessive.length) : value),
  )
}

function escapeReferencePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/['’]/gu, "['’]")
}

function isSentenceOpeningAt(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset).replace(/[\s"'“”‘’([{]+$/gu, '')
  return prefix.length === 0 || /[.!?]\s*$/u.test(prefix)
}

const MODAL_WORDS = new Set([
  'can',
  'could',
  'may',
  'might',
  'must',
  'shall',
  'should',
  'will',
  'would',
])
const AUXILIARY_WORDS = new Set([
  'am',
  'are',
  'be',
  'been',
  'being',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'is',
  'was',
  'were',
])
const PARTICLE_WORDS = new Set([
  'away',
  'back',
  'down',
  'in',
  'off',
  'on',
  'out',
  'over',
  'through',
  'up',
])
const DETERMINERS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'each',
  'every',
  'some',
  'any',
  'no',
])
const SUBJECT_WORDS = new Set(['i', 'you', 'he', 'she', 'it', 'we', 'they', 'who'])
const COMMON_VERB_CONFUSABLES = new Set(['bill', 'grant', 'jack', 'mark', 'rose'])
const NAME_SIGNAL_WORDS = new Set([
  'ask',
  'asked',
  'call',
  'called',
  'greet',
  'greeted',
  'meet',
  'met',
  'named',
  'thank',
  'thanked',
  'tell',
  'told',
])
const NAME_TITLES = new Set([
  'captain',
  'doctor',
  'dr',
  'miss',
  'mister',
  'mr',
  'mrs',
  'ms',
  'professor',
])
function hasPositiveNameSignal(text: string, start: number): boolean {
  const previous = adjacentWord(text, start, 'before')
  return Boolean(previous && (NAME_SIGNAL_WORDS.has(previous) || NAME_TITLES.has(previous)))
}

function hasProtectedOrdinaryWordUsage(
  text: string,
  start: number,
  end: number,
  heard: string,
): boolean {
  const previous = adjacentWord(text, start, 'before')
  const next = adjacentWord(text, end, 'after')
  if (previous && (NAME_SIGNAL_WORDS.has(previous) || NAME_TITLES.has(previous))) return false

  if (MODAL_WORDS.has(heard)) return true
  if (AUXILIARY_WORDS.has(heard)) return true
  if (PARTICLE_WORDS.has(heard)) return true
  if (previous && DETERMINERS.has(previous)) return true
  if (heard === 'then') return true
  if (
    COMMON_VERB_CONFUSABLES.has(heard) &&
    (previous === 'to' || (previous !== undefined && SUBJECT_WORDS.has(previous)))
  )
    return true
  if (heard === 'mark' && next === 'my') return true
  if (heard === 'bill' && next === 'of') return true
  if (heard === 'jack' && next === 'up') return true
  return false
}

function adjacentWord(
  text: string,
  offset: number,
  direction: 'before' | 'after',
): string | undefined {
  const source = direction === 'before' ? text.slice(0, offset) : text.slice(offset)
  const match =
    direction === 'before'
      ? source.match(/([\p{L}\p{M}]+)[^\p{L}\p{M}]*$/u)
      : source.match(/^[^\p{L}\p{M}]*([\p{L}\p{M}]+)/u)
  return match?.[1]?.toLocaleLowerCase()
}

function hasPrecedingQuantity(text: string, offset: number): boolean {
  return /(?:\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)|\d+(?:[.,]\d+)?)\s*$/iu.test(
    text.slice(0, offset),
  )
}

function isLikelyOneSyllable(value: string): boolean {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^a-z]/gu, '')
  if (!normalized) return false
  let vowelGroups = normalized.match(/[aeiouy]+/gu)?.length ?? 0
  if (vowelGroups > 1 && /[^aeiou]e$/u.test(normalized) && !/[^aeiou]le$/u.test(normalized))
    vowelGroups -= 1
  return vowelGroups <= 1
}

function eligibleCount(source: readonly ContextSourceMessage[]): number {
  return source.filter(isEligible).length
}

function isEligible(message: ContextSourceMessage): message is ContextSourceMessage & {
  role: 'user' | 'assistant'
  content: string
} {
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0 &&
    !isHidden(message.extra) &&
    !isHidden(message.metadata)
  )
}

function isHidden(record: Record<string, unknown> | undefined): boolean {
  return Boolean(
    record?.hidden === true ||
    record?.is_hidden === true ||
    record?.isHidden === true ||
    record?.visibility === 'hidden' ||
    record?.excluded_from_context === true,
  )
}

const COMMON_CAPITALIZED_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'how',
  'i',
  'if',
  'in',
  'it',
  'its',
  'my',
  'of',
  'on',
  'our',
  'she',
  'so',
  'that',
  'the',
  'their',
  'then',
  'they',
  'this',
  'to',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
])

function isReferenceTerm(term: string): boolean {
  const key = term.toLocaleLowerCase()
  if (
    term.length < 2 ||
    COMMON_CAPITALIZED_WORDS.has(key) ||
    AUXILIARY_WORDS.has(key) ||
    PARTICLE_WORDS.has(key)
  )
    return false
  return /\p{Lu}/u.test(term.charAt(0)) || /[\p{Lu}\d]/u.test(term.slice(1))
}

function isHighConfidenceReferenceMatch(heard: string, reference: string): boolean {
  const maximumLengthDifference = Math.min(heard.length, reference.length) >= 6 ? 2 : 1
  if (Math.abs(heard.length - reference.length) > maximumLengthDifference) return false
  if (Math.max(heard.length, reference.length) <= 5) {
    const heardPhonetic = speechPhoneticKey(heard)
    return heardPhonetic.length >= 3 && heardPhonetic === speechPhoneticKey(reference)
  }
  if (heard.charAt(0) !== reference.charAt(0)) return false
  if (editDistanceAtMost(heard, reference, 1)) return true
  if (heard.slice(0, 2) === reference.slice(0, 2) && areSpeechPhoneticNeighbors(heard, reference))
    return true
  return (
    Math.min(heard.length, reference.length) >= 6 &&
    heard.slice(0, 4) === reference.slice(0, 4) &&
    editDistanceAtMost(heard, reference, 2)
  )
}

function editDistanceAtMost(left: string, right: string, maximum: number): boolean {
  if (Math.abs(left.length - right.length) > maximum) return false
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      const distance = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      )
      current.push(distance)
      rowMinimum = Math.min(rowMinimum, distance)
    }
    if (rowMinimum > maximum) return false
    previous = current
  }
  return previous[right.length]! <= maximum
}
