export const DRAFT_SCHEMA_VERSION = 4 as const
export const MAX_DRAFT_CHARACTERS = 100_000
export const MAX_HISTORY_ENTRIES = 200
export const MAX_RECORDING_SEGMENTS = 200

export interface DraftParagraph {
  id: string
  ordinal: number
  lineIndex: number
  text: string
}

export interface DraftDiff {
  removed: string
  added: string
  startOffset: number
  affectedParagraphOrdinals: number[]
}

export interface DraftHistoryEntry {
  id: string
  kind: 'manual-edit' | 'automated-edit' | 'undo' | 'redo' | 'recording-append' | 'recording-undo'
  editGroupId?: string
  beforeVersion: number
  afterVersion: number
  timestamp: string
  diff: DraftDiff
}

export interface AutomatedEditOptions {
  expectedVersion: number
  operationId: string
  now?: string
  createId?: () => string
  paragraphIdOrder?: string[]
}

export interface RecordingSegment {
  id: string
  rawTranscript: string
  normalizedTranscript: string
  normalization: {
    reasons: string[]
    contextMessageCount: number
    contextCharacterCount: number
    contextTruncated: boolean
    contextualModelUsed: boolean
  }
  committedText: string
  startOffset: number
  beforeVersion: number
  resultingVersion: number
  committedAt: string
}

export interface DraftSnapshot {
  chatId: string
  draftVersion: number
  cleanText: string
  paragraphs: DraftParagraph[]
  history: DraftHistoryEntry[]
  latestDiff: DraftDiff | null
  canUndo: boolean
  canRedo: boolean
  recordingSegments: RecordingSegment[]
  canUndoRecording: boolean
  dirty: boolean
  updatedAt: string
}

export interface PersistedDraftSession extends DraftSnapshot {
  schemaVersion: typeof DRAFT_SCHEMA_VERSION
  undoStack: string[]
  redoStack: string[]
}

export interface DraftMutationResult {
  applied: boolean
  reason?: 'stale-version' | 'unchanged' | 'too-large'
  session: PersistedDraftSession
}

export interface DraftMutationOptions {
  expectedVersion: number
  editGroupId: string
  now?: string
  createId?: () => string
}

export function createDraftSession(
  chatId: string,
  now = new Date().toISOString(),
): PersistedDraftSession {
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    chatId,
    draftVersion: 0,
    cleanText: '',
    paragraphs: [],
    history: [],
    latestDiff: null,
    undoStack: [],
    canUndo: false,
    redoStack: [],
    canRedo: false,
    recordingSegments: [],
    canUndoRecording: false,
    dirty: false,
    updatedAt: now,
  }
}

export function applyManualEdit(
  session: PersistedDraftSession,
  nextText: string,
  options: DraftMutationOptions,
): DraftMutationResult {
  if (options.expectedVersion !== session.draftVersion) {
    return { applied: false, reason: 'stale-version', session }
  }
  if (nextText.length > MAX_DRAFT_CHARACTERS) {
    return { applied: false, reason: 'too-large', session }
  }
  if (nextText === session.cleanText) {
    return { applied: false, reason: 'unchanged', session }
  }

  const now = options.now ?? new Date().toISOString()
  const createId = options.createId ?? defaultId
  const beforeText = session.cleanText
  const nextVersion = session.draftVersion + 1
  const diff = createDiff(beforeText, nextText)
  const previousEntry = session.history.at(-1)
  const mergeWithPrevious =
    previousEntry?.kind === 'manual-edit' && previousEntry.editGroupId === options.editGroupId
  const history = mergeWithPrevious
    ? [
        ...session.history.slice(0, -1),
        {
          ...previousEntry,
          afterVersion: nextVersion,
          timestamp: now,
          diff: createDiff(session.undoStack.at(-1) ?? beforeText, nextText),
        },
      ]
    : [
        ...session.history,
        {
          id: createId(),
          kind: 'manual-edit' as const,
          editGroupId: options.editGroupId,
          beforeVersion: session.draftVersion,
          afterVersion: nextVersion,
          timestamp: now,
          diff,
        },
      ].slice(-MAX_HISTORY_ENTRIES)
  const undoStack = mergeWithPrevious
    ? session.undoStack
    : [...session.undoStack, beforeText].slice(-MAX_HISTORY_ENTRIES)

  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: nextText,
      paragraphs: reconcileParagraphs(session.paragraphs, nextText, createId),
      history,
      latestDiff: diff,
      undoStack,
      canUndo: undoStack.length > 0,
      redoStack: [],
      canRedo: false,
      canUndoRecording: canUndoLatestRecording(session, nextText, undoStack),
      dirty: nextText.length > 0,
      updatedAt: now,
    },
  }
}

