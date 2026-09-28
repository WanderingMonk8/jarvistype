export const PROTOCOL_VERSION = 1 as const
export const PROBE_VERSION = '0.1.0'
export const MAX_PROBE_AUDIO_BYTES = 25 * 1024 * 1024

export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/aac',
] as const

export type ProbeRequest =
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.health.request'
      requestId: string
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.upload.verify'
      requestId: string
      uploadId: string
      expectedSize: number
      expectedHash: string
      reportedMimeType: string
    }

export type ProbeResponse =
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.health.response'
      requestId: string
      ok: true
      backendVersion: string
      frontendVersion: string
      serverTimestamp: string
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.upload.result'
      requestId: string
      ok: boolean
      expectedSize: number
      actualSize: number | null
      expectedHash: string
      actualHash: string | null
      reportedMimeType: string
      fileName: string | null
      deleted: boolean
      error?: string
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.error'
      requestId: string
      ok: false
      error: string
    }

export function isProbeRequest(value: unknown): value is ProbeRequest {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return false
  if (!isBoundedString(value.requestId, 1, 128)) return false

  if (value.type === 'probe.health.request') return true
  if (value.type !== 'probe.upload.verify') return false

  return (
    isBoundedString(value.uploadId, 1, 512) &&
    typeof value.expectedSize === 'number' &&
    Number.isSafeInteger(value.expectedSize) &&
    value.expectedSize >= 0 &&
    value.expectedSize <= MAX_PROBE_AUDIO_BYTES &&
    typeof value.expectedHash === 'string' &&
    /^[0-9a-f]{8}$/.test(value.expectedHash) &&
    isBoundedString(value.reportedMimeType, 0, 128)
  )
}

export function isProbeResponse(value: unknown): value is ProbeResponse {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return false
  if (!isBoundedString(value.requestId, 1, 128)) return false

  if (value.type === 'probe.health.response') {
    return (
      value.ok === true &&
      isBoundedString(value.backendVersion, 1, 128) &&
      isBoundedString(value.frontendVersion, 1, 128) &&
      isBoundedString(value.serverTimestamp, 1, 128)
    )
  }

  if (value.type === 'probe.error') {
    return value.ok === false && isBoundedString(value.error, 1, 2_000)
  }

  if (value.type !== 'probe.upload.result') return false
  return (
    typeof value.ok === 'boolean' &&
    isSafeProbeSize(value.expectedSize) &&
    (value.actualSize === null || isSafeProbeSize(value.actualSize)) &&
    typeof value.expectedHash === 'string' &&
    /^[0-9a-f]{8}$/.test(value.expectedHash) &&
    (value.actualHash === null ||
      (typeof value.actualHash === 'string' && /^[0-9a-f]{8}$/.test(value.actualHash))) &&
    isBoundedString(value.reportedMimeType, 0, 128) &&
    (value.fileName === null || isBoundedString(value.fileName, 0, 512)) &&
    typeof value.deleted === 'boolean' &&
    (value.error === undefined || isBoundedString(value.error, 1, 2_000))
  )
}

export function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function isSafeProbeSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PROBE_AUDIO_BYTES
  )
}
