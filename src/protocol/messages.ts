import type { DraftSnapshot } from '../domain/draft-session'
import type { GlossaryEntry } from '../domain/glossary'
import type { SpellingLearningCandidate } from '../domain/normalization'
import type { EditPlan, ResolvedEditOperation } from '../domain/edit-pipeline'

export const PROTOCOL_VERSION = 7 as const
export const APP_VERSION = '1.6.15'
export const REQUEST_TIMEOUT_MS = 15_000
export const NORMALIZATION_TIMEOUT_MS = 120_000
export const SEND_TIMEOUT_MS = 120_000

export const PHASE_FOUR_PERMISSIONS = [
  'media',
  'chats',
  'chat_mutation',
  'generation',
  'characters',
] as const

export type PermissionName = (typeof PHASE_FOUR_PERMISSIONS)[number]

export interface PhaseFourSettings {
  contextMessageCount: number
  referenceCacheLimit?: number
  referenceAdmissionOccurrences?: number
  contextualNormalizationEnabled: boolean
  grammarRepairMode: 'off' | 'when_needed' | 'always'
  glossaryDefaultScope?: 'local' | 'global'
  decisionConnectionId?: string | null
  normalizationConnectionId: string | null
  normalizationModelOverride: string
  debugLoggingEnabled?: boolean
}

export interface NormalizationConnectionOption {
  id: string
  name: string
  provider: string
  model: string
  isDefault: boolean
}

export interface DecisionConnectionOption {
  id: string
  name: string
  provider: string
  model: string
  isDefault: boolean
}

export interface NormalizationProposal {
  operationId: string
  chatId: string
  expectedVersion: number
  rawTranscript: string
  candidateText: string
  reasons: string[]
  ambiguities: string[]
  learningCandidates: SpellingLearningCandidate[]
  contextMessageCount: number
  contextCharacterCount: number
  contextTruncated: boolean
  contextualModelUsed: boolean
}

export interface EditProposal {
  operationId: string
  chatId: string
  expectedVersion: number
  instructionTranscript: string
  plan: EditPlan
  operations: ResolvedEditOperation[]
  beforeText: string
  afterText: string
  affectedParagraphOrdinals: number[]
  explanation: string
  learningCandidates: SpellingLearningCandidate[]
  grammarRepairChanges?: string[]
  resultingParagraphIds?: string[]
}

export interface EditTargetCandidate {
  id: string
  operationId: string
  paragraphId: string
  paragraphOrdinal: number
  exactText: string
  preview: string
}

export interface EditCandidateSet {
  operationId: string
  chatId: string
  expectedVersion: number
  instructionTranscript: string
  candidates: EditTargetCandidate[]
}

export interface PermissionSnapshot {
  declared: PermissionName[]
  granted: PermissionName[]
}

interface RequestEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION
  requestId: string
}

export type FrontendRequest =
  | (RequestEnvelope & {
      type: 'app.health.request'
      clientTimestamp: string
      activeChatId: string | null
    })
  | (RequestEnvelope & {
      type: 'app.operation.cancel'
      targetRequestId: string
    })
  | (RequestEnvelope & {
      type: 'draft.load.request'
      chatId: string
    })
  | (RequestEnvelope & {
      type: 'draft.mutate.request'
      operationId: string
      chatId: string
      expectedVersion: number
      editGroupId: string
      cleanText: string
    })
  | (RequestEnvelope & {
      type: 'draft.undo.request'
      operationId: string
      chatId: string
      expectedVersion: number
    })
  | (RequestEnvelope & {
      type: 'draft.redo.request'
      operationId: string
      chatId: string
      expectedVersion: number
    })
  | (RequestEnvelope & {
      type: 'transcript.normalize.request'
      operationId: string
      chatId: string
      expectedVersion: number
      rawTranscript: string
      quotationBoundaryHint?: 'double' | 'single'
    })
  | (RequestEnvelope & {
      type: 'transcript.confirm.request'
      operationId: string
      chatId: string
      expectedVersion: number
    })
  | (RequestEnvelope & {
      type: 'edit.interpret.request'
      operationId: string
      chatId: string
      expectedVersion: number
      instructionTranscript: string
    })
  | (RequestEnvelope & {
      type: 'edit.confirm.request'
      operationId: string
      chatId: string
      expectedVersion: number
    })
  | (RequestEnvelope & {
      type: 'edit.candidate.select.request'
      operationId: string
      chatId: string
      expectedVersion: number
      candidateId: string
    })
  | (RequestEnvelope & {
      type: 'draft.recording.undo.request'
      operationId: string
      chatId: string
      expectedVersion: number
    })
  | (RequestEnvelope & {
      type: 'phase4.load.request'
      chatId?: string
    })
  | (RequestEnvelope & {
      type: 'phase4.settings.update.request'
      settings: PhaseFourSettings
      chatId?: string
    })
  | (RequestEnvelope & {
      type: 'glossary.upsert.request'
      entryId?: string
      canonical: string
      variants: string[]
      hint: string
      scope?: 'local' | 'global'
      chatId?: string
    })
  | (RequestEnvelope & {
      type: 'glossary.delete.request'
      entryId: string
      chatId?: string
    })
  | (RequestEnvelope & {
      type: 'glossary.undo.request'
      chatId?: string
    })
  | (RequestEnvelope & {
      type: 'debug.log.request'
      clear?: boolean
    })
  | (RequestEnvelope & {
      type: 'draft.send.request'
      operationId: string
      chatId: string
      expectedVersion: number
    })