function hasValidParagraphIdOrder(cleanText: string, ids: string[]): boolean {
  const paragraphCount = cleanText.split('\n').filter(isNonEmptyParagraph).length
  return ids.length === paragraphCount && new Set(ids).size === ids.length && ids.every(Boolean)
}

function paragraphsWithIdOrder(cleanText: string, ids: string[]): DraftParagraph[] {
  const paragraphs: DraftParagraph[] = []
  for (const [lineIndex, text] of cleanText.split('\n').entries()) {
    if (!isNonEmptyParagraph(text)) continue
    paragraphs.push({
      id: ids[paragraphs.length]!,
      ordinal: paragraphs.length + 1,
      lineIndex,
      text,
    })
  }
  return paragraphs
}

export function applyAutomatedEdit(
  session: PersistedDraftSession,
  nextText: string,
  options: AutomatedEditOptions,
): DraftMutationResult {
  if (options.expectedVersion !== session.draftVersion) {
    return { applied: false, reason: 'stale-version', session }
  }
  if (nextText.length > MAX_DRAFT_CHARACTERS) {
    return { applied: false, reason: 'too-large', session }
  }
  if (nextText === session.cleanText) {
    return { applied: false, reason: 'unchanged', session }
  }

  const now = options.now ?? new Date().toISOString()
  const createId = options.createId ?? defaultId
  const beforeText = session.cleanText
  const nextVersion = session.draftVersion + 1
  const diff = createDiff(beforeText, nextText)
  const undoStack = [...session.undoStack, beforeText].slice(-MAX_HISTORY_ENTRIES)
  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: nextText,
      paragraphs:
        options.paragraphIdOrder && hasValidParagraphIdOrder(nextText, options.paragraphIdOrder)
          ? paragraphsWithIdOrder(nextText, options.paragraphIdOrder)
          : reconcileParagraphs(session.paragraphs, nextText, createId),
      history: [
        ...session.history,
        {
          id: options.operationId,
          kind: 'automated-edit' as const,
          beforeVersion: session.draftVersion,
          afterVersion: nextVersion,
          timestamp: now,
          diff,
        },
      ].slice(-MAX_HISTORY_ENTRIES),
      latestDiff: diff,
      undoStack,
      canUndo: true,
      redoStack: [],
      canRedo: false,
      canUndoRecording: false,
      dirty: nextText.length > 0,
      updatedAt: now,
    },
  }
}

export function undoLatestDraftMutation(
  session: PersistedDraftSession,
  expectedVersion: number,
  now = new Date().toISOString(),
  createId: () => string = defaultId,
): DraftMutationResult {
  if (expectedVersion !== session.draftVersion) {
    return { applied: false, reason: 'stale-version', session }
  }
  const previousText = session.undoStack.at(-1)
  if (previousText === undefined) return { applied: false, reason: 'unchanged', session }

  const nextVersion = session.draftVersion + 1
  const diff = createDiff(session.cleanText, previousText)
  const lastHistory = session.history.at(-1)
  const recordingSegments =
    lastHistory?.kind === 'recording-append'
      ? session.recordingSegments.slice(0, -1)
      : session.recordingSegments
  const undoStack = session.undoStack.slice(0, -1)
  const redoStack = [...session.redoStack, session.cleanText].slice(-MAX_HISTORY_ENTRIES)
  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: previousText,
      paragraphs: reconcileParagraphs(session.paragraphs, previousText, createId),
      history: [
        ...session.history,
        {
          id: createId(),
          kind: 'undo' as const,
          beforeVersion: session.draftVersion,
          afterVersion: nextVersion,
          timestamp: now,
          diff,
        },
      ].slice(-MAX_HISTORY_ENTRIES),
      latestDiff: diff,
      undoStack,
      canUndo: undoStack.length > 0,
      redoStack,
      canRedo: true,
      recordingSegments,
      canUndoRecording: canUndoLatestRecording(
        { ...session, recordingSegments },
        previousText,
        undoStack,
      ),
      dirty: previousText.length > 0,
      updatedAt: now,
    },
  }
}

