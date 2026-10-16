import { MAX_DRAFT_CHARACTERS, type DraftParagraph } from './draft-session'

export const EDIT_SCHEMA_VERSION = 1 as const
export const MAX_EDIT_OPERATIONS = 8
export const MAX_EDIT_TEXT_LENGTH = 10_000

export type EditOperationType =
  'replace' | 'insert_before' | 'insert_after' | 'delete' | 'append' | 'prepend' | 'case'

export interface EditTarget {
  paragraphId?: string
  paragraphOrdinal?: number
  exactText?: string
}

export interface EditOperation {
  id: string
  type: EditOperationType
  target: EditTarget
  text?: string
  caseMode?: 'capitalize' | 'uppercase' | 'lowercase'
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
  const allowedOperationKeys = new Set(['id', 'type', 'target', 'text', 'caseMode'])
  if (Object.keys(value).some((key) => !allowedOperationKeys.has(key))) return null
  const type = value.type
  if (
    type !== 'replace' &&
    type !== 'insert_before' &&
    type !== 'insert_after' &&
    type !== 'delete' &&
    type !== 'append' &&
    type !== 'prepend' &&
    type !== 'case'
  )
    return null
  const target = parseTarget(value.target)
  if (!target) return null
  const text = value.text
  const caseMode = value.caseMode
  if (type === 'case') {
    if (caseMode !== 'capitalize' && caseMode !== 'uppercase' && caseMode !== 'lowercase')
      return null
    if (text !== undefined) return null
  } else if (type === 'delete') {
    if (text !== undefined || caseMode !== undefined) return null
  } else if (
    typeof text !== 'string' ||
    text.length > MAX_EDIT_TEXT_LENGTH ||
    caseMode !== undefined
  ) {
    return null
  }
  return {
    id: value.id,
    type,
    target,
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof caseMode === 'string' ? { caseMode } : {}),
  }
}

function parseTarget(value: Record<string, unknown>): EditTarget | null {
  const allowed = new Set(['paragraphId', 'paragraphOrdinal', 'exactText'])
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
  } else if (!paragraph) {
    return `${operation.type} requires exact text or one paragraph target`
  }
  const isParagraphInsertion =
    paragraph !== undefined &&
    operation.target.exactText === undefined &&
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
