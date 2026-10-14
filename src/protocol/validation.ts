import {
  MAX_DRAFT_CHARACTERS,
  MAX_HISTORY_ENTRIES,
  MAX_RECORDING_SEGMENTS,
  type DraftSnapshot,
} from '../domain/draft-session'
import {
  PHASE_THREE_PERMISSIONS,
  PROTOCOL_VERSION,
  type AppErrorCode,
  type BackendResponse,
  type FrontendRequest,
  type PermissionSnapshot,
} from './messages'

const ERROR_CODES: readonly AppErrorCode[] = [
  'MALFORMED_REQUEST',
  'BACKEND_UNAVAILABLE',
  'REQUEST_CANCELLED',
  'INTERNAL_ERROR',
  'DRAFT_TOO_LARGE',
  'DRAFT_EMPTY',
  'DRAFT_PERSIST_FAILED',
  'TRANSCRIPT_EMPTY',
  'RECORDING_UNDO_CONFLICT',
  'CHAT_MISMATCH',
  'PERMISSION_DENIED',
  'SEND_FAILED',
]

export function isFrontendRequest(value: unknown): value is FrontendRequest {
  if (!hasEnvelope(value)) return false

  if (value.type === 'app.health.request') {
    return (
      isBoundedString(value.clientTimestamp, 1, 128) &&
      (value.activeChatId === null || isIdentifier(value.activeChatId))
    )
  }
  if (value.type === 'app.operation.cancel') return isIdentifier(value.targetRequestId)
  if (value.type === 'draft.load.request') return isIdentifier(value.chatId)
  if (value.type === 'draft.mutate.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion) &&
      isIdentifier(value.editGroupId) &&
      typeof value.cleanText === 'string' &&
      value.cleanText.length <= MAX_DRAFT_CHARACTERS
    )
  }
  if (value.type === 'draft.undo.request' || value.type === 'draft.send.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion)
    )
  }
  if (value.type === 'draft.recording.append.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion) &&
      isBoundedString(value.rawTranscript, 1, MAX_DRAFT_CHARACTERS)
    )
  }
  if (value.type === 'draft.recording.undo.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion)
    )
  }
  return false
}

export function isBackendResponse(value: unknown): value is BackendResponse {
  if (!hasEnvelope(value) || typeof value.ok !== 'boolean') return false

  if (value.type === 'app.health.response') {
    return (
      value.ok === true &&
      isBoundedString(value.backendVersion, 1, 128) &&
      isBoundedString(value.frontendVersion, 1, 128) &&
      isBoundedString(value.serverTimestamp, 1, 128) &&
      isPermissionSnapshot(value.permissions)
    )
  }
  if (value.type === 'app.operation.cancelled') {
    return (
      value.ok === true &&
      isIdentifier(value.targetRequestId) &&
      typeof value.cancellationAccepted === 'boolean'
    )
  }
  if (value.type === 'draft.snapshot.response') {
    return (
      value.ok === true &&
      (value.outcome === 'loaded' ||
        value.outcome === 'applied' ||
        value.outcome === 'unchanged' ||
        value.outcome === 'stale-version') &&
      (value.operationId === undefined || isIdentifier(value.operationId)) &&
      isDraftSnapshot(value.snapshot)
    )
  }
  if (value.type === 'draft.send.response') {
    return (
      value.ok === true &&
      isIdentifier(value.operationId) &&
      value.messageIdPresent === true &&
      typeof value.generationIdPresent === 'boolean' &&
      isDraftSnapshot(value.snapshot)
    )
  }
  if (value.type === 'app.error') {
    return (
      value.ok === false &&
      typeof value.code === 'string' &&
      ERROR_CODES.includes(value.code as AppErrorCode) &&
      isBoundedString(value.message, 1, 2_000) &&
      typeof value.retryable === 'boolean' &&
      (value.operationId === undefined || isIdentifier(value.operationId)) &&
      (value.snapshot === undefined || isDraftSnapshot(value.snapshot))
    )
  }
  return false
}