export function redoLatestDraftMutation(
  session: PersistedDraftSession,
  expectedVersion: number,
  now = new Date().toISOString(),
  createId: () => string = defaultId,
): DraftMutationResult {
  if (expectedVersion !== session.draftVersion) {
    return { applied: false, reason: 'stale-version', session }
  }
  const nextText = session.redoStack.at(-1)
  if (nextText === undefined) return { applied: false, reason: 'unchanged', session }

  const nextVersion = session.draftVersion + 1
  const diff = createDiff(session.cleanText, nextText)
  const undoStack = [...session.undoStack, session.cleanText].slice(-MAX_HISTORY_ENTRIES)
  const redoStack = session.redoStack.slice(0, -1)
  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: nextText,
      paragraphs: reconcileParagraphs(session.paragraphs, nextText, createId),
      history: [
        ...session.history,
        {
          id: createId(),
          kind: 'redo' as const,
          beforeVersion: session.draftVersion,
          afterVersion: nextVersion,
          timestamp: now,
          diff,
        },
      ].slice(-MAX_HISTORY_ENTRIES),
      latestDiff: diff,
      undoStack,
      canUndo: true,
      redoStack,
      canRedo: redoStack.length > 0,
      canUndoRecording: false,
      dirty: nextText.length > 0,
      updatedAt: now,
    },
  }
}

export function clearDraftAfterSend(
  session: PersistedDraftSession,
  now = new Date().toISOString(),
): PersistedDraftSession {
  return createDraftSession(session.chatId, now)
}

export function toDraftSnapshot(session: PersistedDraftSession): DraftSnapshot {
  return {
    chatId: session.chatId,
    draftVersion: session.draftVersion,
    cleanText: session.cleanText,
    paragraphs: session.paragraphs,
    history: session.history,
    latestDiff: session.latestDiff,
    canUndo: session.canUndo,
    canRedo: session.canRedo,
    recordingSegments: session.recordingSegments,
    canUndoRecording: session.canUndoRecording,
    dirty: session.dirty,
    updatedAt: session.updatedAt,
  }
}

export interface RecordingMutationOptions {
  expectedVersion: number
  segmentId: string
  committedTranscript?: string
  normalization?: RecordingSegment['normalization']
  now?: string
  createId?: () => string
}

