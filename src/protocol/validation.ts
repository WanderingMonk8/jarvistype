import {
  MAX_DRAFT_CHARACTERS,
  MAX_HISTORY_ENTRIES,
  MAX_RECORDING_SEGMENTS,
  type DraftSnapshot,
} from '../domain/draft-session'
import { parseEditPlan } from '../domain/edit-pipeline'
import {
  PHASE_FOUR_PERMISSIONS,
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
  'NORMALIZATION_FAILED',
  'NORMALIZATION_EXPIRED',
  'EDIT_INTERPRETATION_FAILED',
  'EDIT_TARGET_UNRESOLVED',
  'EDIT_PROPOSAL_EXPIRED',
  'GLOSSARY_CONFLICT',
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
  if (
    value.type === 'draft.undo.request' ||
    value.type === 'draft.redo.request' ||
    value.type === 'draft.send.request'
  ) {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion)
    )
  }
  if (value.type === 'transcript.normalize.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion) &&
      isBoundedString(value.rawTranscript, 1, MAX_DRAFT_CHARACTERS) &&
      (value.quotationBoundaryHint === undefined ||
        value.quotationBoundaryHint === 'double' ||
        value.quotationBoundaryHint === 'single')
    )
  }
  if (value.type === 'transcript.confirm.request' || value.type === 'edit.confirm.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion)
    )
  }
  if (value.type === 'edit.interpret.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion) &&
      isBoundedString(value.instructionTranscript, 1, MAX_DRAFT_CHARACTERS)
    )
  }
  if (value.type === 'edit.candidate.select.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion) &&
      isIdentifier(value.candidateId)
    )
  }
  if (value.type === 'draft.recording.undo.request') {
    return (
      isIdentifier(value.operationId) &&
      isIdentifier(value.chatId) &&
      isNonNegativeInteger(value.expectedVersion)
    )
  }
  if (value.type === 'phase4.load.request' || value.type === 'glossary.undo.request') return true
  if (value.type === 'phase4.settings.update.request') return isPhaseFourSettings(value.settings)
  if (value.type === 'glossary.upsert.request') {
    return (
      (value.entryId === undefined || isIdentifier(value.entryId)) &&
      isBoundedString(value.canonical, 1, 200) &&
      Array.isArray(value.variants) &&
      value.variants.length <= 20 &&
      value.variants.every((variant) => isBoundedString(variant, 1, 200)) &&
      typeof value.hint === 'string' &&
      value.hint.length <= 500
    )
  }
  if (value.type === 'glossary.delete.request') return isIdentifier(value.entryId)
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
  if (value.type === 'transcript.normalization.response') {
    return (
      value.ok === true &&
      (value.outcome === 'committed' || value.outcome === 'review') &&
      isNormalizationProposal(value.proposal) &&
      (value.snapshot === undefined || isDraftSnapshot(value.snapshot)) &&
      (value.glossaryLearned === undefined ||
        (Array.isArray(value.glossaryLearned) && value.glossaryLearned.every(isGlossaryEntry)))
    )
  }
  if (value.type === 'edit.proposal.response') {
    return (
      value.ok === true &&
      (value.outcome === 'review' || value.outcome === 'committed') &&
      isEditProposal(value.proposal) &&
      (value.snapshot === undefined || isDraftSnapshot(value.snapshot)) &&
      (value.glossaryLearned === undefined ||
        (Array.isArray(value.glossaryLearned) && value.glossaryLearned.every(isGlossaryEntry)))
    )
  }
  if (value.type === 'edit.candidates.response') {
    return (
      value.ok === true &&
      value.outcome === 'selection-required' &&
      isEditCandidateSet(value.candidateSet)
    )
  }
  if (value.type === 'phase4.state.response') {
    return (
      value.ok === true &&
      isPhaseFourSettings(value.settings) &&
      Array.isArray(value.connections) &&
      value.connections.every(isNormalizationConnectionOption) &&
      Array.isArray(value.glossary) &&
      value.glossary.every(isGlossaryEntry) &&
      typeof value.canUndoGlossary === 'boolean' &&
      (value.notice === undefined || isBoundedString(value.notice, 1, 1_000))
    )
  }
  if (value.type === 'app.error') {
    return (
      value.ok === false &&
      typeof value.code === 'string' &&
      ERROR_CODES.includes(value.code as AppErrorCode) &&
      isBoundedString(value.message, 1, 2_000) &&
      typeof value.retryable === 'boolean' &&
      (value.diagnosticId === undefined || isBoundedString(value.diagnosticId, 1, 100)) &&
      (value.operationId === undefined || isIdentifier(value.operationId)) &&
      (value.snapshot === undefined || isDraftSnapshot(value.snapshot))
    )
  }
  return false
}

