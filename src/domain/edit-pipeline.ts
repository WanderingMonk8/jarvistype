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

export interface EditTarget {
  paragraphId?: string
  paragraphOrdinal?: number
  exactText?: string
  approximateText?: string
  scope?: 'draft'
}

export interface EditOperation {
  id: string
  type: EditOperationType
  target: EditTarget
  text?: string
  caseMode?: 'capitalize' | 'uppercase' | 'lowercase'
  destination?: EditTarget
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
): EditPipelineResult {
  if (plan.draftVersion !== currentVersion) return { ok: false, reason: 'stale draft version' }
  const inlineMoves = plan.operations.filter(isInlineMoveOperation)
  if (inlineMoves.length) {
    if (inlineMoves.length !== plan.operations.length || inlineMoves.length > 1)
      return { ok: false, reason: 'an inline move must be the only operation in its edit plan' }
    return executeInlineMove(cleanText, paragraphs, inlineMoves[0]!)
  }
  const structural = plan.operations.filter(isStructuralOperation)
  if (structural.length) {
    if (structural.length !== plan.operations.length)
      return { ok: false, reason: 'structural and inline operations cannot be mixed' }
    return executeStructuralPlan(cleanText, paragraphs, structural)
  }
  const patches: Patch[] = []
  for (const operation of plan.operations) {
    const patch = resolveOperation(cleanText, paragraphs, operation)
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
  const allowedOperationKeys = new Set(['id', 'type', 'target', 'text', 'caseMode', 'destination'])
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
    if (text !== undefined || destination !== undefined) return null
  } else if (type === 'delete' || type === 'split' || type === 'join_next') {
    if (text !== undefined || caseMode !== undefined) return null
    if (destination !== undefined) return null
    if (
      type === 'join_next' &&
      (target.exactText !== undefined ||
        target.approximateText !== undefined ||
        target.scope !== undefined)
    )
      return null
  } else if (type === 'move_before' || type === 'move_after') {
    if (text !== undefined || caseMode !== undefined || !destination) return null
    if (target.scope !== undefined || destination.scope !== undefined) return null
    const sourceIsText = hasTextSelector(target)
    const destinationIsText = hasTextSelector(destination)
    if (sourceIsText !== destinationIsText) return null
  } else if (
    typeof text !== 'string' ||
    text.length > MAX_EDIT_TEXT_LENGTH ||
    caseMode !== undefined ||
    destination !== undefined
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
  }
}