export function appendRecordingTranscript(
  session: PersistedDraftSession,
  rawTranscript: string,
  options: RecordingMutationOptions,
): DraftMutationResult {
  if (session.recordingSegments.some((segment) => segment.id === options.segmentId)) {
    return { applied: false, reason: 'unchanged', session }
  }
  if (options.expectedVersion !== session.draftVersion) {
    return { applied: false, reason: 'stale-version', session }
  }
  if (rawTranscript.trim().length === 0) {
    return { applied: false, reason: 'unchanged', session }
  }

  const normalizedTranscript = options.committedTranscript ?? rawTranscript
  if (normalizedTranscript.trim().length === 0)
    return { applied: false, reason: 'unchanged', session }
  const nextText = joinRecordingTranscript(session.cleanText, normalizedTranscript)
  if (nextText.length > MAX_DRAFT_CHARACTERS) {
    return { applied: false, reason: 'too-large', session }
  }

  const now = options.now ?? new Date().toISOString()
  const createId = options.createId ?? defaultId
  const nextVersion = session.draftVersion + 1
  const diff = createDiff(session.cleanText, nextText)
  const committedText = nextText.slice(session.cleanText.length)
  const recordingSegments = [
    ...session.recordingSegments,
    {
      id: options.segmentId,
      rawTranscript,
      normalizedTranscript,
      normalization: options.normalization ?? {
        reasons: [],
        contextMessageCount: 0,
        contextCharacterCount: 0,
        contextTruncated: false,
        contextualModelUsed: false,
      },
      committedText,
      startOffset: session.cleanText.length,
      beforeVersion: session.draftVersion,
      resultingVersion: nextVersion,
      committedAt: now,
    },
  ].slice(-MAX_RECORDING_SEGMENTS)
  const undoStack = [...session.undoStack, session.cleanText].slice(-MAX_HISTORY_ENTRIES)

  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: nextText,
      paragraphs: reconcileParagraphs(session.paragraphs, nextText, createId),
      history: [
        ...session.history,
        {
          id: createId(),
          kind: 'recording-append' as const,
          beforeVersion: session.draftVersion,
          afterVersion: nextVersion,
          timestamp: now,
          diff,
        },
      ].slice(-MAX_HISTORY_ENTRIES),
      latestDiff: diff,
      undoStack,
      canUndo: true,
      redoStack: [],
      canRedo: false,
      recordingSegments,
      canUndoRecording: true,
      dirty: true,
      updatedAt: now,
    },
  }
}

export function undoLastRecording(
  session: PersistedDraftSession,
  expectedVersion: number,
  now = new Date().toISOString(),
  createId: () => string = defaultId,
): DraftMutationResult {
  if (expectedVersion !== session.draftVersion) {
    return { applied: false, reason: 'stale-version', session }
  }
  if (!session.canUndoRecording) return { applied: false, reason: 'unchanged', session }
  const segment = session.recordingSegments.at(-1)
  if (!segment) return { applied: false, reason: 'unchanged', session }

  const nextText = session.cleanText.slice(0, segment.startOffset)
  const nextVersion = session.draftVersion + 1
  const diff = createDiff(session.cleanText, nextText)
  const recordingSegments = session.recordingSegments.slice(0, -1)
  const undoStack = session.undoStack.slice(0, -1)
  const redoStack = [...session.redoStack, session.cleanText].slice(-MAX_HISTORY_ENTRIES)
  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: nextText,
      paragraphs: reconcileParagraphs(session.paragraphs, nextText, createId),
      history: [
        ...session.history,
        {
          id: createId(),
          kind: 'recording-undo' as const,
          beforeVersion: session.draftVersion,
          afterVersion: nextVersion,
          timestamp: now,
          diff,
        },
      ].slice(-MAX_HISTORY_ENTRIES),
      latestDiff: diff,
      undoStack,
      canUndo: undoStack.length > 0,
      redoStack,
      canRedo: true,
      recordingSegments,
      canUndoRecording: canUndoLatestRecording(
        { ...session, recordingSegments },
        nextText,
        undoStack,
      ),
      dirty: nextText.length > 0,
      updatedAt: now,
    },
  }
}

export function joinRecordingTranscript(existing: string, transcript: string): string {
  if (existing.length === 0) return transcript
  if (transcript.length === 0) return existing

  const existingEndsWithLineBreak = /[\r\n]$/.test(existing)
  const transcriptStartsWithLineBreak = /^[\r\n]/.test(transcript)
  if (existingEndsWithLineBreak || transcriptStartsWithLineBreak) return existing + transcript

  const trailingHorizontal = existing.match(/[\t ]+$/)?.[0] ?? ''
  const leadingHorizontal = transcript.match(/^[\t ]+/)?.[0] ?? ''
  if (trailingHorizontal && leadingHorizontal) {
    return existing + transcript.slice(leadingHorizontal.length)
  }
  if (trailingHorizontal || leadingHorizontal) return existing + transcript
  return `${existing} ${transcript}`
}

