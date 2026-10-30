import { MAX_DRAFT_CHARACTERS, reconcileParagraphs, type DraftParagraph } from './draft-session'
import { speechPhoneticKey } from './phonetics'

export const EDIT_SCHEMA_VERSION = 2 as const
export const MAX_EDIT_OPERATIONS = 8
export const MAX_EDIT_TEXT_LENGTH = 10_000

export type EditOperationType =
  | 'replace'
  | 'insert_before'
  | 'insert_after'
  | 'delete'
  | 'delete_range'
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
      failedCommand?: { index: number; operationId: string; reason: string }
    }
  | { ok: false; reason: string }

interface Patch {
  operation: EditOperation
  start: number
  end: number
  replacement: string
  paragraphOrdinal: number
}

/** Run a chain against an in-memory draft, stopping at its first unsafe operation. */
export function executeSequentialEditPlan(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  currentVersion: number,
  plan: EditPlan,
  protectedCasingTerms: readonly string[] = [],
): EditPipelineResult {
  if (plan.draftVersion !== currentVersion) return { ok: false, reason: 'stale draft version' }
  let text = cleanText
  let currentParagraphs = [...paragraphs]
  const operations: ResolvedEditOperation[] = []
  const affected = new Set<number>()
  let failedCommand: { index: number; operationId: string; reason: string } | undefined
  let generated = 0
  const usedIds = new Set(currentParagraphs.map((paragraph) => paragraph.id))
  const createId = () => {
    let id: string
    do id = `chain:${plan.draftVersion}:${++generated}`
    while (usedIds.has(id))
    usedIds.add(id)
    return id
  }
  for (const [index, operation] of plan.operations.entries()) {
    let currentOperation = operation
    const exact = operation.target.exactText
    if (index > 0 && operation.type === 'insert_after' && exact && /[.!?…]$/u.test(exact)) {
      const base = exact.replace(/[.!?…]+$/u, '')
      const scoped = currentParagraphs.filter((paragraph) =>
        (operation.target.paragraphId === undefined || paragraph.id === operation.target.paragraphId) &&
        (operation.target.paragraphOrdinal === undefined || paragraph.ordinal === operation.target.paragraphOrdinal),
      )
      const search = operation.target.paragraphId !== undefined || operation.target.paragraphOrdinal !== undefined
        ? scoped.map((paragraph) => paragraph.text).join('\n')
        : text
      const candidates = [...search.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(base)}[,;:—–-](?=\\s|$)`, 'giu'))]
      if (candidates.length === 1 && !search.includes(exact))
        currentOperation = { ...operation, target: { ...operation.target, exactText: candidates[0]![0] } }
    }
    const result = executeEditPlan(text, currentParagraphs, currentVersion, {
      ...plan,
      operations: [currentOperation],
    }, protectedCasingTerms)
    if (!result.ok) {
      failedCommand = { index: index + 1, operationId: operation.id, reason: result.reason }
      break
    }
    operations.push(...result.operations)
    for (const ordinal of result.affectedParagraphOrdinals) affected.add(ordinal)
    if (result.resultingParagraphIds) {
      let paragraphIndex = 0
      currentParagraphs = result.afterText.split('\n').flatMap((line, lineIndex) => {
        if (!line.trim()) return []
        const id = result.resultingParagraphIds![paragraphIndex]!
        paragraphIndex += 1
        return [{ id, ordinal: paragraphIndex, lineIndex, text: line }]
      })
      for (const paragraph of currentParagraphs) usedIds.add(paragraph.id)
    } else {
      currentParagraphs = reconcileParagraphs(currentParagraphs, result.afterText, createId)
    }
    text = result.afterText
  }
  if (!operations.length || text === cleanText)
    return { ok: false, reason: failedCommand ? `Command ${failedCommand.index}: ${failedCommand.reason}` : 'edit would not change the draft' }
  return {
    ok: true,
    afterText: text,
    operations,
    affectedParagraphOrdinals: [...affected].sort((a, b) => a - b),
    resultingParagraphIds: currentParagraphs.map((paragraph) => paragraph.id),
    ...(failedCommand ? { failedCommand } : {}),
  }
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

export interface EditExecutionOptions {
  /**
   * Diagnostic switch used by the isolation tests: skip per-operation casing,
   * boundary spacing, and separator trimming so the raw patch can be compared
   * against the universal deterministic cleanup.
   */
  skipOperationFormatting?: boolean
}

export function executeEditPlan(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  currentVersion: number,
  plan: EditPlan,
  protectedCasingTerms: readonly string[] = [],
  options: EditExecutionOptions = {},
): EditPipelineResult {
  const formatText = options.skipOperationFormatting !== true
  if (plan.draftVersion !== currentVersion) return { ok: false, reason: 'stale draft version' }
  if (plan.operations.length === 1 && plan.operations[0]?.type === 'delete_range')
    return executeRangeDeletion(cleanText, paragraphs, plan.operations[0], protectedCasingTerms)
  const inlineMoves = plan.operations.filter(isInlineMoveOperation)
  if (inlineMoves.length) {
    if (inlineMoves.length !== plan.operations.length || inlineMoves.length > 1)
      return { ok: false, reason: 'an inline move must be the only operation in its edit plan' }
    return executeInlineMove(
      cleanText,
      paragraphs,
      inlineMoves[0]!,
      protectedCasingTerms,
      formatText,
    )
  }
  const structural = plan.operations.filter(isStructuralOperation)
  if (structural.length) {
    if (structural.length !== plan.operations.length)
      return { ok: false, reason: 'structural and inline operations cannot be mixed' }
    return executeStructuralPlan(cleanText, paragraphs, structural)
  }
  const patches: Patch[] = []
  for (const operation of plan.operations) {
    const patch = resolveOperation(
      cleanText,
      paragraphs,
      operation,
      protectedCasingTerms,
      formatText,
    )
    if (typeof patch === 'string') return { ok: false, reason: patch }
    if (
      formatText &&
      (operation.type === 'insert_after' || operation.type === 'append') &&
      patches.length > 0
    ) {
      // Targets retain their original-draft coordinates, but formatting must see
      // earlier edits in the same instruction (e.g. a period changed to a comma).
      const preceding = patches
        .filter((prior) => prior.end <= patch.start && prior.start !== prior.end)
        .sort((left, right) => right.start - left.start)
      let projectedText = cleanText
      let projectedPoint = patch.start
      for (const prior of preceding) {
        projectedText = `${projectedText.slice(0, prior.start)}${prior.replacement}${projectedText.slice(prior.end)}`
        projectedPoint += prior.replacement.length - (prior.end - prior.start)
      }
      const inserted = capitalizeReplacementAtSentenceOpening(
        projectedText,
        projectedPoint,
        operation.text ?? '',
      )
      patch.replacement = addBoundarySpacing(projectedText, projectedPoint, inserted)
    }
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
      (current.start === previous.start &&
        current.end === current.start &&
        previous.end === previous.start)
    )
      return { ok: false, reason: 'edit operations overlap' }
  }
  let afterText = cleanText
  for (const patch of sorted) {
    afterText = `${afterText.slice(0, patch.start)}${patch.replacement}${afterText.slice(patch.end)}`
  }
  if (afterText.length > MAX_DRAFT_CHARACTERS)
    return { ok: false, reason: 'edited draft is too large' }
  if (countFloatingQuotationMarks(afterText) > countFloatingQuotationMarks(cleanText))
    return { ok: false, reason: QUOTATION_OUTSIDE_PARAGRAPH_REASON }
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
    type !== 'delete_range' &&
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
  } else if (type === 'delete_range') {
    if (text !== undefined || caseMode !== undefined || !destination || includeTrailingPunctuation !== undefined) return null
    if (!hasInlineSelector(target) || !hasInlineSelector(destination)) return null
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

/**
 * A target names text the user spoke, never the punctuation that ends the previous sentence.
 * Leading whitespace and sentence punctuation are dropped so a delete cannot take that mark.
 */
function trimTargetBoundary(text: string): string {
  return text.replace(/^[\s.!?…,;:]+/u, '').trim()
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
    const exactText = trimTargetBoundary(value.exactText)
    if (!exactText) return null
    target.exactText = exactText
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
    (target.occurrenceFromEnd !== undefined || hasRelativePosition || hasRelativeText)
  )
    return null
  if (
    target.punctuation === undefined &&
    target.occurrence !== undefined &&
    target.exactText === undefined
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
  formatText: boolean,
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
    if (hasInlineSelector(operation.target))
      return `${operation.type} does not accept an inline target`
    const point = operation.type === 'append' ? range.end : range.start
    const insertionText = formatText
      ? formatInsertionCasing(cleanText, point, operation.text ?? '', protectedCasingTerms)
      : (operation.text ?? '')
    const displacedOpening =
      formatText && operation.type === 'prepend' && isContinuingInsertion(insertionText)
        ? lowercaseOrdinarySentenceOpening(cleanText, point, cleanText, point, protectedCasingTerms)
        : null
    return {
      operation,
      start: point,
      end: displacedOpening?.end ?? point,
      replacement: formatText
        ? `${addBoundarySpacing(cleanText, point, insertionText)}${displacedOpening?.text ?? ''}`
        : insertionText,
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
      operation.target.occurrence,
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
    !hasInlineSelector(operation.target) &&
    (operation.type === 'insert_before' || operation.type === 'insert_after')
  if (isParagraphInsertion) {
    const insertedParagraph = (operation.text ?? '').trim()
    if (!insertedParagraph) return 'paragraph insertion text is empty'
    const point = operation.type === 'insert_before' ? range.start : range.end
    const formattedParagraph = formatText
      ? capitalizeReplacementAtSentenceOpening(cleanText, point, insertedParagraph)
      : insertedParagraph
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
    const wrapped = expandThroughPairedPunctuation(cleanText, start, end, range.start, range.end)
    start = wrapped.start
    end = wrapped.end
    if (operation.includeTrailingPunctuation) {
      end = extendThroughTerminalPunctuation(cleanText, end, range.end)
    } else if (isSentenceOpeningAt(cleanText, start)) {
      const orphanedPunctuation = attachedSentencePartPunctuation(cleanText, end, range.end)
      if (orphanedPunctuation) end += orphanedPunctuation.length
    } else if (
      /[.,;:!?…—–-][ \t]*$/u.test(cleanText.slice(range.start, start)) &&
      attachedSentencePartPunctuation(cleanText, end, range.end)
    ) {
      // A complete middle phrase has a separator on each side. Preserve the
      // leading separator and consume the now-duplicate trailing one.
      end += attachedSentencePartPunctuation(cleanText, end, range.end).length
    }
    if (formatText) {
      const hasSeparatorBefore = start > range.start && /[ \t]/.test(cleanText[start - 1] ?? '')
      const hasSeparatorAfter = end < range.end && /[ \t]/.test(cleanText[end] ?? '')
      const endsLine = end >= range.end || /[\r\n]/.test(cleanText[end] ?? '')
      const endsBeforeClosingWrapper = /^[”’"')\]}]+(?=\s|$)/u.test(
        cleanText.slice(end, range.end),
      )
      if (hasSeparatorBefore && (hasSeparatorAfter || endsLine || endsBeforeClosingWrapper))
        start -= 1
      else if (hasSeparatorAfter && start === range.start) end += 1
      else if (
        hasSeparatorAfter &&
        /[“‘"'([{<`*_]$/u.test(cleanText.slice(range.start, start))
      )
        end += 1
    }
  }
  const insertionText = operation.text ?? ''
  if (operation.type === 'insert_before') {
    const formattedInsertion = formatText
      ? capitalizeReplacementAtSentenceOpening(cleanText, start, insertionText)
      : insertionText
    const displacedOpening =
      formatText && isSentenceOpeningAt(cleanText, start) && isContinuingInsertion(formattedInsertion)
        ? lowercaseOrdinarySentenceOpening(cleanText, start, cleanText, start, protectedCasingTerms)
        : null
    return {
      operation,
      start,
      end: displacedOpening?.end ?? start,
      replacement: formatText
        ? `${addBoundarySpacing(cleanText, start, formattedInsertion)}${displacedOpening?.text ?? ''}`
        : formattedInsertion,
      paragraphOrdinal: paragraph?.ordinal ?? paragraphOrdinalAtOffset(cleanText, start),
    }
  }
  const insertAfterPoint =
    formatText && operation.type === 'insert_after'
      ? advancePastAdjacentSentenceEnding(cleanText, end, range.end, insertionText)
      : end
  const replacement =
    operation.type === 'replace'
      ? formatText
        ? alignReplacementInitialCasing(cleanText, start, end, insertionText, protectedCasingTerms)
        : insertionText
      : operation.type === 'delete'
        ? ''
        : operation.type === 'insert_after'
          ? formatText
            ? addBoundarySpacing(
                cleanText,
                insertAfterPoint,
                formatInsertionCasing(cleanText, insertAfterPoint, insertionText, protectedCasingTerms),
              )
            : insertionText
          : applyCase(cleanText.slice(start, end), operation.caseMode!)
  if (operation.type === 'insert_after') {
    start = insertAfterPoint
    end = insertAfterPoint
  }
  return {
    operation,
    start,
    end,
    replacement,
    paragraphOrdinal: paragraph?.ordinal ?? paragraphOrdinalAtOffset(cleanText, start),
  }
}

