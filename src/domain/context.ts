export const DEFAULT_CONTEXT_MESSAGE_COUNT = 5
export const MAX_CONTEXT_MESSAGE_COUNT = 20
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

export function extractConversationReferences(
  messages: readonly ContextMessage[],
  characterLimit = MAX_CONVERSATION_REFERENCE_CHARACTERS,
): string[] {
  if (characterLimit <= 0) return []
  const references: string[] = []
  const seen = new Set<string>()
  let size = 0

  const add = (value: string) => {
    const normalized = value.trim()
    const key = normalized.toLocaleLowerCase()
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
        if (sequence.length > 1) add(sequence.slice(0, 4).join(' '))
        for (const term of sequence) add(term)
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

function correctReferenceTerms(
  text: string,
  references: readonly string[],
  protectedTerms: readonly string[],
  requireInitialUppercase: boolean,
): ConversationReferenceCorrection {
  const protectedKeys = new Set(protectedTerms.map((term) => term.toLocaleLowerCase()))
  const referenceByKey = new Map<string, string>()
  for (const reference of references) {
    const possessive = reference.match(/(['’]s)$/iu)?.[0] ?? ''
    const canonical = possessive ? reference.slice(0, -possessive.length) : reference
    if (!/^\p{Lu}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*$/u.test(canonical)) continue
    referenceByKey.set(canonical.toLocaleLowerCase(), canonical)
  }

  const correctedTerms: Array<{ heard: string; canonical: string }> = []
  const correctedText = text.replace(/\p{L}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*/gu, (heard, offset: number) => {
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

    const candidates = [...referenceByKey.values()].filter((reference) => {
      if (
        requireInitialUppercase &&
        !possessive &&
        isLikelyOneSyllable(reference) &&
        hasProtectedOrdinaryWordUsage(text, offset, offset + heard.length, baseKey)
      )
        return false
      return isHighConfidenceReferenceMatch(baseKey, reference.toLocaleLowerCase())
    })
    const uniqueCandidates = [
      ...new Map(candidates.map((value) => [value.toLocaleLowerCase(), value])).values(),
    ]
    if (uniqueCandidates.length !== 1) return heard

    const canonical = uniqueCandidates[0]
    correctedTerms.push({ heard: base, canonical })
    return `${canonical}${possessive}`
  })

  return { text: correctedText, correctedTerms }
}

const MODAL_WORDS = new Set(['can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would'])
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
const NAME_TITLES = new Set(['captain', 'doctor', 'dr', 'miss', 'mister', 'mr', 'mrs', 'ms', 'professor'])

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
  'for',
  'from',
  'he',
  'her',
  'his',
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
  'when',
  'with',
  'you',
  'your',
])

function isReferenceTerm(term: string): boolean {
  if (term.length < 2 || COMMON_CAPITALIZED_WORDS.has(term.toLocaleLowerCase())) return false
  return /\p{Lu}/u.test(term.charAt(0)) || /[\p{Lu}\d]/u.test(term.slice(1))
}

function isHighConfidenceReferenceMatch(heard: string, reference: string): boolean {
  const maximumLengthDifference = Math.min(heard.length, reference.length) >= 6 ? 2 : 1
  if (Math.abs(heard.length - reference.length) > maximumLengthDifference) return false
  if (
    Math.max(heard.length, reference.length) <= 5 &&
    referenceSoundKey(heard).length >= 3 &&
    referenceSoundKey(heard) === referenceSoundKey(reference)
  )
    return true
  if (heard.charAt(0) !== reference.charAt(0)) {
    return (
      heard.length === 3 &&
      reference.length === 3 &&
      heard.slice(1) === reference.slice(1) &&
      hardInitialsMatch(heard.charAt(0), reference.charAt(0))
    )
  }
  if (editDistanceAtMost(heard, reference, 1)) return true
  return (
    Math.min(heard.length, reference.length) >= 6 &&
    heard.slice(0, 4) === reference.slice(0, 4) &&
    editDistanceAtMost(heard, reference, 2)
  )
}

function referenceSoundKey(value: string): string {
  const prepared = value.normalize('NFKD').toLocaleLowerCase().replace(/\p{M}/gu, '')
  let key = ''
  for (const character of prepared) {
    const sound = /[aeiouy]/u.test(character)
      ? 'A'
      : /[cgjkq]/u.test(character)
        ? 'K'
        : /[bp]/u.test(character)
          ? 'B'
          : /[fv]/u.test(character)
            ? 'F'
            : /[dt]/u.test(character)
              ? 'T'
              : /[sxz]/u.test(character)
                ? 'S'
                : /[lmnr]/u.test(character)
                  ? character.toLocaleUpperCase()
                  : ''
    if (sound && sound !== key.at(-1)) key += sound
  }
  return key
}

function hardInitialsMatch(left: string, right: string): boolean {
  const hardInitials = new Set(['c', 'k', 'q'])
  return hardInitials.has(left) && hardInitials.has(right)
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