export function isPersistedDraftSession(
  value: unknown,
  expectedChatId: string,
): value is PersistedDraftSession {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === DRAFT_SCHEMA_VERSION &&
    value.chatId === expectedChatId &&
    isNonNegativeInteger(value.draftVersion) &&
    typeof value.cleanText === 'string' &&
    value.cleanText.length <= MAX_DRAFT_CHARACTERS &&
    Array.isArray(value.paragraphs) &&
    value.paragraphs.every(isDraftParagraph) &&
    Array.isArray(value.history) &&
    value.history.length <= MAX_HISTORY_ENTRIES &&
    value.history.every(isHistoryEntry) &&
    (value.latestDiff === null || isDraftDiff(value.latestDiff)) &&
    Array.isArray(value.undoStack) &&
    value.undoStack.length <= MAX_HISTORY_ENTRIES &&
    value.undoStack.every(
      (text) => typeof text === 'string' && text.length <= MAX_DRAFT_CHARACTERS,
    ) &&
    typeof value.canUndo === 'boolean' &&
    value.canUndo === value.undoStack.length > 0 &&
    Array.isArray(value.redoStack) &&
    value.redoStack.length <= MAX_HISTORY_ENTRIES &&
    value.redoStack.every(
      (text) => typeof text === 'string' && text.length <= MAX_DRAFT_CHARACTERS,
    ) &&
    typeof value.canRedo === 'boolean' &&
    value.canRedo === value.redoStack.length > 0 &&
    Array.isArray(value.recordingSegments) &&
    value.recordingSegments.length <= MAX_RECORDING_SEGMENTS &&
    value.recordingSegments.every(isRecordingSegment) &&
    typeof value.canUndoRecording === 'boolean' &&
    value.canUndoRecording ===
      canUndoLatestRecording(
        value as unknown as PersistedDraftSession,
        value.cleanText,
        value.undoStack,
      ) &&
    typeof value.dirty === 'boolean' &&
    typeof value.updatedAt === 'string'
  )
}

export function restoreDraftSession(
  value: unknown,
  expectedChatId: string,
): PersistedDraftSession | null {
  if (isPersistedDraftSession(value, expectedChatId)) return value
  if (isSchemaThreeDraftSession(value, expectedChatId)) {
    return {
      ...value,
      schemaVersion: DRAFT_SCHEMA_VERSION,
      redoStack: [],
      canRedo: false,
    }
  }
  if (isSchemaTwoDraftSession(value, expectedChatId)) {
    return {
      ...value,
      schemaVersion: DRAFT_SCHEMA_VERSION,
      redoStack: [],
      canRedo: false,
      recordingSegments: value.recordingSegments.map((segment) => ({
        ...segment,
        normalizedTranscript: segment.rawTranscript,
        normalization: {
          reasons: [],
          contextMessageCount: 0,
          contextCharacterCount: 0,
          contextTruncated: false,
          contextualModelUsed: false,
        },
      })),
    }
  }
  if (!isLegacyDraftSession(value, expectedChatId)) return null
  return {
    ...value,
    schemaVersion: DRAFT_SCHEMA_VERSION,
    redoStack: [],
    canRedo: false,
    recordingSegments: [],
    canUndoRecording: false,
  }
}

export function createDiff(before: string, after: string): DraftDiff {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)
  const beforeStart = paragraphOrdinalAtOffset(before, prefix)
  const afterStart = paragraphOrdinalAtOffset(after, prefix)
  return {
    removed,
    added,
    startOffset: prefix,
    affectedParagraphOrdinals: [...new Set([beforeStart, afterStart].filter(isPositiveInteger))],
  }
}

