export const PROTOCOL_VERSION = 1 as const
export const APP_VERSION = '0.7.0'
export const REQUEST_TIMEOUT_MS = 10_000

export const PHASE_ONE_PERMISSIONS = ['media'] as const

export type PermissionName = (typeof PHASE_ONE_PERMISSIONS)[number]

export interface PermissionSnapshot {
  declared: PermissionName[]
  granted: PermissionName[]
}

export type FrontendRequest =
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'app.health.request'
      requestId: string
      clientTimestamp: string
      activeChatId: string | null
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'app.operation.cancel'
      requestId: string
      targetRequestId: string
    }

export type BackendResponse =
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'app.health.response'
      requestId: string
      ok: true
      backendVersion: string
      frontendVersion: string
      serverTimestamp: string
      permissions: PermissionSnapshot
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'app.operation.cancelled'
      requestId: string
      ok: true
      targetRequestId: string
      cancellationAccepted: boolean
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'app.error'
      requestId: string
      ok: false
      code: AppErrorCode
      message: string
      retryable: boolean
    }

export type AppErrorCode =
  'MALFORMED_REQUEST' | 'BACKEND_UNAVAILABLE' | 'REQUEST_CANCELLED' | 'INTERNAL_ERROR'

export function createRequestId(prefix = 'request'): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`
}
