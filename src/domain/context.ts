export const DEFAULT_CONTEXT_MESSAGE_COUNT = 5
export const MAX_CONTEXT_MESSAGE_COUNT = 20
export const MAX_CONTEXT_CHARACTERS = 12_000

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
