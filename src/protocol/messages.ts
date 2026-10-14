import type { DraftSnapshot } from '../domain/draft-session'

export const PROTOCOL_VERSION = 2 as const
export const APP_VERSION = '0.8.0'
export const REQUEST_TIMEOUT_MS = 15_000
export const SEND_TIMEOUT_MS = 120_000

export const PHASE_TWO_PERMISSIONS = ['media', 'chats', 'chat_mutation', 'generation'] as const

export type PermissionName = (typeof PHASE_TWO_PERMISSIONS)[number]

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
      type: 'app.error'
      ok: false
      code: AppErrorCode
      message: string
      retryable: boolean
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
  | 'CHAT_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'SEND_FAILED'

export function createRequestId(prefix = 'request'): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`
}