export function sanitizeGrantedPermissions(granted: readonly string[]): PermissionSnapshot {
  return {
    declared: [...PHASE_FOUR_PERMISSIONS],
    granted: PHASE_FOUR_PERMISSIONS.filter((permission) => granted.includes(permission)),
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
    typeof value.canRedo === 'boolean' &&
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
      value.kind === 'automated-edit' ||
      value.kind === 'undo' ||
      value.kind === 'redo' ||
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
    isBoundedString(value.normalizedTranscript, 1, MAX_DRAFT_CHARACTERS) &&
    isRecordingNormalization(value.normalization) &&
    isBoundedString(value.committedText, 1, MAX_DRAFT_CHARACTERS) &&
    isNonNegativeInteger(value.startOffset) &&
    isNonNegativeInteger(value.beforeVersion) &&
    isPositiveInteger(value.resultingVersion) &&
    value.resultingVersion === value.beforeVersion + 1 &&
    isBoundedString(value.committedAt, 1, 128)
  )
}

function isRecordingNormalization(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => isBoundedString(reason, 1, 200)) &&
    isNonNegativeInteger(value.contextMessageCount) &&
    isNonNegativeInteger(value.contextCharacterCount) &&
    typeof value.contextTruncated === 'boolean' &&
    typeof value.contextualModelUsed === 'boolean'
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
    value.declared.length === PHASE_FOUR_PERMISSIONS.length &&
    value.declared.every((permission, index) => permission === PHASE_FOUR_PERMISSIONS[index]) &&
    value.granted.length <= PHASE_FOUR_PERMISSIONS.length &&
    value.granted.every((permission) => PHASE_FOUR_PERMISSIONS.includes(permission)) &&
    new Set(value.granted).size === value.granted.length
  )
}

function isPhaseFourSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.contextMessageCount) &&
    value.contextMessageCount <= 20 &&
    typeof value.contextualNormalizationEnabled === 'boolean' &&
    (value.grammarRepairMode === 'off' ||
      value.grammarRepairMode === 'when_needed' ||
      value.grammarRepairMode === 'always') &&
    (value.normalizationConnectionId === null || isIdentifier(value.normalizationConnectionId)) &&
    typeof value.normalizationModelOverride === 'string' &&
    value.normalizationModelOverride.length <= 200
  )
}

function isNormalizationConnectionOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, 1, 200) &&
    isBoundedString(value.provider, 1, 200) &&
    typeof value.model === 'string' &&
    value.model.length <= 200 &&
    typeof value.isDefault === 'boolean'
  )
}

function isNormalizationProposal(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.operationId) &&
    isIdentifier(value.chatId) &&
    isNonNegativeInteger(value.expectedVersion) &&
    isBoundedString(value.rawTranscript, 1, MAX_DRAFT_CHARACTERS) &&
    isBoundedString(value.candidateText, 1, MAX_DRAFT_CHARACTERS) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => isBoundedString(reason, 1, 200)) &&
    Array.isArray(value.ambiguities) &&
    value.ambiguities.every((reason) => isBoundedString(reason, 1, 500)) &&
    Array.isArray(value.learningCandidates) &&
    value.learningCandidates.every(
      (candidate) =>
        isRecord(candidate) &&
        isBoundedString(candidate.canonical, 1, 200) &&
        typeof candidate.spokenVariant === 'string' &&
        candidate.spokenVariant.length <= 500,
    ) &&
    isNonNegativeInteger(value.contextMessageCount) &&
    isNonNegativeInteger(value.contextCharacterCount) &&
    typeof value.contextTruncated === 'boolean' &&
    typeof value.contextualModelUsed === 'boolean'
  )
}