export function reconcileParagraphs(
  previous: DraftParagraph[],
  cleanText: string,
  createId: () => string,
): DraftParagraph[] {
  const nextLines = cleanText.split('\n')
  const nextTexts = nextLines.filter(isNonEmptyParagraph)
  const matches = longestCommonSubsequenceMatches(
    previous.map((paragraph) => paragraph.text),
    nextTexts,
  )
  const ids = new Array<string | undefined>(nextTexts.length)
  for (const [previousIndex, nextIndex] of matches) ids[nextIndex] = previous[previousIndex]?.id

  const anchors = [[-1, -1], ...matches, [previous.length, nextTexts.length]] as Array<
    [number, number]
  >
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const [previousStart, nextStart] = anchors[anchorIndex]!
    const [previousEnd, nextEnd] = anchors[anchorIndex + 1]!
    const pairCount = Math.min(previousEnd - previousStart - 1, nextEnd - nextStart - 1)
    for (let offset = 1; offset <= pairCount; offset += 1) {
      ids[nextStart + offset] = previous[previousStart + offset]?.id
    }
  }

  let paragraphIndex = 0
  const paragraphs: DraftParagraph[] = []
  for (const [lineIndex, text] of nextLines.entries()) {
    if (!isNonEmptyParagraph(text)) continue
    paragraphs.push({
      id: ids[paragraphIndex] ?? createId(),
      ordinal: paragraphIndex + 1,
      lineIndex,
      text,
    })
    paragraphIndex += 1
  }
  return paragraphs
}

function longestCommonSubsequenceMatches(left: string[], right: string[]): Array<[number, number]> {
  const table = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  )
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex]![rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? 1 + table[leftIndex + 1]![rightIndex + 1]!
          : Math.max(table[leftIndex + 1]![rightIndex]!, table[leftIndex]![rightIndex + 1]!)
    }
  }

  const matches: Array<[number, number]> = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      matches.push([leftIndex, rightIndex])
      leftIndex += 1
      rightIndex += 1
    } else if (table[leftIndex + 1]![rightIndex]! >= table[leftIndex]![rightIndex + 1]!) {
      leftIndex += 1
    } else {
      rightIndex += 1
    }
  }
  return matches
}

function paragraphOrdinalAtOffset(text: string, offset: number): number | null {
  const lines = text.slice(0, offset).split('\n')
  let ordinal = 0
  for (const line of lines) if (isNonEmptyParagraph(line)) ordinal += 1
  return ordinal || (text.length > 0 ? 1 : null)
}

function isDraftParagraph(value: unknown): value is DraftParagraph {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    isPositiveInteger(value.ordinal) &&
    isNonNegativeInteger(value.lineIndex) &&
    typeof value.text === 'string' &&
    isNonEmptyParagraph(value.text)
  )
}

function isHistoryEntry(value: unknown): value is DraftHistoryEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.kind === 'manual-edit' ||
      value.kind === 'automated-edit' ||
      value.kind === 'undo' ||
      value.kind === 'redo' ||
      value.kind === 'recording-append' ||
      value.kind === 'recording-undo') &&
    (value.editGroupId === undefined || typeof value.editGroupId === 'string') &&
    isNonNegativeInteger(value.beforeVersion) &&
    isPositiveInteger(value.afterVersion) &&
    typeof value.timestamp === 'string' &&
    isDraftDiff(value.diff)
  )
}

function isRecordingSegment(value: unknown): value is RecordingSegment {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.rawTranscript === 'string' &&
    value.rawTranscript.trim().length > 0 &&
    typeof value.normalizedTranscript === 'string' &&
    value.normalizedTranscript.trim().length > 0 &&
    isRecordingNormalization(value.normalization) &&
    typeof value.committedText === 'string' &&
    value.committedText.length > 0 &&
    isNonNegativeInteger(value.startOffset) &&
    isNonNegativeInteger(value.beforeVersion) &&
    isPositiveInteger(value.resultingVersion) &&
    value.resultingVersion === value.beforeVersion + 1 &&
    typeof value.committedAt === 'string'
  )
}

function isRecordingNormalization(value: unknown): value is RecordingSegment['normalization'] {
  return (
    isRecord(value) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string') &&
    isNonNegativeInteger(value.contextMessageCount) &&
    isNonNegativeInteger(value.contextCharacterCount) &&
    typeof value.contextTruncated === 'boolean' &&
    typeof value.contextualModelUsed === 'boolean'
  )
}