function parseTarget(value: Record<string, unknown>): EditTarget | null {
  const allowed = new Set([
    'paragraphId',
    'paragraphOrdinal',
    'exactText',
    'approximateText',
    'scope',
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
  return Object.keys(target).length ? target : null
}

function resolveOperation(
  cleanText: string,
  paragraphs: readonly DraftParagraph[],
  operation: EditOperation,
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
    return {
      operation,
      start: point,
      end: point,
      replacement: operation.text ?? '',
      paragraphOrdinal: paragraph.ordinal,
    }
  }

  let start = range.start
  let end = range.end
  if (operation.target.exactText !== undefined) {
    const matches = findAll(cleanText, operation.target.exactText, range.start, range.end)
    if (matches.length !== 1)
      return matches.length ? 'text target is ambiguous' : 'text target was not found'
    start = matches[0]!
    end = start + operation.target.exactText.length
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
    (operation.type === 'insert_before' || operation.type === 'insert_after')
  if (isParagraphInsertion) {
    const insertedParagraph = (operation.text ?? '').trim()
    if (!insertedParagraph) return 'paragraph insertion text is empty'
    const point = operation.type === 'insert_before' ? range.start : range.end
    return {
      operation,
      start: point,
      end: point,
      replacement:
        operation.type === 'insert_before'
          ? `${insertedParagraph}\n\n`
          : `\n\n${insertedParagraph}`,
      paragraphOrdinal: paragraph.ordinal,
    }
  }
  if (operation.type === 'delete') {
    const hasSeparatorBefore = start > range.start && /[ \t]/.test(cleanText[start - 1] ?? '')
    const hasSeparatorAfter = end < range.end && /[ \t]/.test(cleanText[end] ?? '')
    if (hasSeparatorBefore && (hasSeparatorAfter || end === range.end)) start -= 1
    else if (hasSeparatorAfter && start === range.start) end += 1
  }
  const adjustedBefore = cleanText.slice(start, end)
  const replacement =
    operation.type === 'replace'
      ? (operation.text ?? '')
      : operation.type === 'delete'
        ? ''
        : operation.type === 'insert_before'
          ? (operation.text ?? '')
          : operation.type === 'insert_after'
            ? `${adjustedBefore}${operation.text ?? ''}`
            : applyCase(adjustedBefore, operation.caseMode!)
  if (operation.type === 'insert_before') end = start
  return {
    operation,
    start,
    end,
    replacement,
    paragraphOrdinal: paragraph?.ordinal ?? paragraphOrdinalAtOffset(cleanText, start),
  }
}

type StructuralEditOperation = EditOperation & {
  type: 'split' | 'join_next' | 'move_before' | 'move_after'
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
    hasTextSelector(operation.target) &&
    hasTextSelector(operation.destination)
  )
}

function hasTextSelector(target: EditTarget): boolean {
  return target.exactText !== undefined || target.approximateText !== undefined
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
  if (source.start < destination.end && destination.start < source.end)
    return { ok: false, reason: 'move source and destination overlap' }

  const movedText = cleanText.slice(source.start, source.end)
  let removalStart = source.start
  let removalEnd = source.end
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

  const withoutSource = `${cleanText.slice(0, removalStart)}${cleanText.slice(removalEnd)}`
  const originalInsertionPoint =
    operation.type === 'move_before' ? destination.start : destination.end
  const insertionPoint =
    originalInsertionPoint > removalStart
      ? originalInsertionPoint - (removalEnd - removalStart)
      : originalInsertionPoint
  const insertion = addBoundarySpacing(withoutSource, insertionPoint, movedText)
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
        endOffset: source.end,
        beforeText: movedText,
        afterText: movedText,
        paragraphOrdinal: source.paragraphOrdinal,
      },
    ],
    affectedParagraphOrdinals: [
      ...new Set([source.paragraphOrdinal, destination.paragraphOrdinal]),
    ].sort((left, right) => left - right),
  }
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
  if (target.exactText !== undefined) {
    const matches = findAll(cleanText, target.exactText, range.start, range.end)
    if (matches.length !== 1)
      return matches.length ? `${label} is ambiguous` : `${label} was not found`
    start = matches[0]!
    end = start + target.exactText.length
  } else if (target.approximateText !== undefined) {
    const match = findApproximateMatch(cleanText, target.approximateText, range.start, range.end)
    if (typeof match === 'string') return `${label}: ${match}`
    start = match.start
    end = match.end
  } else {
    return `${label} requires exact or approximate text`
  }

  return {
    start,
    end,
    paragraphOrdinal: paragraph?.ordinal ?? paragraphOrdinalAtOffset(cleanText, start),
    scopeStart: range.start,
    scopeEnd: range.end,
  }
}

function addBoundarySpacing(text: string, point: number, insertion: string): string {
  let result = insertion
  const left = text[point - 1] ?? ''
  const right = text[point] ?? ''
  if (left && !/\s/.test(left) && !/[([{“‘]/.test(left) && !/^[,.;:!?)}\]”’]/.test(result))
    result = ` ${result}`
  if (right && !/\s/.test(right) && !/^[,.;:!?)}\]”’]/.test(right) && !/[([{“‘]$/.test(result))
    result = `${result} `
  return result
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

    if (operation.type === 'split') {
      const anchor = operation.target.exactText
      if (!anchor) return { ok: false, reason: 'split requires an exact anchor' }
      const matches = findAll(sourceResult.text, anchor, 0, sourceResult.text.length)
      if (matches.length !== 1)
        return {
          ok: false,
          reason: matches.length ? 'split anchor is ambiguous' : 'split anchor was not found',
        }
      const splitAt = matches[0]! + anchor.length
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

function findApproximateMatch(
  text: string,
  search: string,
  start: number,
  end: number,
): { start: number; end: number } | string {
  const wanted = tokenizeWithOffsets(search, 0, search.length)
  if (!wanted.length) return 'approximate text target was not found'
  const available = tokenizeWithOffsets(text, start, end)
  if (available.length < wanted.length) return 'approximate text target was not found'
  const wantedText = wanted.map(({ value }) => value).join(' ')
  const candidates: Array<{ start: number; end: number; score: number }> = []
  for (let index = 0; index <= available.length - wanted.length; index += 1) {
    const window = available.slice(index, index + wanted.length)
    const candidateText = window.map(({ value }) => value).join(' ')
    candidates.push({
      start: window[0]!.start,
      end: window.at(-1)!.end,
      score: stringSimilarity(wantedText, candidateText),
    })
  }
  candidates.sort((left, right) => right.score - left.score)
  const best = candidates[0]
  if (!best || best.score < 0.78) return 'approximate text target was not found'
  const runnerUp = candidates[1]
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