function isEditProposal(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.operationId) &&
    isIdentifier(value.chatId) &&
    isNonNegativeInteger(value.expectedVersion) &&
    (value.grammarRepairChanges === undefined ||
      (Array.isArray(value.grammarRepairChanges) &&
        value.grammarRepairChanges.every((change) => isBoundedString(change, 1, 500)))) &&
    isBoundedString(value.instructionTranscript, 1, MAX_DRAFT_CHARACTERS) &&
    parseEditPlan(value.plan) !== null &&
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    value.operations.every(
      (operation) =>
        isRecord(operation) &&
        isIdentifier(operation.id) &&
        typeof operation.type === 'string' &&
        isNonNegativeInteger(operation.startOffset) &&
        isNonNegativeInteger(operation.endOffset) &&
        typeof operation.beforeText === 'string' &&
        typeof operation.afterText === 'string' &&
        isPositiveInteger(operation.paragraphOrdinal),
    ) &&
    typeof value.beforeText === 'string' &&
    value.beforeText.length <= MAX_DRAFT_CHARACTERS &&
    typeof value.afterText === 'string' &&
    value.afterText.length <= MAX_DRAFT_CHARACTERS &&
    Array.isArray(value.affectedParagraphOrdinals) &&
    value.affectedParagraphOrdinals.every(isPositiveInteger) &&
    typeof value.explanation === 'string' &&
    value.explanation.length <= 1_000 &&
    Array.isArray(value.learningCandidates) &&
    value.learningCandidates.every(
      (candidate) =>
        isRecord(candidate) &&
        isBoundedString(candidate.canonical, 1, 200) &&
        typeof candidate.spokenVariant === 'string' &&
        candidate.spokenVariant.length <= 500,
    ) &&
    (value.resultingParagraphIds === undefined ||
      (Array.isArray(value.resultingParagraphIds) &&
        value.resultingParagraphIds.length <= MAX_DRAFT_CHARACTERS &&
        value.resultingParagraphIds.every(isIdentifier) &&
        new Set(value.resultingParagraphIds).size === value.resultingParagraphIds.length))
  )
}

function isEditCandidateSet(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.operationId) &&
    isIdentifier(value.chatId) &&
    isNonNegativeInteger(value.expectedVersion) &&
    isBoundedString(value.instructionTranscript, 1, MAX_DRAFT_CHARACTERS) &&
    Array.isArray(value.candidates) &&
    value.candidates.length >= 2 &&
    value.candidates.length <= 20 &&
    value.candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        isIdentifier(candidate.id) &&
        isIdentifier(candidate.operationId) &&
        isIdentifier(candidate.paragraphId) &&
        isPositiveInteger(candidate.paragraphOrdinal) &&
        isBoundedString(candidate.exactText, 1, MAX_DRAFT_CHARACTERS) &&
        isBoundedString(candidate.preview, 1, MAX_DRAFT_CHARACTERS),
    )
  )
}

function isGlossaryEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.canonical, 1, 200) &&
    Array.isArray(value.variants) &&
    value.variants.every((variant) => isBoundedString(variant, 1, 200)) &&
    typeof value.hint === 'string' &&
    value.hint.length <= 500 &&
    (value.source === 'explicit-spelling' || value.source === 'manual') &&
    isNonNegativeInteger(value.useCount) &&
    isBoundedString(value.createdAt, 1, 128) &&
    isBoundedString(value.updatedAt, 1, 128)
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