export type BackendResponse =
  | (RequestEnvelope & {
      type: 'app.health.response'
      ok: true
      backendVersion: string
      frontendVersion: string
      serverTimestamp: string
      permissions: PermissionSnapshot
    })
  | (RequestEnvelope & {
      type: 'app.operation.cancelled'
      ok: true
      targetRequestId: string
      cancellationAccepted: boolean
    })
  | (RequestEnvelope & {
      type: 'draft.snapshot.response'
      ok: true
      outcome: 'loaded' | 'applied' | 'unchanged' | 'stale-version'
      operationId?: string
      snapshot: DraftSnapshot
    })
  | (RequestEnvelope & {
      type: 'draft.send.response'
      ok: true
      operationId: string
      messageIdPresent: true
      generationIdPresent: boolean
      snapshot: DraftSnapshot
    })
  | (RequestEnvelope & {
      type: 'transcript.normalization.response'
      ok: true
      outcome: 'committed' | 'review'
      proposal: NormalizationProposal
      snapshot?: DraftSnapshot
      glossaryLearned?: GlossaryEntry[]
    })
  | (RequestEnvelope & {
      type: 'edit.proposal.response'
      ok: true
      outcome: 'review' | 'committed'
      proposal: EditProposal
      snapshot?: DraftSnapshot
      glossaryLearned?: GlossaryEntry[]
    })
  | (RequestEnvelope & {
      type: 'edit.candidates.response'
      ok: true
      outcome: 'selection-required'
      candidateSet: EditCandidateSet
    })
  | (RequestEnvelope & {
      type: 'phase4.state.response'
      ok: true
      settings: PhaseFourSettings
      connections: NormalizationConnectionOption[]
      decisionConnections: DecisionConnectionOption[]
      glossary: GlossaryEntry[]
      canUndoGlossary: boolean
      decisionModelAvailable: boolean
      notice?: string
    })
  | (RequestEnvelope & {
      type: 'debug.log.response'
      ok: true
      entries: string[]
    })
  | (RequestEnvelope & {
      type: 'app.error'
      ok: false
      code: AppErrorCode
      message: string
      retryable: boolean
      diagnosticId?: string
      operationId?: string
      snapshot?: DraftSnapshot
    })

export type AppErrorCode =
  | 'MALFORMED_REQUEST'
  | 'BACKEND_UNAVAILABLE'
  | 'REQUEST_CANCELLED'
  | 'INTERNAL_ERROR'
  | 'DRAFT_TOO_LARGE'
  | 'DRAFT_EMPTY'
  | 'DRAFT_PERSIST_FAILED'
  | 'TRANSCRIPT_EMPTY'
  | 'NORMALIZATION_FAILED'
  | 'NORMALIZATION_EXPIRED'
  | 'EDIT_INTERPRETATION_FAILED'
  | 'EDIT_TARGET_UNRESOLVED'
  | 'EDIT_PROPOSAL_EXPIRED'
  | 'GLOSSARY_CONFLICT'
  | 'RECORDING_UNDO_CONFLICT'
  | 'CHAT_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'SEND_FAILED'

export function createRequestId(prefix = 'request'): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`
}

