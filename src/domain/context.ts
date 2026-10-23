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
    const terms = message.content.match(/[\p{L}\p{M}\d]+(?:[-'’][\p{L}\p{M}\d]+)*/gu) ?? []
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

  return references
}

export function correctFromConversationReferences(
  text: string,
  references: readonly string[],
  protectedTerms: readonly string[] = [],
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
  const correctedText = text.replace(/\p{L}[\p{L}\p{M}\d]*(?:[-'’][\p{L}\p{M}\d]+)*/gu, (heard) => {
    const possessive = heard.match(/(['’]s)$/iu)?.[0] ?? ''
    const base = possessive ? heard.slice(0, -possessive.length) : heard
    const baseKey = base.toLocaleLowerCase()
    if (
      base.length < 3 ||
      !/^\p{Lu}/u.test(base) ||
      protectedKeys.has(baseKey) ||
      referenceByKey.has(baseKey)
    )
      return heard

    const candidates = [...referenceByKey.values()].filter((reference) =>
      isHighConfidenceReferenceMatch(baseKey, reference.toLocaleLowerCase()),
    )
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
  if (Math.abs(heard.length - reference.length) > 1) return false
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
