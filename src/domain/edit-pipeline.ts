import { MAX_DRAFT_CHARACTERS, type DraftParagraph } from './draft-session'

export const EDIT_SCHEMA_VERSION = 2 as const
export const MAX_EDIT_OPERATIONS = 8
export const MAX_EDIT_TEXT_LENGTH = 10_000

export type EditOperationType =
  | 'replace'
  | 'insert_before'
  | 'insert_after'
  | 'delete'
  | 'append'
  | 'prepend'
  | 'case'
  | 'split'
  | 'join_next'
  | 'move_before'
  | 'move_after'

export type PunctuationTarget =
  | 'period'
  | 'comma'
  | 'colon'
  | 'semicolon'
  | 'question_mark'
  | 'exclamation_mark'
  | 'ellipsis'
  | 'quote'
  | 'single_quote'
  | 'apostrophe'
  | 'hyphen'
  | 'en_dash'
  | 'em_dash'
  | 'open_parenthesis'
  | 'close_parenthesis'
  | 'open_bracket'
  | 'close_bracket'

export interface EditTarget {
  paragraphId?: string
  paragraphOrdinal?: number
  exactText?: string
  approximateText?: string
  scope?: 'draft'
  punctuation?: PunctuationTarget
  occurrence?: number
  occurrenceFromEnd?: number
  sentenceOrdinal?: number
  sentenceFromEnd?: number
  relativePosition?: 'before' | 'after'
  relativeToText?: string
}

export interface EditOperation {
  id: string
  type: EditOperationType
  target: EditTarget
  text?: string
  caseMode?: 'capitalize' | 'uppercase' | 'lowercase'
  destination?: EditTarget
  includeTrailingPunctuation?: boolean
}

export interface EditPlan {
  schemaVersion: typeof EDIT_SCHEMA_VERSION
  draftVersion: number
  operations: EditOperation[]
  explanation: string
}

export interface ResolvedEditOperation extends EditOperation {
  startOffset: number
  endOffset: number
  beforeText: string
  afterText: string
  paragraphOrdinal: number
}

export type EditPipelineResult =
  | {
      ok: true
      afterText: string
      operations: ResolvedEditOperation[]
      affectedParagraphOrdinals: number[]
      resultingParagraphIds?: string[]
    }
  | { ok: false; reason: string }

interface Patch {
  operation: EditOperation
  start: number
  end: number
  replacement: string
  paragraphOrdinal: number
}

export function parseEditPlan(value: unknown): EditPlan | null {
  if (!isRecord(value) || value.schemaVersion !== EDIT_SCHEMA_VERSION) return null
  const allowedPlanKeys = new Set(['schemaVersion', 'draftVersion', 'operations', 'explanation'])
  if (Object.keys(value).some((key) => !allowedPlanKeys.has(key))) return null
  if (!isNonNegativeInteger(value.draftVersion)) return null
  if (!Array.isArray(value.operations) || value.operations.length < 1) return null
  if (value.operations.length > MAX_EDIT_OPERATIONS) return null
  if (typeof value.explanation !== 'string' || value.explanation.length > 1_000) return null
  const operations = value.operations.map(parseOperation)
  if (operations.some((operation) => operation === null)) return null
  if (new Set(operations.map((operation) => operation!.id)).size !== operations.length) return null
  return {
    schemaVersion: EDIT_SCHEMA_VERSION,
    draftVersion: value.draftVersion,
    operations: operations as EditOperation[],
    explanation: value.explanation,
  }
}

export function executeEditPlan(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  currentVersion: number,
  plan: EditPlan,
  protectedCasingTerms: readonly string[] = [],
): EditPipelineResult {
  if (plan.draftVersion !== currentVersion) return { ok: false, reason: 'stale draft version' }
  const inlineMoves = plan.operations.filter(isInlineMoveOperation)
  if (inlineMoves.length) {
    if (inlineMoves.length !== plan.operations.length || inlineMoves.length > 1)
      return { ok: false, reason: 'an inline move must be the only operation in its edit plan' }
    return executeInlineMove(cleanText, paragraphs, inlineMoves[0]!, protectedCasingTerms)
  }
  const structural = plan.operations.filter(isStructuralOperation)
  if (structural.length) {
    if (structural.length !== plan.operations.length)
      return { ok: false, reason: 'structural and inline operations cannot be mixed' }
    return executeStructuralPlan(cleanText, paragraphs, structural)
  }
  const patches: Patch[] = []
  for (const operation of plan.operations) {
    const patch = resolveOperation(cleanText, paragraphs, operation, protectedCasingTerms)
    if (typeof patch === 'string') return { ok: false, reason: patch }
    patches.push(patch)
  }
  const sorted = [...patches].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  )
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!
    const current = sorted[index]!
    if (
      current.end > previous.start ||
      (current.start === previous.start && current.end === current.start)
    )
      return { ok: false, reason: 'edit operations overlap' }
  }
  let afterText = cleanText
  for (const patch of sorted) {
    afterText = `${afterText.slice(0, patch.start)}${patch.replacement}${afterText.slice(patch.end)}`
  }
  if (afterText.length > MAX_DRAFT_CHARACTERS)
    return { ok: false, reason: 'edited draft is too large' }
  if (afterText === cleanText) return { ok: false, reason: 'edit would not change the draft' }
  return {
    ok: true,
    afterText,
    operations: patches.map((patch) => ({
      ...patch.operation,
      startOffset: patch.start,
      endOffset: patch.end,
      beforeText: cleanText.slice(patch.start, patch.end),
      afterText: patch.replacement,
      paragraphOrdinal: patch.paragraphOrdinal,
    })),
    affectedParagraphOrdinals: [...new Set(patches.map((patch) => patch.paragraphOrdinal))].sort(
      (left, right) => left - right,
    ),
  }
}