function isSchemaThreeDraftSession(
  value: unknown,
  expectedChatId: string,
): value is Omit<PersistedDraftSession, 'schemaVersion' | 'redoStack' | 'canRedo'> & {
  schemaVersion: 3
} {
  if (!isRecord(value) || value.schemaVersion !== 3 || value.chatId !== expectedChatId) {
    return false
  }
  return isPersistedDraftSession(
    { ...value, schemaVersion: DRAFT_SCHEMA_VERSION, redoStack: [], canRedo: false },
    expectedChatId,
  )
}

function isSchemaTwoDraftSession(
  value: unknown,
  expectedChatId: string,
): value is Omit<
  PersistedDraftSession,
  'schemaVersion' | 'recordingSegments' | 'redoStack' | 'canRedo'
> & {
  schemaVersion: 2
  recordingSegments: Array<Omit<RecordingSegment, 'normalizedTranscript' | 'normalization'>>
} {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.chatId !== expectedChatId ||
    !Array.isArray(value.recordingSegments)
  )
    return false
  const candidate = {
    ...value,
    schemaVersion: DRAFT_SCHEMA_VERSION,
    redoStack: [],
    canRedo: false,
    recordingSegments: value.recordingSegments.map((segment) =>
      isRecord(segment)
        ? {
            ...segment,
            normalizedTranscript: segment.rawTranscript,
            normalization: {
              reasons: [],
              contextMessageCount: 0,
              contextCharacterCount: 0,
              contextTruncated: false,
              contextualModelUsed: false,
            },
          }
        : segment,
    ),
  }
  return isPersistedDraftSession(candidate, expectedChatId)
}

function isLegacyDraftSession(
  value: unknown,
  expectedChatId: string,
): value is Omit<
  PersistedDraftSession,
  'schemaVersion' | 'recordingSegments' | 'canUndoRecording' | 'redoStack' | 'canRedo'
> & {
  schemaVersion: 1
} {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 1 &&
    value.chatId === expectedChatId &&
    isNonNegativeInteger(value.draftVersion) &&
    typeof value.cleanText === 'string' &&
    value.cleanText.length <= MAX_DRAFT_CHARACTERS &&
    Array.isArray(value.paragraphs) &&
    value.paragraphs.every(isDraftParagraph) &&
    Array.isArray(value.history) &&
    value.history.length <= MAX_HISTORY_ENTRIES &&
    value.history.every(
      (entry) =>
        isRecord(entry) &&
        (entry.kind === 'manual-edit' || entry.kind === 'undo') &&
        isHistoryEntry(entry),
    ) &&
    (value.latestDiff === null || isDraftDiff(value.latestDiff)) &&
    Array.isArray(value.undoStack) &&
    value.undoStack.length <= MAX_HISTORY_ENTRIES &&
    value.undoStack.every(
      (text) => typeof text === 'string' && text.length <= MAX_DRAFT_CHARACTERS,
    ) &&
    typeof value.canUndo === 'boolean' &&
    value.canUndo === value.undoStack.length > 0 &&
    typeof value.dirty === 'boolean' &&
    typeof value.updatedAt === 'string'
  )
}

function canUndoLatestRecording(
  session: Pick<PersistedDraftSession, 'recordingSegments'>,
  cleanText: string,
  undoStack: string[],
): boolean {
  const segment = session.recordingSegments.at(-1)
  if (!segment) return false
  const beforeText = cleanText.slice(0, segment.startOffset)
  return (
    segment.startOffset + segment.committedText.length === cleanText.length &&
    cleanText.slice(segment.startOffset) === segment.committedText &&
    undoStack.at(-1) === beforeText
  )
}

function isDraftDiff(value: unknown): value is DraftDiff {
  if (!isRecord(value)) return false
  return (
    typeof value.removed === 'string' &&
    typeof value.added === 'string' &&
    isNonNegativeInteger(value.startOffset) &&
    Array.isArray(value.affectedParagraphOrdinals) &&
    value.affectedParagraphOrdinals.every(isPositiveInteger)
  )
}

function isNonEmptyParagraph(text: string): boolean {
  return text.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function defaultId(): string {
  return crypto.randomUUID()
}