export function sanitizeGrantedPermissions(granted: readonly string[]): PermissionSnapshot {
  return {
    declared: [...PHASE_THREE_PERMISSIONS],
    granted: PHASE_THREE_PERMISSIONS.filter((permission) => granted.includes(permission)),
  }
}

function isDraftSnapshot(value: unknown): value is DraftSnapshot {
  if (!isRecord(value)) return false
  return (
    isIdentifier(value.chatId) &&
    isNonNegativeInteger(value.draftVersion) &&
    typeof value.cleanText === 'string' &&
    value.cleanText.length <= MAX_DRAFT_CHARACTERS &&
    Array.isArray(value.paragraphs) &&
    value.paragraphs.every(
      (paragraph) =>
        isRecord(paragraph) &&
        isIdentifier(paragraph.id) &&
        isPositiveInteger(paragraph.ordinal) &&
        isNonNegativeInteger(paragraph.lineIndex) &&
        typeof paragraph.text === 'string' &&
        paragraph.text.trim().length > 0,
    ) &&
    Array.isArray(value.history) &&
    value.history.length <= MAX_HISTORY_ENTRIES &&
    value.history.every(isHistoryEntry) &&
    (value.latestDiff === null || isDiff(value.latestDiff)) &&
    typeof value.canUndo === 'boolean' &&
    Array.isArray(value.recordingSegments) &&
    value.recordingSegments.length <= MAX_RECORDING_SEGMENTS &&
    value.recordingSegments.every(isRecordingSegment) &&
    typeof value.canUndoRecording === 'boolean' &&
    typeof value.dirty === 'boolean' &&
    isBoundedString(value.updatedAt, 1, 128)
  )
}

function isHistoryEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    (value.kind === 'manual-edit' ||
      value.kind === 'undo' ||
      value.kind === 'recording-append' ||
      value.kind === 'recording-undo') &&
    (value.editGroupId === undefined || isIdentifier(value.editGroupId)) &&
    isNonNegativeInteger(value.beforeVersion) &&
    isPositiveInteger(value.afterVersion) &&
    isBoundedString(value.timestamp, 1, 128) &&
    isDiff(value.diff)
  )
}

function isRecordingSegment(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.rawTranscript, 1, MAX_DRAFT_CHARACTERS) &&
    isBoundedString(value.committedText, 1, MAX_DRAFT_CHARACTERS) &&
    isNonNegativeInteger(value.startOffset) &&
    isNonNegativeInteger(value.beforeVersion) &&
    isPositiveInteger(value.resultingVersion) &&
    value.resultingVersion === value.beforeVersion + 1 &&
    isBoundedString(value.committedAt, 1, 128)
  )
}

function isDiff(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.removed === 'string' &&
    typeof value.added === 'string' &&
    value.removed.length <= MAX_DRAFT_CHARACTERS &&
    value.added.length <= MAX_DRAFT_CHARACTERS &&
    isNonNegativeInteger(value.startOffset) &&
    Array.isArray(value.affectedParagraphOrdinals) &&
    value.affectedParagraphOrdinals.every(isPositiveInteger)
  )
}

function isPermissionSnapshot(value: unknown): value is PermissionSnapshot {
  if (!isRecord(value) || !Array.isArray(value.declared) || !Array.isArray(value.granted)) {
    return false
  }
  return (
    value.declared.length === PHASE_THREE_PERMISSIONS.length &&
    value.declared.every((permission, index) => permission === PHASE_THREE_PERMISSIONS[index]) &&
    value.granted.length <= PHASE_THREE_PERMISSIONS.length &&
    value.granted.every((permission) => PHASE_THREE_PERMISSIONS.includes(permission)) &&
    new Set(value.granted).size === value.granted.length
  )
}

function hasEnvelope(value: unknown): value is Record<string, unknown> & {
  protocolVersion: typeof PROTOCOL_VERSION
  type: string
  requestId: string
} {
  return (
    isRecord(value) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    isBoundedString(value.type, 1, 128) &&
    isIdentifier(value.requestId)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, 1, 256)
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