function parseOperation(value: unknown): EditOperation | null {
  if (!isRecord(value) || !isIdentifier(value.id) || !isRecord(value.target)) return null
  const allowedOperationKeys = new Set([
    'id',
    'type',
    'target',
    'text',
    'caseMode',
    'destination',
    'includeTrailingPunctuation',
  ])
  if (Object.keys(value).some((key) => !allowedOperationKeys.has(key))) return null
  const type = value.type
  if (
    type !== 'replace' &&
    type !== 'insert_before' &&
    type !== 'insert_after' &&
    type !== 'delete' &&
    type !== 'append' &&
    type !== 'prepend' &&
    type !== 'case' &&
    type !== 'split' &&
    type !== 'join_next' &&
    type !== 'move_before' &&
    type !== 'move_after'
  )
    return null
  const target = parseTarget(value.target)
  if (!target) return null
  const text = value.text
  const caseMode = value.caseMode
  const includeTrailingPunctuation = value.includeTrailingPunctuation
  if (includeTrailingPunctuation !== undefined && includeTrailingPunctuation !== true) return null
  const destination =
    value.destination === undefined
      ? undefined
      : isRecord(value.destination)
        ? parseTarget(value.destination)
        : null
  if (value.destination !== undefined && !destination) return null
  if (type === 'case') {
    if (caseMode !== 'capitalize' && caseMode !== 'uppercase' && caseMode !== 'lowercase')
      return null
    if (text !== undefined || destination !== undefined || includeTrailingPunctuation !== undefined)
      return null
  } else if (type === 'delete' || type === 'split' || type === 'join_next') {
    if (text !== undefined || caseMode !== undefined) return null
    if (destination !== undefined) return null
    if (
      includeTrailingPunctuation !== undefined &&
      (type === 'join_next' || includeTrailingPunctuation !== true)
    )
      return null
    if (
      type === 'join_next' &&
      (target.exactText !== undefined ||
        target.approximateText !== undefined ||
        target.sentenceOrdinal !== undefined ||
        target.sentenceFromEnd !== undefined ||
        target.scope !== undefined)
    )
      return null
  } else if (type === 'move_before' || type === 'move_after') {
    if (text !== undefined || caseMode !== undefined || !destination) return null
    if (target.scope !== undefined || destination.scope !== undefined) return null
    const sourceIsText = hasInlineSelector(target)
    const destinationIsText = hasInlineSelector(destination)
    if (sourceIsText !== destinationIsText) return null
    if (includeTrailingPunctuation !== undefined && !sourceIsText) return null
  } else if (
    typeof text !== 'string' ||
    text.length > MAX_EDIT_TEXT_LENGTH ||
    caseMode !== undefined ||
    destination !== undefined ||
    includeTrailingPunctuation !== undefined
  ) {
    return null
  }
  return {
    id: value.id,
    type,
    target,
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof caseMode === 'string' ? { caseMode } : {}),
    ...(destination ? { destination } : {}),
    ...(includeTrailingPunctuation === true ? { includeTrailingPunctuation: true } : {}),
  }
}