function advancePastAdjacentSentenceEnding(
  text: string,
  point: number,
  limit: number,
  insertion: string,
): number {
  // Phrase insertions remain literal. Only a complete inserted sentence moves
  // beyond terminal punctuation that belongs to the preceding sentence.
  if (!/(?:\.{3}|[.!?\u2026])[\u201d\u2019"')\]]*\s*$/u.test(insertion)) return point
  const ending = text
    .slice(point, limit)
    .match(/^(?:\.{3}|[.!?\u2026])[\u201d\u2019"')\]]*(?=\s|$)/u)?.[0]
  return ending ? point + ending.length : point
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

function executeRangeDeletion(
  text: string,
  paragraphs: readonly DraftParagraph[],
  operation: EditOperation,
  protectedCasingTerms: readonly string[],
): EditPipelineResult {
  if (!operation.destination) return { ok: false, reason: 'range end is required' }
  const start = resolveTextTarget(text, paragraphs, operation.target, 'range start')
  if (typeof start === 'string') return { ok: false, reason: start }
  const end = resolveTextTarget(text, paragraphs, operation.destination, 'range end')
  if (typeof end === 'string') return { ok: false, reason: end }
  if (end.start < start.end) return { ok: false, reason: 'range endpoints are reversed or overlap' }
  const endingPunctuation = text.slice(end.end).match(/^(?:\.{3}|[.!?…]+)(?=[”’"')\]]*(?:\s|$))/u)?.[0] ?? ''
  const deletionEnd = end.end + endingPunctuation.length
  const left = text.slice(0, start.start).replace(/\s+$/u, '')
  let right = text.slice(deletionEnd).replace(/^\s+/u, '')
  if (/[.!?…][”’"')\]]*$/u.test(left)) right = right.replace(/^[.!?…]+\s*/u, '')
  else if (/[,;:—–-]$/u.test(left)) right = right.replace(/^[,;:—–-]+\s*/u, '')
  if (right && /[.!?…][”’"')\]]*$/u.test(left))
    right = capitalizeReplacementAtSentenceOpening(left, left.length, right)
  else if (right && /[,;:—–-][”’"')\]]*$/u.test(left))
    right = formatInsertionCasing(left, left.length, right, protectedCasingTerms)
  const spacing = left && right && !/^[,.;:!?…)}\]”’]/u.test(right) ? ' ' : ''
  const afterText = `${left}${spacing}${right}`
  if (countFloatingQuotationMarks(afterText) > countFloatingQuotationMarks(text))
    return { ok: false, reason: QUOTATION_OUTSIDE_PARAGRAPH_REASON }
  if (afterText === text) return { ok: false, reason: 'edit would not change the draft' }
  return {
    ok: true,
    afterText,
    operations: [{ ...operation, startOffset: start.start, endOffset: deletionEnd,
      beforeText: text.slice(start.start, deletionEnd), afterText: '', paragraphOrdinal: start.paragraphOrdinal }],
    affectedParagraphOrdinals: [...new Set([start.paragraphOrdinal, end.paragraphOrdinal])].sort((a, b) => a - b),
  }
}

function executeInlineMove(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  operation: InlineMoveOperation,
  protectedCasingTerms: readonly string[],
  formatText: boolean,
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
    formatText &&
    hasSeparatorBefore &&
    (hasSeparatorAfter || removalEnd === source.scopeEnd || endsBeforeClosingPunctuation)
  )
    removalStart -= 1
  else if (formatText && hasSeparatorAfter && removalStart === source.scopeStart) removalEnd += 1

  let withoutSource = `${cleanText.slice(0, removalStart)}${cleanText.slice(removalEnd)}`
  if (formatText && isSentenceOpeningAt(cleanText, source.start))
    withoutSource = capitalizeExistingSentenceOpening(withoutSource, removalStart)
  const originalInsertionPoint =
    operation.type === 'move_before' ? destination.start : destination.end
  const insertionPoint =
    originalInsertionPoint > removalStart
      ? originalInsertionPoint - (removalEnd - removalStart)
      : originalInsertionPoint
  const formattedMovedText = formatText
    ? formatInsertionCasing(withoutSource, insertionPoint, movedText, protectedCasingTerms)
    : movedText
  const displacedOpening =
    formatText &&
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
  const insertion = formatText
    ? addBoundarySpacing(withoutSource, insertionPoint, formattedMovedText)
    : formattedMovedText
  const afterText = `${withoutSource.slice(0, insertionPoint)}${insertion}${withoutSource.slice(insertionPoint)}`
  if (afterText.length > MAX_DRAFT_CHARACTERS)
    return { ok: false, reason: 'edited draft is too large' }
  if (countFloatingQuotationMarks(afterText) > countFloatingQuotationMarks(cleanText))
    return { ok: false, reason: QUOTATION_OUTSIDE_PARAGRAPH_REASON }
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

/** Sentence-part punctuation that becomes orphaned when the entire part is removed. */
function attachedSentencePartPunctuation(text: string, end: number, limit: number): string {
  return (
    text
      .slice(end, limit)
      .match(/^((?:\.{3}|[.,;:!?…—–-])+)(?=[”’"')\]}]*(?:\s|$))/u)?.[1] ?? ''
  )
}

/**
 * Include a paired wrapper only when the target is the wrapper's complete content.
 * Optional inner whitespace and terminal punctuation inside a closing wrapper belong
 * to that wrapped phrase. Longer Markdown markers are checked before single markers.
 */
function expandThroughPairedPunctuation(
  text: string,
  start: number,
  end: number,
  limitStart: number,
  limitEnd: number,
): { start: number; end: number } {
  const before = text.slice(limitStart, start)
  const after = text.slice(end, limitEnd)
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['***', '***'],
    ['___', '___'],
    ['**', '**'],
    ['__', '__'],
    ['“', '”'],
    ['‘', '’'],
    ['"', '"'],
    ["'", "'"],
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['<', '>'],
    ['`', '`'],
    ['*', '*'],
    ['_', '_'],
  ]
  for (const [opening, closing] of pairs) {
    const left = before.match(new RegExp(`${escapeRegExp(opening)}[ \\t]*$`, 'u'))?.[0]
    if (!left) continue
    const right = after.match(
      new RegExp(`^[ \\t]*(?:\\.{3}|[.,;:!?…—–-])*[ \\t]*${escapeRegExp(closing)}`, 'u'),
    )?.[0]
    if (!right) continue
    return { start: start - left.length, end: end + right.length }
  }
  return { start, end }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    const terminal = findSentenceTerminal(remainder, 0)
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

function findSentenceTerminal(remainder: string, from: number): RegExpExecArray | null {
  const pattern = /(?:\.{3}|[.!?…])([”’"')\]]*)(?=\s|$)/gu
  pattern.lastIndex = from
  let terminal: RegExpExecArray | null
  while ((terminal = pattern.exec(remainder))) {
    const closers = terminal[1] ?? ''
    if (closers && /^\s+\p{Ll}/u.test(remainder.slice((terminal.index ?? 0) + terminal[0].length)))
      continue
    return terminal
  }
  return null
}

export interface TextTargetMatch {
  start: number
  end: number
  paragraphOrdinal: number
}

/**
 * Lists every plausible location for a text target so the caller can offer
 * explicit choices. Exact matches take precedence; otherwise the same guarded
 * fuzzy matcher is applied sentence by sentence, which keeps multiple
 * occurrences inside one paragraph distinct.
 */
export function findTextTargetMatches(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  search: string,
  scope: { paragraphId?: string; paragraphOrdinal?: number } = {},
): TextTargetMatch[] {
  const scoped = paragraphs.filter(
    (paragraph) =>
      (scope.paragraphId === undefined || paragraph.id === scope.paragraphId) &&
      (scope.paragraphOrdinal === undefined || paragraph.ordinal === scope.paragraphOrdinal),
  )
  if (!scoped.length) return []
  const matches: TextTargetMatch[] = []
  for (const paragraph of scoped) {
    const range = paragraphRange(cleanText, paragraph)
    for (const start of findAll(cleanText, search, range.start, range.end))
      matches.push({ start, end: start + search.length, paragraphOrdinal: paragraph.ordinal })
  }
  if (matches.length) return matches
  for (const paragraph of scoped) {
    const range = paragraphRange(cleanText, paragraph)
    for (const sentence of findSentenceRanges(cleanText, range.start, range.end)) {
      const match = findExactOrFuzzyMatch(cleanText, search, sentence.start, sentence.end)
      if (typeof match === 'string') continue
      matches.push({
        start: match.start,
        end: match.end,
        paragraphOrdinal: paragraph.ordinal,
      })
    }
  }
  const unique = new Map<string, TextTargetMatch>()
  for (const match of matches) unique.set(`${match.start}:${match.end}`, match)
  return [...unique.values()].sort((left, right) => left.start - right.start)
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
    const match = findExactOrFuzzyMatch(
      cleanText,
      target.exactText,
      range.start,
      range.end,
      target.occurrence,
    )
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

function formatInsertionCasing(
  text: string,
  point: number,
  insertion: string,
  protectedCasingTerms: readonly string[],
): string {
  if (isSentenceOpeningAt(text, point))
    return capitalizeReplacementAtSentenceOpening(text, point, insertion)
  if (!/[,;:—–-][ \t]*$/u.test(text.slice(0, point))) return insertion
  // Quoted speech can legitimately start a new sentence after a dialogue tag.
  if (/^[ \t]*[“‘"'([{]/u.test(insertion)) return insertion
  const first = insertion.match(/^[ \t]*(\p{Lu}[\p{L}\p{M}'’-]*)/u)?.[1]
  if (!first || first === 'I') return insertion
  const lowered = lowercaseOrdinarySentenceOpening(
    insertion,
    0,
    `${insertion}\n\n${text}`,
    0,
    protectedCasingTerms,
  )
  return lowered ? `${lowered.text}${insertion.slice(lowered.end)}` : insertion
}

function isContinuingInsertion(value: string): boolean {
  return /\p{L}/u.test(value) && !/[.!?…][”’"')\]]*\s*$/u.test(value)
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

  // Only a sentence-like phrase inherits a spurious capital ("My response"). A single
  // capitalized word or a name ("Erica", "Mary Jones") keeps the capital the user gave.
  const sentenceLikeReplacement =
    /^[\s\u201c\u2018"'([{]*\p{Lu}[\p{L}\p{M}'\u2019-]*\s+\p{Ll}/u.test(replacement)
  if (!sentenceLikeReplacement) return replacement

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
  if (word === 'I') return null
  if (looksLikeProperNoun(evidenceText, evidenceStart + prefix.length, word, protectedCasingTerms))
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
  const occurrencePattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapedWord}(?![\\p{L}\\p{N}])`, 'gu')
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
  if (countFloatingQuotationMarks(afterText) > countFloatingQuotationMarks(cleanText))
    return { ok: false, reason: QUOTATION_OUTSIDE_PARAGRAPH_REASON }
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

const QUOTATION_OUTSIDE_PARAGRAPH_REASON = 'quotation mark would fall outside the paragraph'

function countFloatingQuotationMarks(text: string): number {
  let count = 0
  for (const match of text.matchAll(/[“”‘’"]/gu)) {
    const index = match.index
    const before = text[index - 1] ?? ''
    const after = text[index + 1] ?? ''
    if (!/\S/u.test(before) && !/\S/u.test(after)) count += 1
  }
  return count
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

function findLexicallyBoundedExactMatches(
  text: string,
  search: string,
  start: number,
  end: number,
): number[] {
  return findAll(text, search, start, end).filter((index) => {
    const searchStartsLexically = /^[\p{L}\p{M}\p{N}]/u.test(search)
    const searchEndsLexically = /[\p{L}\p{M}\p{N}]$/u.test(search)
    const preceding = index > start ? text[index - 1] : undefined
    const following = index + search.length < end ? text[index + search.length] : undefined
    return (
      (!searchStartsLexically ||
        preceding === undefined ||
        !/[\p{L}\p{M}\p{N}]/u.test(preceding)) &&
      (!searchEndsLexically || following === undefined || !/[\p{L}\p{M}\p{N}]/u.test(following))
    )
  })
}

function findExactOrFuzzyMatch(
  text: string,
  search: string,
  start: number,
  end: number,
  occurrence?: number,
): { start: number; end: number } | string {
  const exactMatches = findLexicallyBoundedExactMatches(text, search, start, end)
  if (occurrence !== undefined) {
    const match = exactMatches[occurrence - 1]
    return match === undefined
      ? 'text target occurrence was not found'
      : { start: match, end: match + search.length }
  }
  if (exactMatches.length > 1) return 'text target is ambiguous'
  if (exactMatches.length === 1)
    return { start: exactMatches[0]!, end: exactMatches[0]! + search.length }

  const lexicalMatch = findPunctuationInsensitiveMatch(text, search, start, end)
  if (typeof lexicalMatch !== 'string') return lexicalMatch
  if (lexicalMatch.includes('ambiguous')) return lexicalMatch

  const possessiveMatch = findSpokenPossessiveMatch(text, search, start, end)
  if (typeof possessiveMatch !== 'string') return possessiveMatch
  if (possessiveMatch.includes('ambiguous')) return possessiveMatch

  const approximate = findApproximateMatch(text, search, start, end)
  if (typeof approximate !== 'string') return approximate
  return approximate.includes('ambiguous')
    ? 'fuzzy text target is ambiguous'
    : 'text target was not found'
}

/** Match a fully spelled possessive as one complete token, never a word prefix. */
function findSpokenPossessiveMatch(
  text: string,
  search: string,
  start: number,
  end: number,
): { start: number; end: number } | string {
  const wanted = tokenizeWithOffsets(search, 0, search.length)
  if (wanted.length !== 1 || wanted[0]!.start !== 0 || wanted[0]!.end !== search.length)
    return 'possessive target was not found'
  const spoken = wanted[0]!.value.replace(/[’']/gu, '')
  const matches = tokenizeCachedDraftRange(text, start, end).filter((token) => {
    const match = token.value.match(/^([\p{L}\p{N}]{2,})['’]s$/u)
    if (!match || CONTRACTIONS[token.value.replace(/’/gu, "'")]) return false
    const stem = match[1]!
    return spoken === `${stem}s` || (/[sxz]$/u.test(stem) && (spoken === `${stem}is` || spoken === `${stem}es`))
  })
  if (matches.length > 1) return 'possessive text target is ambiguous'
  return matches.length === 1
    ? { start: matches[0]!.start, end: matches[0]!.end }
    : 'possessive target was not found'
}

const CONTRACTIONS: Readonly<Record<string, readonly string[]>> = {
  gotta: ['got', 'to'],
  gonna: ['going', 'to'],
  wanna: ['want', 'to'],
  hafta: ['have', 'to'],
  kinda: ['kind', 'of'],
  sorta: ['sort', 'of'],
  lemme: ['let', 'me'],
  "i'm": ['i', 'am'],
  "i've": ['i', 'have'],
  "i'll": ['i', 'will'],
  "i'd": ['i', 'would'],
  "you're": ['you', 'are'],
  "you've": ['you', 'have'],
  "you'll": ['you', 'will'],
  "you'd": ['you', 'would'],
  "he's": ['he', 'is'],
  "she's": ['she', 'is'],
  "it's": ['it', 'is'],
  "we're": ['we', 'are'],
  "we've": ['we', 'have'],
  "we'll": ['we', 'will'],
  "we'd": ['we', 'would'],
  "they're": ['they', 'are'],
  "they've": ['they', 'have'],
  "they'll": ['they', 'will'],
  "they'd": ['they', 'would'],
  "that's": ['that', 'is'],
  "there's": ['there', 'is'],
  "what's": ['what', 'is'],
  "who's": ['who', 'is'],
  "where's": ['where', 'is'],
  "how's": ['how', 'is'],
  "isn't": ['is', 'not'],
  "aren't": ['are', 'not'],
  "wasn't": ['was', 'not'],
  "weren't": ['were', 'not'],
  "don't": ['do', 'not'],
  "doesn't": ['does', 'not'],
  "didn't": ['did', 'not'],
  "can't": ['can', 'not'],
  cannot: ['can', 'not'],
  "couldn't": ['could', 'not'],
  "won't": ['will', 'not'],
  "wouldn't": ['would', 'not'],
  "shouldn't": ['should', 'not'],
  "mustn't": ['must', 'not'],
  "haven't": ['have', 'not'],
  "hasn't": ['has', 'not'],
  "hadn't": ['had', 'not'],
}

interface ExpandedToken {
  value: string
  start: number
  end: number
  partIndex: number
  partCount: number
}

function expandToken(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/\u2019/gu, "'")
  const parts = CONTRACTIONS[normalized]
  return parts ? [...parts] : [stripTokenPunctuation(value)]
}

function expandTokens(tokens: readonly FuzzyToken[]): ExpandedToken[] {
  const expanded: ExpandedToken[] = []
  for (const token of tokens) {
    const parts = expandToken(token.value)
    for (const [partIndex, value] of parts.entries()) {
      expanded.push({
        value,
        start: token.start,
        end: token.end,
        partIndex,
        partCount: parts.length,
      })
    }
  }
  return expanded
}

function findPunctuationInsensitiveMatch(
  text: string,
  search: string,
  start: number,
  end: number,
): { start: number; end: number } | string {
  const wanted = tokenizeWithOffsets(search, 0, search.length)
  if (!wanted.length) return 'punctuation-insensitive text target was not found'
  const available = tokenizeCachedDraftRange(text, start, end)
  const wantedExpanded = expandTokens(wanted)
  const availableExpanded = expandTokens(available)
  if (availableExpanded.length < wantedExpanded.length)
    return 'punctuation-insensitive text target was not found'

  const candidates: Array<{ start: number; end: number; punctuation: string }> = []
  for (let index = 0; index <= availableExpanded.length - wantedExpanded.length; index += 1) {
    const window = availableExpanded.slice(index, index + wantedExpanded.length)
    if (
      window[0]!.partIndex !== 0 ||
      window.at(-1)!.partIndex !== window.at(-1)!.partCount - 1 ||
      !window.every((token, tokenIndex) => token.value === wantedExpanded[tokenIndex]!.value)
    )
      continue
    candidates.push({
      start: window[0]!.start,
      end: window.at(-1)!.end,
      punctuation: internalPunctuationSignature(text, window[0]!.start, window.at(-1)!.end),
    })
  }
  if (candidates.length === 1) return candidates[0]!
  if (!candidates.length) return 'punctuation-insensitive text target was not found'

  const wantedPunctuation = internalPunctuationSignature(
    search,
    wanted[0]!.start,
    wanted.at(-1)!.end,
  )
  const punctuationMatches = candidates.filter(
    (candidate) => candidate.punctuation === wantedPunctuation,
  )
  return punctuationMatches.length === 1
    ? punctuationMatches[0]!
    : 'punctuation-insensitive text target is ambiguous'
}

function stripTokenPunctuation(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '')
}

function internalPunctuationSignature(text: string, start: number, end: number): string {
  return text
    .slice(start, end)
    .replace(/[\p{L}\p{N}\s]/gu, '')
    .replace(/[\u2018\u2019]/gu, '')
    .replace(/[\u201c\u201d]/gu, '"')
}

function findApproximateMatch(
  text: string,
  search: string,
  start: number,
  end: number,
): { start: number; end: number } | string {
  const wanted = tokenizeWithOffsets(search, 0, search.length)
  if (!wanted.length) return 'approximate text target was not found'
  const available = tokenizeCachedDraftRange(text, start, end)
  if (!available.length) return 'approximate text target was not found'
  const wantedText = wanted.map(({ value }) => value).join(' ')
  const wantedCompact = wantedText.replace(/\s+/gu, '')
  const wantedPhonetic = speechPhoneticKey(wantedCompact)
  const availableValues = available.map(({ value }) => value)
  const availableText = availableValues.join(' ')
  const availableCompact = availableValues.join('')
  const spacedOffsets = new Uint32Array(available.length + 1)
  const compactOffsets = new Uint32Array(available.length + 1)
  for (let index = 0; index < available.length; index += 1) {
    spacedOffsets[index + 1] =
      spacedOffsets[index]! + availableValues[index]!.length + (index === 0 ? 0 : 1)
    compactOffsets[index + 1] = compactOffsets[index]! + availableValues[index]!.length
  }
  const scoreCache = new Map<
    string,
    {
      compactScore: number
      text: string
      phonetic: string
      maxScoreUpperBound: number
      score?: number
      phoneticFallback?: boolean
    }
  >()
  const candidates: Array<{
    start: number
    end: number
    order: number
    score?: number
    scores: {
      compactScore: number
      text: string
      phonetic: string
      maxScoreUpperBound: number
      score?: number
      phoneticFallback?: boolean
    }
    boundaryFallback: boolean
    shortWordFallback: boolean
    phoneticFallback: boolean
  }> = []
  const addCandidates = (length: number) => {
    for (let index = 0; index <= available.length - length; index += 1) {
      const windowEnd = index + length
      const spacedStart = spacedOffsets[index]! + (index === 0 ? 0 : 1)
      const spacedEnd = spacedOffsets[windowEnd]!
      const candidateText = availableText.slice(spacedStart, spacedEnd)
      const candidateCompact = availableCompact.slice(
        compactOffsets[index]!,
        compactOffsets[windowEnd]!,
      )
      let scores = scoreCache.get(candidateText)
      if (!scores) {
        const compactScore = stringSimilarity(wantedCompact, candidateCompact)
        const candidatePhonetic = speechPhoneticKey(candidateCompact)
        scores = {
          compactScore,
          text: candidateText,
          phonetic: candidatePhonetic,
          maxScoreUpperBound: Math.max(
            compactScore,
            maximumSimilarityForLengths(wantedText.length, candidateText.length),
            maximumSimilarityForLengths(wantedPhonetic.length, candidatePhonetic.length) * 0.75 +
              compactScore * 0.25,
          ),
        }
        scoreCache.set(candidateText, scores)
      }
      candidates.push({
        start: available[index]!.start,
        end: available[windowEnd - 1]!.end,
        order: candidates.length,
        scores,
        boundaryFallback:
          length !== wanted.length &&
          Math.min(wantedCompact.length, candidateCompact.length) >= 5 &&
          Math.abs(wantedCompact.length - candidateCompact.length) <= 2 &&
          scores.compactScore >= 2 / 3,
        shortWordFallback:
          wanted.length === 1 &&
          length === 1 &&
          Math.min(wantedCompact.length, candidateCompact.length) >= 4 &&
          Math.abs(wantedCompact.length - candidateCompact.length) <= 1 &&
          scores.compactScore >= 0.75 &&
          scores.phonetic === wantedPhonetic,
        phoneticFallback: false,
      })
    }
  }
  addCandidates(wanted.length)
  if (wanted.length > 1) addCandidates(wanted.length - 1)
  addCandidates(wanted.length + 1)
  const evaluationOrder = [...candidates].sort(
    (left, right) =>
      right.scores.compactScore - left.scores.compactScore || left.order - right.order,
  )
  let best: (typeof candidates)[number] | undefined
  for (const candidate of evaluationOrder) {
    if (best?.score !== undefined && candidate.scores.maxScoreUpperBound < best.score - 0.12)
      continue
    if (candidate.scores.score === undefined) {
      const phoneticScore = stringSimilarity(wantedPhonetic, candidate.scores.phonetic)
      const textScore =
        wantedText === wantedCompact &&
        candidate.scores.text === candidate.scores.text.replace(/\s+/gu, '')
          ? candidate.scores.compactScore
          : stringSimilarity(wantedText, candidate.scores.text)
      candidate.scores.score = Math.max(
        textScore,
        candidate.scores.compactScore,
        phoneticScore * 0.75 + candidate.scores.compactScore * 0.25,
      )
      candidate.scores.phoneticFallback =
        Math.min(wantedPhonetic.length, candidate.scores.phonetic.length) >= 4 &&
        wantedPhonetic.charAt(0) === candidate.scores.phonetic.charAt(0) &&
        candidate.scores.compactScore >= 0.5 &&
        phoneticScore >= 0.8
    }
    candidate.score = candidate.scores.score
    candidate.phoneticFallback = candidate.scores.phoneticFallback ?? false
    if (
      candidate.score !== undefined &&
      (!best ||
        best.score === undefined ||
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.order < best.order))
    )
      best = candidate
  }
  if (
    !best ||
    best.score === undefined ||
    (best.score < 0.78 &&
      !best.boundaryFallback &&
      !best.shortWordFallback &&
      !best.phoneticFallback)
  )
    return 'approximate text target was not found'
  let runnerUp: (typeof candidates)[number] | undefined
  for (const candidate of candidates) {
    if (
      candidate.score !== undefined &&
      (candidate.end <= best.start || candidate.start >= best.end) &&
      (!runnerUp || runnerUp.score === undefined || candidate.score > runnerUp.score)
    )
      runnerUp = candidate
  }
  if (runnerUp?.score !== undefined && best.score - runnerUp.score < 0.12)
    return 'approximate text target is ambiguous'
  return { start: best.start, end: best.end }
}

function maximumSimilarityForLengths(leftLength: number, rightLength: number): number {
  return 1 - Math.abs(leftLength - rightLength) / Math.max(leftLength, rightLength, 1)
}

interface FuzzyToken {
  value: string
  start: number
  end: number
}

const MAX_FUZZY_TOKEN_CACHE_ENTRIES = 8
const fuzzyTokenCache = new Map<string, FuzzyToken[]>()

function tokenizeCachedDraftRange(text: string, start: number, end: number): FuzzyToken[] {
  let tokens = fuzzyTokenCache.get(text)
  if (tokens) {
    fuzzyTokenCache.delete(text)
    fuzzyTokenCache.set(text, tokens)
  } else {
    tokens = tokenizeWithOffsets(text, 0, text.length)
    fuzzyTokenCache.set(text, tokens)
    if (fuzzyTokenCache.size > MAX_FUZZY_TOKEN_CACHE_ENTRIES) {
      const oldest = fuzzyTokenCache.keys().next().value
      if (oldest !== undefined) fuzzyTokenCache.delete(oldest)
    }
  }
  if (start === 0 && end === text.length) return tokens
  return tokens.filter((token) => token.start >= start && token.end <= end)
}

function tokenizeWithOffsets(text: string, start: number, end: number): FuzzyToken[] {
  const tokens: FuzzyToken[] = []
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
  if (left === right) return 1
  if (!left.length || !right.length) return 0
  let rows = left
  let columns = right
  if (columns.length > rows.length) [rows, columns] = [columns, rows]
  const distances = new Uint32Array(columns.length + 1)
  for (let column = 0; column <= columns.length; column += 1) distances[column] = column
  for (let row = 1; row <= rows.length; row += 1) {
    let diagonal = distances[0]!
    distances[0] = row
    for (let column = 1; column <= columns.length; column += 1) {
      const above = distances[column]!
      distances[column] = Math.min(
        distances[column - 1]! + 1,
        above + 1,
        diagonal + (rows[row - 1] === columns[column - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return 1 - distances[columns.length]! / Math.max(left.length, right.length, 1)
}

function applyCase(value: string, mode: NonNullable<EditOperation['caseMode']>): string {
  if (mode === 'uppercase') return value.toLocaleUpperCase()
  if (mode === 'lowercase') return value.toLocaleLowerCase()
  return value.replace(/\p{L}[\p{L}\p{M}]*(?:['’]\p{L}+)*/gu, (word) => {
    const index = word.search(/\p{L}/u)
    return index < 0
      ? word
      : `${word.slice(0, index)}${word[index]!.toLocaleUpperCase()}${word.slice(index + 1)}`
  })
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
