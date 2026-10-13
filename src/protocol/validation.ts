import {
  PHASE_ONE_PERMISSIONS,
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
]

export function isFrontendRequest(value: unknown): value is FrontendRequest {
  if (!hasEnvelope(value)) return false

  if (value.type === 'app.health.request') {
    return (
      isBoundedString(value.clientTimestamp, 1, 128) &&
      (value.activeChatId === null || isBoundedString(value.activeChatId, 1, 256))
    )
  }

  if (value.type === 'app.operation.cancel') {
    return isBoundedString(value.targetRequestId, 1, 128)
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
      isBoundedString(value.targetRequestId, 1, 128) &&
      typeof value.cancellationAccepted === 'boolean'
    )
  }

  if (value.type === 'app.error') {
    return (
      value.ok === false &&
      typeof value.code === 'string' &&
      ERROR_CODES.includes(value.code as AppErrorCode) &&
      isBoundedString(value.message, 1, 2_000) &&
      typeof value.retryable === 'boolean'
    )
  }

  return false
}

export function sanitizeGrantedPermissions(granted: readonly string[]): PermissionSnapshot {
  return {
    declared: [...PHASE_ONE_PERMISSIONS],
    granted: PHASE_ONE_PERMISSIONS.filter((permission) => granted.includes(permission)),
  }
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
    isBoundedString(value.requestId, 1, 128)
  )
}

function isPermissionSnapshot(value: unknown): value is PermissionSnapshot {
  if (!isRecord(value) || !Array.isArray(value.declared) || !Array.isArray(value.granted)) {
    return false
  }
  return (
    value.declared.length === PHASE_ONE_PERMISSIONS.length &&
    value.declared.every((permission) => PHASE_ONE_PERMISSIONS.includes(permission)) &&
    value.granted.length <= PHASE_ONE_PERMISSIONS.length &&
    value.granted.every((permission) => PHASE_ONE_PERMISSIONS.includes(permission)) &&
    new Set(value.granted).size === value.granted.length
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}