function parseTarget(value: Record<string, unknown>): EditTarget | null {
  const allowed = new Set([
    'paragraphId',
    'paragraphOrdinal',
    'exactText',
    'approximateText',
    'scope',
    'punctuation',
    'occurrence',
    'occurrenceFromEnd',
    'sentenceOrdinal',
    'sentenceFromEnd',
    'relativePosition',
    'relativeToText',
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) return null
  const target: EditTarget = {}
  if (value.paragraphId !== undefined) {
    if (!isIdentifier(value.paragraphId)) return null
    target.paragraphId = value.paragraphId
  }
  if (value.paragraphOrdinal !== undefined) {
    if (!isPositiveInteger(value.paragraphOrdinal)) return null
    target.paragraphOrdinal = value.paragraphOrdinal
  }
  if (value.exactText !== undefined) {
    if (
      typeof value.exactText !== 'string' ||
      value.exactText.length < 1 ||
      value.exactText.length > MAX_EDIT_TEXT_LENGTH
    )
      return null
    target.exactText = value.exactText
  }
  if (value.approximateText !== undefined) {
    if (
      typeof value.approximateText !== 'string' ||
      value.approximateText.length < 1 ||
      value.approximateText.length > MAX_EDIT_TEXT_LENGTH
    )
      return null
    target.approximateText = value.approximateText
  }
  if (target.exactText !== undefined && target.approximateText !== undefined) return null
  if (value.scope !== undefined) {
    if (value.scope !== 'draft') return null
    target.scope = 'draft'
  }
  if (
    target.scope === 'draft' &&
    (target.paragraphId !== undefined ||
      target.paragraphOrdinal !== undefined ||
      target.exactText !== undefined ||
      target.approximateText !== undefined)
  )
    return null
  if (value.punctuation !== undefined) {
    if (!isPunctuationTarget(value.punctuation)) return null
    target.punctuation = value.punctuation
  }
  if (value.occurrence !== undefined) {
    if (!isPositiveInteger(value.occurrence) || value.occurrence > 10_000) return null
    target.occurrence = value.occurrence
  }
  if (value.occurrenceFromEnd !== undefined) {
    if (!isPositiveInteger(value.occurrenceFromEnd) || value.occurrenceFromEnd > 10_000) return null
    target.occurrenceFromEnd = value.occurrenceFromEnd
  }
  if (target.occurrence !== undefined && target.occurrenceFromEnd !== undefined) return null
  if (value.sentenceOrdinal !== undefined) {
    if (!isPositiveInteger(value.sentenceOrdinal) || value.sentenceOrdinal > 10_000) return null
    target.sentenceOrdinal = value.sentenceOrdinal
  }
  if (value.sentenceFromEnd !== undefined) {
    if (!isPositiveInteger(value.sentenceFromEnd) || value.sentenceFromEnd > 10_000) return null
    target.sentenceFromEnd = value.sentenceFromEnd
  }
  if (target.sentenceOrdinal !== undefined && target.sentenceFromEnd !== undefined) return null
  if (value.relativePosition !== undefined) {
    if (value.relativePosition !== 'before' && value.relativePosition !== 'after') return null
    target.relativePosition = value.relativePosition
  }
  if (value.relativeToText !== undefined) {
    if (
      typeof value.relativeToText !== 'string' ||
      value.relativeToText.length < 1 ||
      value.relativeToText.length > MAX_EDIT_TEXT_LENGTH
    )
      return null
    target.relativeToText = value.relativeToText
  }
  const hasRelativePosition = target.relativePosition !== undefined
  const hasRelativeText = target.relativeToText !== undefined
  if (hasRelativePosition !== hasRelativeText) return null
  if (
    target.punctuation !== undefined &&
    (target.exactText !== undefined ||
      target.approximateText !== undefined ||
      target.scope !== undefined)
  )
    return null
  if (
    target.punctuation === undefined &&
    (target.occurrence !== undefined ||
      target.occurrenceFromEnd !== undefined ||
      hasRelativePosition ||
      hasRelativeText)
  )
    return null
  if (
    (target.sentenceOrdinal !== undefined || target.sentenceFromEnd !== undefined) &&
    (target.exactText !== undefined ||
      target.approximateText !== undefined ||
      target.punctuation !== undefined ||
      target.scope !== undefined ||
      target.occurrence !== undefined ||
      target.occurrenceFromEnd !== undefined ||
      hasRelativePosition ||
      hasRelativeText)
  )
    return null
  return Object.keys(target).length ? target : null
}

function resolveOperation(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  operation: EditOperation,
  protectedCasingTerms: readonly string[],
): Patch | string {
  const paragraphMatches = paragraphs.filter(
    (paragraph) =>
      (operation.target.paragraphId === undefined ||
        paragraph.id === operation.target.paragraphId) &&
      (operation.target.paragraphOrdinal === undefined ||
        paragraph.ordinal === operation.target.paragraphOrdinal),
  )
  const scoped =
    operation.target.paragraphId !== undefined || operation.target.paragraphOrdinal !== undefined
  if (scoped && paragraphMatches.length !== 1)
    return paragraphMatches.length
      ? 'paragraph target is ambiguous'
      : 'paragraph target was not found'
  const paragraph = scoped ? paragraphMatches[0]! : undefined
  const range = paragraph
    ? paragraphRange(cleanText, paragraph)
    : { start: 0, end: cleanText.length }

  if (operation.type === 'append' || operation.type === 'prepend') {
    if (!paragraph) return `${operation.type} requires one paragraph target`
    const point = operation.type === 'append' ? range.end : range.start
    const insertionText = capitalizeReplacementAtSentenceOpening(
      cleanText,
      point,
      operation.text ?? '',
    )
    return {
      operation,
      start: point,
      end: point,
      replacement: addBoundarySpacing(cleanText, point, insertionText),
      paragraphOrdinal: paragraph.ordinal,
    }
  }

  let start = range.start
  let end = range.end
  if (
    operation.target.sentenceOrdinal !== undefined ||
    operation.target.sentenceFromEnd !== undefined
  ) {
    const match = resolveSentenceTarget(cleanText, range.start, range.end, operation.target)
    if (typeof match === 'string') return match
    start = match.start
    end = match.end
  } else if (operation.target.punctuation !== undefined) {
    const match = resolvePunctuationTarget(cleanText, range.start, range.end, operation.target)
    if (typeof match === 'string') return match
    start = match.start
    end = match.end
  } else if (operation.target.exactText !== undefined) {
    const match = findExactOrFuzzyMatch(
      cleanText,
      operation.target.exactText,
      range.start,
      range.end,
    )
    if (typeof match === 'string') return match
    start = match.start
    end = match.end
  } else if (operation.target.approximateText !== undefined) {
    const match = findApproximateMatch(
      cleanText,
      operation.target.approximateText,
      range.start,
      range.end,
    )
    if (typeof match === 'string') return match
    start = match.start
    end = match.end
  } else if (!paragraph && operation.target.scope !== 'draft') {
    return `${operation.type} requires exact text or one paragraph target`
  }
  const isParagraphInsertion =
    paragraph !== undefined &&
    operation.target.exactText === undefined &&
    operation.target.approximateText === undefined &&
    operation.target.punctuation === undefined &&
    (operation.type === 'insert_before' || operation.type === 'insert_after')
  if (isParagraphInsertion) {
    const insertedParagraph = (operation.text ?? '').trim()
    if (!insertedParagraph) return 'paragraph insertion text is empty'
    const point = operation.type === 'insert_before' ? range.start : range.end
    const formattedParagraph = capitalizeReplacementAtSentenceOpening(
      cleanText,
      point,
      insertedParagraph,
    )
    return {
      operation,
      start: point,
      end: point,
      replacement:
        operation.type === 'insert_before'
          ? `${formattedParagraph}\n\n`
          : `\n\n${formattedParagraph}`,
      paragraphOrdinal: paragraph.ordinal,
    }
  }
  if (operation.type === 'delete') {
    if (operation.includeTrailingPunctuation)
      end = extendThroughTerminalPunctuation(cleanText, end, range.end)
    const hasSeparatorBefore = start > range.start && /[ \t]/.test(cleanText[start - 1] ?? '')
    const hasSeparatorAfter = end < range.end && /[ \t]/.test(cleanText[end] ?? '')
    if (hasSeparatorBefore && (hasSeparatorAfter || end === range.end)) start -= 1
    else if (hasSeparatorAfter && start === range.start) end += 1
  }
  const insertionText = operation.text ?? ''
  if (operation.type === 'insert_before') {
    const formattedInsertion = capitalizeReplacementAtSentenceOpening(
      cleanText,
      start,
      insertionText,
    )
    const displacedOpening =
      isSentenceOpeningAt(cleanText, start) && /\p{L}/u.test(formattedInsertion)
        ? lowercaseOrdinarySentenceOpening(
            cleanText,
            start,
            cleanText,
            start,
            protectedCasingTerms,
          )
        : null
    return {
      operation,
      start,
      end: displacedOpening?.end ?? start,
      replacement: `${addBoundarySpacing(cleanText, start, formattedInsertion)}${displacedOpening?.text ?? ''}`,
      paragraphOrdinal: paragraph?.ordinal ?? paragraphOrdinalAtOffset(cleanText, start),
    }
  }
  const replacement =
    operation.type === 'replace'
      ? alignReplacementInitialCasing(
          cleanText,
          start,
          end,
          insertionText,
          protectedCasingTerms,
        )
      : operation.type === 'delete'
        ? ''
        : operation.type === 'insert_after'
            ? addBoundarySpacing(
                cleanText,
                end,
                capitalizeReplacementAtSentenceOpening(cleanText, end, insertionText),
              )
            : applyCase(cleanText.slice(start, end), operation.caseMode!)
  if (operation.type === 'insert_after') start = end
  return {
    operation,
    start,
    end,
    replacement,
    paragraphOrdinal: paragraph?.ordinal ?? paragraphOrdinalAtOffset(cleanText, start),
  }
}

type StructuralEditOperation = EditOperation & {
  type: 'delete' | 'split' | 'join_next' | 'move_before' | 'move_after'
}

type InlineMoveOperation = EditOperation & {
  type: 'move_before' | 'move_after'
  destination: EditTarget
}

interface StructuralParagraph {
  id: string
  originalOrdinal: number
  text: string
}

function isStructuralOperation(operation: EditOperation): operation is StructuralEditOperation {
  return (
    (operation.type === 'delete' &&
      !hasInlineSelector(operation.target) &&
      operation.target.scope !== 'draft' &&
      (operation.target.paragraphId !== undefined ||
        operation.target.paragraphOrdinal !== undefined)) ||
    operation.type === 'split' ||
    operation.type === 'join_next' ||
    ((operation.type === 'move_before' || operation.type === 'move_after') &&
      !isInlineMoveOperation(operation))
  )
}

function isInlineMoveOperation(operation: EditOperation): operation is InlineMoveOperation {
  return (
    (operation.type === 'move_before' || operation.type === 'move_after') &&
    operation.destination !== undefined &&
    hasInlineSelector(operation.target) &&
    hasInlineSelector(operation.destination)
  )
}

function hasInlineSelector(target: EditTarget): boolean {
  return (
    target.exactText !== undefined ||
    target.approximateText !== undefined ||
    target.punctuation !== undefined ||
    target.sentenceOrdinal !== undefined ||
    target.sentenceFromEnd !== undefined
  )
}

interface ResolvedTextTarget {
  start: number
  end: number
  paragraphOrdinal: number
  scopeStart: number
  scopeEnd: number
}

function executeInlineMove(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  operation: InlineMoveOperation,
  protectedCasingTerms: readonly string[],
): EditPipelineResult {
  const source = resolveTextTarget(cleanText, paragraphs, operation.target, 'move source')
  if (typeof source === 'string') return { ok: false, reason: source }
  const destination = resolveTextTarget(
    cleanText,
    paragraphs,
    operation.destination,
    'move destination',
  )
  if (typeof destination === 'string') return { ok: false, reason: destination }
  const sourceEnd = operation.includeTrailingPunctuation
    ? extendThroughTerminalPunctuation(cleanText, source.end, source.scopeEnd)
    : source.end
  if (source.start < destination.end && destination.start < sourceEnd)
    return { ok: false, reason: 'move source and destination overlap' }

  const movedText = cleanText.slice(source.start, sourceEnd)
  let removalStart = source.start
  let removalEnd = sourceEnd
  const hasSeparatorBefore =
    removalStart > source.scopeStart && /[ \t]/.test(cleanText[removalStart - 1] ?? '')
  const hasSeparatorAfter =
    removalEnd < source.scopeEnd && /[ \t]/.test(cleanText[removalEnd] ?? '')
  const endsBeforeClosingPunctuation = /[,.;:!?)}\]”’]/.test(cleanText[removalEnd] ?? '')
  if (
    hasSeparatorBefore &&
    (hasSeparatorAfter || removalEnd === source.scopeEnd || endsBeforeClosingPunctuation)
  )
    removalStart -= 1
  else if (hasSeparatorAfter && removalStart === source.scopeStart) removalEnd += 1

  let withoutSource = `${cleanText.slice(0, removalStart)}${cleanText.slice(removalEnd)}`
  if (isSentenceOpeningAt(cleanText, source.start))
    withoutSource = capitalizeExistingSentenceOpening(withoutSource, removalStart)
  const originalInsertionPoint =
    operation.type === 'move_before' ? destination.start : destination.end
  const insertionPoint =
    originalInsertionPoint > removalStart
      ? originalInsertionPoint - (removalEnd - removalStart)
      : originalInsertionPoint
  const formattedMovedText = capitalizeReplacementAtSentenceOpening(
    withoutSource,
    insertionPoint,
    movedText,
  )
  const displacedOpening =
    operation.type === 'move_before' &&
    isSentenceOpeningAt(withoutSource, insertionPoint) &&
    /\p{L}/u.test(formattedMovedText)
      ? lowercaseOrdinarySentenceOpening(
          withoutSource,
          insertionPoint,
          cleanText,
          destination.start,
          protectedCasingTerms,
        )
      : null
  if (displacedOpening)
    withoutSource = `${withoutSource.slice(0, insertionPoint)}${displacedOpening.text}${withoutSource.slice(displacedOpening.end)}`
  const insertion = addBoundarySpacing(withoutSource, insertionPoint, formattedMovedText)
  const afterText = `${withoutSource.slice(0, insertionPoint)}${insertion}${withoutSource.slice(insertionPoint)}`
  if (afterText.length > MAX_DRAFT_CHARACTERS)
    return { ok: false, reason: 'edited draft is too large' }
  if (afterText === cleanText) return { ok: false, reason: 'edit would not change the draft' }

  return {
    ok: true,
    afterText,
    operations: [
      {
        ...operation,
        startOffset: source.start,
        endOffset: sourceEnd,
        beforeText: movedText,
        afterText: formattedMovedText,
        paragraphOrdinal: source.paragraphOrdinal,
      },
    ],
    affectedParagraphOrdinals: [
      ...new Set([source.paragraphOrdinal, destination.paragraphOrdinal]),
    ].sort((left, right) => left - right),
  }
}

function extendThroughTerminalPunctuation(text: string, end: number, limit: number): number {
  const punctuation = text.slice(end, limit).match(/^(?:\.{3}|[.!?…])/u)?.[0]
  return punctuation ? end + punctuation.length : end
}

function extendThroughSentenceEnd(text: string, end: number): number {
  if (/[.!?…][”’"')\]]*$/u.test(text.slice(0, end))) return end
  const remainder = text.slice(end)
  const terminal = /(?:\.{3}|[.!?…])[”’"')\]]*(?=\s|$)/u.exec(remainder)
  return terminal ? end + (terminal.index ?? 0) + terminal[0].length : end
}

function resolveSentenceTarget(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  target: EditTarget,
): { start: number; end: number } | string {
  const sentences = findSentenceRanges(text, rangeStart, rangeEnd)
  const index =
    target.sentenceOrdinal !== undefined
      ? target.sentenceOrdinal - 1
      : sentences.length - (target.sentenceFromEnd ?? 0)
  return sentences[index] ?? 'sentence position was not found'
}

function findSentenceRanges(
  text: string,
  rangeStart: number,
  rangeEnd: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = rangeStart
  while (cursor < rangeEnd) {
    while (cursor < rangeEnd && /\s/u.test(text[cursor] ?? '')) cursor += 1
    if (cursor >= rangeEnd) break
    const start = cursor
    const remainder = text.slice(cursor, rangeEnd)
    const terminal = /(?:\.{3}|[.!?…])[”’"')\]]*(?=\s|$)/u.exec(remainder)
    if (!terminal) {
      const trailingWhitespace = text.slice(start, rangeEnd).match(/\s*$/u)?.[0].length ?? 0
      ranges.push({ start, end: rangeEnd - trailingWhitespace })
      break
    }
    const end = cursor + (terminal.index ?? 0) + terminal[0].length
    ranges.push({ start, end })
    cursor = end
  }
  return ranges
}

function resolveTextTarget(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  target: EditTarget,
  label: string,
): ResolvedTextTarget | string {
  const paragraphMatches = paragraphs.filter(
    (paragraph) =>
      (target.paragraphId === undefined || paragraph.id === target.paragraphId) &&
      (target.paragraphOrdinal === undefined || paragraph.ordinal === target.paragraphOrdinal),
  )
  const scoped = target.paragraphId !== undefined || target.paragraphOrdinal !== undefined
  if (scoped && paragraphMatches.length !== 1)
    return paragraphMatches.length
      ? `${label} paragraph is ambiguous`
      : `${label} paragraph was not found`
  const paragraph = scoped ? paragraphMatches[0]! : undefined
  const range = paragraph
    ? paragraphRange(cleanText, paragraph)
    : { start: 0, end: cleanText.length }

  let start: number
  let end: number
  if (target.sentenceOrdinal !== undefined || target.sentenceFromEnd !== undefined) {
    const match = resolveSentenceTarget(cleanText, range.start, range.end, target)
    if (typeof match === 'string') return `${label}: ${match}`
    start = match.start
    end = match.end
  } else if (target.punctuation !== undefined) {
    const match = resolvePunctuationTarget(cleanText, range.start, range.end, target)
    if (typeof match === 'string') return `${label}: ${match}`
    start = match.start
    end = match.end
  } else if (target.exactText !== undefined) {
    const match = findExactOrFuzzyMatch(cleanText, target.exactText, range.start, range.end)
    if (match === 'text target is ambiguous') return `${label} is ambiguous`
    if (match === 'text target was not found') return `${label} was not found`
    if (typeof match === 'string') return `${label}: ${match}`
    start = match.start
    end = match.end
  } else if (target.approximateText !== undefined) {
    const match = findApproximateMatch(cleanText, target.approximateText, range.start, range.end)
    if (typeof match === 'string') return `${label}: ${match}`
    start = match.start
    end = match.end
  } else {
    return `${label} requires exact, approximate, sentence, or punctuation text`
  }

  return {
    start,
    end,
    paragraphOrdinal: paragraph?.ordinal ?? paragraphOrdinalAtOffset(cleanText, start),
    scopeStart: range.start,
    scopeEnd: range.end,
  }
}

function isPunctuationTarget(value: unknown): value is PunctuationTarget {
  return (
    value === 'period' ||
    value === 'comma' ||
    value === 'colon' ||
    value === 'semicolon' ||
    value === 'question_mark' ||
    value === 'exclamation_mark' ||
    value === 'ellipsis' ||
    value === 'quote' ||
    value === 'single_quote' ||
    value === 'apostrophe' ||
    value === 'hyphen' ||
    value === 'en_dash' ||
    value === 'em_dash' ||
    value === 'open_parenthesis' ||
    value === 'close_parenthesis' ||
    value === 'open_bracket' ||
    value === 'close_bracket'
  )
}

function resolvePunctuationTarget(
  cleanText: string,
  rangeStart: number,
  rangeEnd: number,
  target: EditTarget,
): { start: number; end: number } | string {
  let matches = findPunctuationMatches(cleanText, target.punctuation!, rangeStart, rangeEnd)
  if (target.relativeToText !== undefined) {
    const anchors = findAll(cleanText, target.relativeToText, rangeStart, rangeEnd)
    if (anchors.length !== 1)
      return anchors.length ? 'punctuation anchor is ambiguous' : 'punctuation anchor was not found'
    const anchorStart = anchors[0]!
    const anchorEnd = anchorStart + target.relativeToText.length
    matches =
      target.relativePosition === 'after'
        ? matches.filter((match) => match.start >= anchorEnd)
        : matches.filter((match) => match.end <= anchorStart).reverse()
  }
  if (target.occurrence !== undefined) {
    const match = matches[target.occurrence - 1]
    return match ?? 'punctuation occurrence was not found'
  }
  if (target.occurrenceFromEnd !== undefined) {
    const match = matches[matches.length - target.occurrenceFromEnd]
    return match ?? 'punctuation occurrence from end was not found'
  }
  if (target.relativeToText !== undefined) {
    return matches[0] ?? 'punctuation target was not found'
  }
  if (matches.length !== 1)
    return matches.length ? 'punctuation target is ambiguous' : 'punctuation target was not found'
  return matches[0]!
}

function findPunctuationMatches(
  text: string,
  punctuation: PunctuationTarget,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const pattern = punctuationPattern(punctuation)
  const matches: Array<{ start: number; end: number }> = []
  for (const match of text.slice(start, end).matchAll(pattern)) {
    const matchStart = start + (match.index ?? 0)
    const value = match[0]
    if (
      punctuation === 'period' &&
      (text[matchStart - 1] === '.' || text[matchStart + value.length] === '.')
    )
      continue
    if (
      punctuation === 'single_quote' &&
      /[\p{L}\p{N}]/u.test(text[matchStart - 1] ?? '') &&
      /[\p{L}\p{N}]/u.test(text[matchStart + value.length] ?? '')
    )
      continue
    matches.push({ start: matchStart, end: matchStart + value.length })
  }
  return matches
}

function punctuationPattern(punctuation: PunctuationTarget): RegExp {
  switch (punctuation) {
    case 'period':
      return /\./g
    case 'comma':
      return /,/g
    case 'colon':
      return /:/g
    case 'semicolon':
      return /;/g
    case 'question_mark':
      return /\?/g
    case 'exclamation_mark':
      return /!/g
    case 'ellipsis':
      return /…|\.{3}/g
    case 'quote':
      return /["“”]/g
    case 'single_quote':
      return /['‘’]/g
    case 'apostrophe':
      return /['’]/g
    case 'hyphen':
      return /-/g
    case 'en_dash':
      return /–/g
    case 'em_dash':
      return /—/g
    case 'open_parenthesis':
      return /\(/g
    case 'close_parenthesis':
      return /\)/g
    case 'open_bracket':
      return /\[/g
    case 'close_bracket':
      return /\]/g
  }
}

function addBoundarySpacing(text: string, point: number, insertion: string): string {
  let result = insertion
  const left = text[point - 1] ?? ''
  const right = text[point] ?? ''
  const leftIsClosingAsciiQuote =
    (left === '"' || left === "'") && /[.?!\u2026]/u.test(text[point - 2] ?? '')
  if (/[ \t]/.test(left)) result = result.replace(/^[ \t]+/u, '')
  if (/[ \t]/.test(right)) result = result.replace(/[ \t]+$/u, '')
  if (
    left &&
    !/\s/.test(left) &&
    (!/[([{“‘"']/.test(left) || leftIsClosingAsciiQuote) &&
    !/^\s/.test(result) &&
    !/^[,.;:!?)}\]”’"']/.test(result)
  )
    result = ` ${result}`
  if (
    right &&
    !/\s/.test(right) &&
    !/^[,.;:!?)}\]”’"']/.test(right) &&
    !/\s$/.test(result) &&
    !/[([{“‘"']$/.test(result)
  )
    result = `${result} `
  return result
}

function capitalizeReplacementAtSentenceOpening(
  text: string,
  start: number,
  replacement: string,
): string {
  const before = text.slice(0, start)
  const isSentenceOpening = /(?:^|\n{2,}|[.?!…][”’"']?(?:[ \t]+|$))[ \t]*[“‘"'([{]*[ \t]*$/u.test(
    before,
  )
  if (!isSentenceOpening) return replacement

  return replacement.replace(
    /^([ \t]*[“‘"'([{]*[ \t]*)([\p{Ll}][\p{L}\p{M}'’-]*)/u,
    (whole, prefix: string, word: string) => {
      if (/\p{Lu}/u.test(word.slice(1))) return whole
      return `${prefix}${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`
    },
  )
}

function alignReplacementInitialCasing(
  text: string,
  start: number,
  end: number,
  replacement: string,
  protectedCasingTerms: readonly string[],
): string {
  if (isSentenceOpeningAt(text, start))
    return capitalizeReplacementAtSentenceOpening(text, start, replacement)

  const replacedOpening = text
    .slice(start, end)
    .match(/^[ \t]*[\u201c\u2018"'([{]*[ \t]*(\p{L})/u)?.[1]
  if (!replacedOpening || !/\p{Ll}/u.test(replacedOpening)) return replacement

  const evidenceText = `${replacement}\n\n${text}`
  const lowered = lowercaseOrdinarySentenceOpening(
    replacement,
    0,
    evidenceText,
    0,
    protectedCasingTerms,
  )
  return lowered ? `${lowered.text}${replacement.slice(lowered.end)}` : replacement
}

function isSentenceOpeningAt(text: string, point: number): boolean {
  const before = text.slice(0, point)
  return /(?:^|\n{2,}|[.?!\u2026][\u201d\u2019"']?(?:[ \t]+|$))[ \t]*[\u201c\u2018"'([{]*[ \t]*$/u.test(
    before,
  )
}

interface LowercasedSentenceOpening {
  end: number
  text: string
}

const CALENDAR_PROPER_NOUNS = new Set([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
])

function lowercaseOrdinarySentenceOpening(
  text: string,
  start: number,
  evidenceText: string,
  evidenceStart: number,
  protectedCasingTerms: readonly string[],
): LowercasedSentenceOpening | null {
  const match = text
    .slice(start)
    .match(/^([ \t]*[\u201c\u2018"'([{]*[ \t]*)(\p{Lu}[\p{L}\p{M}'\u2019-]*)/u)
  if (!match) return null
  const prefix = match[1]!
  const word = match[2]!
  if (
    looksLikeProperNoun(
      evidenceText,
      evidenceStart + prefix.length,
      word,
      protectedCasingTerms,
    )
  )
    return null
  const loweredWord = `${word.charAt(0).toLocaleLowerCase()}${word.slice(1)}`
  return { end: start + match[0].length, text: `${prefix}${loweredWord}` }
}

function looksLikeProperNoun(
  text: string,
  wordStart: number,
  word: string,
  protectedCasingTerms: readonly string[],
): boolean {
  if (/\p{Lu}/u.test(word.slice(1))) return true
  if (CALENDAR_PROPER_NOUNS.has(word)) return true
  if (
    protectedCasingTerms.some((term) => {
      const termWords: string[] = term.match(/[\p{L}\p{M}'\u2019-]+/gu) ?? []
      return termWords.includes(word)
    })
  )
    return true

  const following = text.slice(wordStart + word.length)
  if (/^[ \t]+\p{Lu}\p{Ll}+/u.test(following)) return true

  const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const occurrencePattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapedWord}(?![\\p{L}\\p{N}])`,
    'gu',
  )
  for (const occurrence of text.matchAll(occurrencePattern)) {
    const occurrenceStart = occurrence.index
    if (occurrenceStart === wordStart) continue
    if (!isSentenceOpeningAt(text, occurrenceStart)) return true
  }
  return false
}

function capitalizeExistingSentenceOpening(text: string, start: number): string {
  const suffix = text.slice(start)
  const capitalized = suffix.replace(
    /^([ \t]*[\u201c\u2018"'([{]*[ \t]*)([\p{Ll}][\p{L}\p{M}'\u2019-]*)/u,
    (whole, prefix: string, word: string) => {
      if (/\p{Lu}/u.test(word.slice(1))) return whole
      return `${prefix}${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`
    },
  )
  return `${text.slice(0, start)}${capitalized}`
}

function executeStructuralPlan(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  operations: readonly StructuralEditOperation[],
): EditPipelineResult {
  const working: StructuralParagraph[] = paragraphs.map((paragraph) => ({
    id: paragraph.id,
    originalOrdinal: paragraph.ordinal,
    text: paragraph.text,
  }))
  const resolved: ResolvedEditOperation[] = []
  const affected = new Set<number>()

  for (const operation of operations) {
    const sourceResult = resolveStructuralParagraph(working, operation.target)
    if (typeof sourceResult === 'string') return { ok: false, reason: sourceResult }
    const sourceIndex = working.indexOf(sourceResult)
    const original = paragraphs.find((paragraph) => paragraph.id === sourceResult.id)
    const originalRange = original
      ? paragraphRange(cleanText, original)
      : { start: 0, end: cleanText.length }
    let afterText = sourceResult.text

    if (operation.type === 'delete') {
      working.splice(sourceIndex, 1)
      afterText = ''
    } else if (operation.type === 'split') {
      let splitAt: number
      if (
        operation.target.sentenceOrdinal !== undefined ||
        operation.target.sentenceFromEnd !== undefined
      ) {
        const sentence = resolveSentenceTarget(
          sourceResult.text,
          0,
          sourceResult.text.length,
          operation.target,
        )
        if (typeof sentence === 'string') return { ok: false, reason: sentence }
        splitAt = sentence.end
      } else {
        const anchor = operation.target.exactText
        if (!anchor) return { ok: false, reason: 'split requires an exact or sentence anchor' }
        const matches = findAll(sourceResult.text, anchor, 0, sourceResult.text.length)
        if (matches.length !== 1)
          return {
            ok: false,
            reason: matches.length ? 'split anchor is ambiguous' : 'split anchor was not found',
          }
        const anchorEnd = matches[0]! + anchor.length
        splitAt = operation.includeTrailingPunctuation
          ? extendThroughSentenceEnd(sourceResult.text, anchorEnd)
          : anchorEnd
      }
      const left = sourceResult.text.slice(0, splitAt).trimEnd()
      const right = sourceResult.text.slice(splitAt).trimStart()
      if (!left || !right) return { ok: false, reason: 'split would create an empty paragraph' }
      sourceResult.text = left
      working.splice(sourceIndex + 1, 0, {
        id: `${sourceResult.id}:split:${operation.id}`,
        originalOrdinal: sourceResult.originalOrdinal,
        text: right,
      })
      afterText = `${left}\n\n${right}`
    } else if (operation.type === 'join_next') {
      const next = working[sourceIndex + 1]
      if (!next) return { ok: false, reason: 'join target has no following paragraph' }
      sourceResult.text = `${sourceResult.text.trimEnd()} ${next.text.trimStart()}`
      working.splice(sourceIndex + 1, 1)
      afterText = sourceResult.text
      affected.add(next.originalOrdinal)
    } else {
      const destinationResult = resolveStructuralParagraph(working, operation.destination!)
      if (typeof destinationResult === 'string') return { ok: false, reason: destinationResult }
      if (destinationResult.id === sourceResult.id)
        return { ok: false, reason: 'move source and destination are the same paragraph' }
      working.splice(sourceIndex, 1)
      const destinationIndex = working.indexOf(destinationResult)
      const insertionIndex =
        operation.type === 'move_before' ? destinationIndex : destinationIndex + 1
      working.splice(insertionIndex, 0, sourceResult)
      affected.add(destinationResult.originalOrdinal)
    }

    affected.add(sourceResult.originalOrdinal)
    resolved.push({
      ...operation,
      startOffset: originalRange.start,
      endOffset: originalRange.end,
      beforeText: original?.text ?? sourceResult.text,
      afterText,
      paragraphOrdinal: sourceResult.originalOrdinal,
    })
  }

  const afterText = working.map((paragraph) => paragraph.text).join('\n\n')
  if (afterText.length > MAX_DRAFT_CHARACTERS)
    return { ok: false, reason: 'edited draft is too large' }
  if (afterText === cleanText) return { ok: false, reason: 'edit would not change the draft' }
  return {
    ok: true,
    afterText,
    operations: resolved,
    affectedParagraphOrdinals: [...affected].sort((left, right) => left - right),
    resultingParagraphIds: working.map((paragraph) => paragraph.id),
  }
}

function resolveStructuralParagraph(
  paragraphs: readonly StructuralParagraph[],
  target: EditTarget,
): StructuralParagraph | string {
  if (target.scope === 'draft') return 'structural operation requires one paragraph target'
  const matches = paragraphs.filter(
    (paragraph) =>
      (target.paragraphId === undefined || paragraph.id === target.paragraphId) &&
      (target.paragraphOrdinal === undefined ||
        paragraph.originalOrdinal === target.paragraphOrdinal),
  )
  if (target.paragraphId === undefined && target.paragraphOrdinal === undefined)
    return 'structural operation requires one paragraph target'
  if (matches.length !== 1)
    return matches.length ? 'paragraph target is ambiguous' : 'paragraph target was not found'
  return matches[0]!
}

function paragraphRange(text: string, paragraph: DraftParagraph): { start: number; end: number } {
  const lines = text.split('\n')
  let start = 0
  for (let index = 0; index < paragraph.lineIndex; index += 1) start += lines[index]!.length + 1
  return { start, end: start + lines[paragraph.lineIndex]!.length }
}

function findAll(text: string, search: string, start: number, end: number): number[] {
  const matches: number[] = []
  let offset = start
  while (offset <= end - search.length) {
    const index = text.indexOf(search, offset)
    if (index < 0 || index + search.length > end) break
    matches.push(index)
    offset = index + Math.max(search.length, 1)
  }
  return matches
}

function findExactOrFuzzyMatch(
  text: string,
  search: string,
  start: number,
  end: number,
): { start: number; end: number } | string {
  const exactMatches = findAll(text, search, start, end)
  if (exactMatches.length > 1) return 'text target is ambiguous'
  if (exactMatches.length === 1)
    return { start: exactMatches[0]!, end: exactMatches[0]! + search.length }

  const approximate = findApproximateMatch(text, search, start, end)
  if (typeof approximate !== 'string') return approximate
  return approximate.includes('ambiguous')
    ? 'fuzzy text target is ambiguous'
    : 'text target was not found'
}

function findApproximateMatch(
  text: string,
  search: string,
  start: number,
  end: number,
): { start: number; end: number } | string {
  const wanted = tokenizeWithOffsets(search, 0, search.length)
  if (!wanted.length) return 'approximate text target was not found'
  const available = tokenizeWithOffsets(text, start, end)
  if (!available.length) return 'approximate text target was not found'
  const wantedText = wanted.map(({ value }) => value).join(' ')
  const wantedCompact = wantedText.replace(/\s+/gu, '')
  const wantedPhonetic = phoneticKey(wantedCompact)
  const candidates: Array<{
    start: number
    end: number
    score: number
    boundaryFallback: boolean
    shortWordFallback: boolean
    phoneticFallback: boolean
  }> = []
  const addCandidates = (length: number) => {
    for (let index = 0; index <= available.length - length; index += 1) {
      const window = available.slice(index, index + length)
      const candidateText = window.map(({ value }) => value).join(' ')
      const candidateCompact = candidateText.replace(/\s+/gu, '')
      const compactScore = stringSimilarity(wantedCompact, candidateCompact)
      const candidatePhonetic = phoneticKey(candidateCompact)
      const phoneticScore = stringSimilarity(wantedPhonetic, candidatePhonetic)
      candidates.push({
        start: window[0]!.start,
        end: window.at(-1)!.end,
        score: Math.max(
          stringSimilarity(wantedText, candidateText),
          compactScore,
          phoneticScore * 0.75 + compactScore * 0.25,
        ),
        boundaryFallback:
          length !== wanted.length &&
          Math.min(wantedCompact.length, candidateCompact.length) >= 5 &&
          Math.abs(wantedCompact.length - candidateCompact.length) <= 2 &&
          compactScore >= 2 / 3,
        shortWordFallback:
          wanted.length === 1 &&
          length === 1 &&
          Math.min(wantedCompact.length, candidateCompact.length) >= 4 &&
          Math.abs(wantedCompact.length - candidateCompact.length) <= 1 &&
          compactScore >= 0.75,
        phoneticFallback:
          Math.min(wantedPhonetic.length, candidatePhonetic.length) >= 4 &&
          wantedPhonetic.charAt(0) === candidatePhonetic.charAt(0) &&
          compactScore >= 0.5 &&
          phoneticScore >= 0.8,
      })
    }
  }
  addCandidates(wanted.length)
  if (wanted.length > 1) addCandidates(wanted.length - 1)
  addCandidates(wanted.length + 1)
  candidates.sort((left, right) => right.score - left.score)
  const best = candidates[0]
  if (
    !best ||
    (best.score < 0.78 &&
      !best.boundaryFallback &&
      !best.shortWordFallback &&
      !best.phoneticFallback)
  )
    return 'approximate text target was not found'
  const runnerUp = candidates.find(
    (candidate) => candidate.end <= best.start || candidate.start >= best.end,
  )
  if (runnerUp && best.score - runnerUp.score < 0.12) return 'approximate text target is ambiguous'
  return { start: best.start, end: best.end }
}

function tokenizeWithOffsets(
  text: string,
  start: number,
  end: number,
): Array<{ value: string; start: number; end: number }> {
  const tokens: Array<{ value: string; start: number; end: number }> = []
  const segment = text.slice(start, end)
  for (const match of segment.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)) {
    const offset = start + (match.index ?? 0)
    tokens.push({
      value: match[0].toLocaleLowerCase(),
      start: offset,
      end: offset + match[0].length,
    })
  }
  return tokens
}

function stringSimilarity(left: string, right: string): number {
  const rows = left.length + 1
  const columns = right.length + 1
  const previous = Array.from({ length: columns }, (_, index) => index)
  for (let row = 1; row < rows; row += 1) {
    const current = new Array<number>(columns)
    current[0] = row
    for (let column = 1; column < columns; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
    for (let column = 0; column < columns; column += 1) previous[column] = current[column]!
  }
  return 1 - previous[columns - 1]! / Math.max(left.length, right.length, 1)
}

function phoneticKey(value: string): string {
  const prepared = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ph/gu, 'f')
    .replace(/ght/gu, 't')
    .replace(/gh/gu, '')
    .replace(/ck/gu, 'k')
    .replace(/kn/gu, 'n')
    .replace(/wr/gu, 'r')
    .replace(/qu/gu, 'kw')
  let key = ''
  for (const character of prepared) {
    const sound = phoneticSoundGroup(character)
    if (sound && sound !== key.at(-1)) key += sound
  }
  return key
}

function phoneticSoundGroup(character: string): string {
  if (/[aeiou]/u.test(character)) return 'A'
  if (/[bp]/u.test(character)) return 'B'
  if (/[fv]/u.test(character)) return 'F'
  if (/[cgjkq]/u.test(character)) return 'K'
  if (/[dt]/u.test(character)) return 'T'
  if (/[sxz]/u.test(character)) return 'S'
  if (character === 'l') return 'L'
  if (character === 'm') return 'M'
  if (character === 'n') return 'N'
  if (character === 'r') return 'R'
  if (/[hwy]/u.test(character)) return ''
  return /[\p{L}\p{N}]/u.test(character) ? character : ''
}

function applyCase(value: string, mode: NonNullable<EditOperation['caseMode']>): string {
  if (mode === 'uppercase') return value.toLocaleUpperCase()
  if (mode === 'lowercase') return value.toLocaleLowerCase()
  const index = value.search(/[\p{L}]/u)
  return index < 0
    ? value
    : `${value.slice(0, index)}${value[index]!.toLocaleUpperCase()}${value.slice(index + 1)}`
}

function paragraphOrdinalAtOffset(text: string, offset: number): number {
  return Math.max(
    1,
    text
      .slice(0, offset)
      .split('\n')
      .filter((line) => line.trim()).length,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
