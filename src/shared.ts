export const PROTOCOL_VERSION = 1 as const
export const PROBE_VERSION = '0.5.0'
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
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.stt.surface.request'
      requestId: string
      frontend: SttApiSurface
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.stt.conformance.capability'
      requestId: string
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.stt.conformance.run'
      requestId: string
      uploadId: string
      reportedMimeType: string
      expectedSize: number
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.stt.conformance.cancel'
      requestId: string
      targetRequestId: string
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.chat.run'
      requestId: string
      chatId: string
      mode: 'append-only' | 'append-and-generate'
    }

export interface SttApiSurface {
  relevantRootMembers: string[]
  connectionMembers: string[]
  providerMembers: string[]
  relevantHostCapabilities: string[]
  invocationCandidates: string[]
  registrationCandidates: string[]
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
      type: 'probe.stt.surface.response'
      requestId: string
      ok: true
      frontend: SttApiSurface
      backend: SttApiSurface
      conclusion: 'invocation-api-found' | 'registration-only' | 'no-stt-surface'
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.stt.conformance.capability.result'
      requestId: string
      ok: true
      hostCapabilityVersion: number
      permissionGranted: boolean
      availableMethods: string[]
      missingMethods: string[]
      supported: boolean
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.stt.conformance.event'
      requestId: string
      ok: true
      eventType: 'started' | 'partial' | 'final_segment'
      sequence: number | null
      segmentId: string | null
      revision: number | null
      text: string | null
      appliedFeatures: string[]
      unsupportedOptionalFeatures: string[]
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.stt.conformance.result'
      requestId: string
      ok: boolean
      connectionCount: number
      providerCount: number
      partialCount: number
      finalSegmentCount: number
      finalText: string | null
      appliedFeatures: string[]
      unsupportedOptionalFeatures: string[]
      uploadDeleted: boolean
      aborted: boolean
      errorCode?: string
      error?: string
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION
      type: 'probe.chat.result'
      requestId: string
      ok: boolean
      mode: 'append-only' | 'append-and-generate'
      chatMutationPermission: boolean
      generationPermission: boolean
      messageIdPresent: boolean
      generationIdPresent: boolean
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
  if (value.type === 'probe.stt.surface.request') return isSttApiSurface(value.frontend)
  if (value.type === 'probe.stt.conformance.capability') return true
  if (value.type === 'probe.stt.conformance.cancel') {
    return isBoundedString(value.targetRequestId, 1, 128)
  }
  if (value.type === 'probe.stt.conformance.run') {
    return (
      isBoundedString(value.uploadId, 1, 512) &&
      isBoundedString(value.reportedMimeType, 0, 128) &&
      isSafeProbeSize(value.expectedSize)
    )
  }
  if (value.type === 'probe.chat.run') {
    return (
      isBoundedString(value.chatId, 1, 256) &&
      (value.mode === 'append-only' || value.mode === 'append-and-generate')
    )
  }
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

  if (value.type === 'probe.stt.surface.response') {
    return (
      value.ok === true &&
      isSttApiSurface(value.frontend) &&
      isSttApiSurface(value.backend) &&
      (value.conclusion === 'invocation-api-found' ||
        value.conclusion === 'registration-only' ||
        value.conclusion === 'no-stt-surface')
    )
  }

  if (value.type === 'probe.stt.conformance.capability.result') {
    return (
      value.ok === true &&
      typeof value.hostCapabilityVersion === 'number' &&
      Number.isSafeInteger(value.hostCapabilityVersion) &&
      value.hostCapabilityVersion >= 0 &&
      typeof value.permissionGranted === 'boolean' &&
      isBoundedStringArray(value.availableMethods) &&
      isBoundedStringArray(value.missingMethods) &&
      typeof value.supported === 'boolean'
    )
  }

  if (value.type === 'probe.stt.conformance.event') {
    return (
      value.ok === true &&
      (value.eventType === 'started' ||
        value.eventType === 'partial' ||
        value.eventType === 'final_segment') &&
      isNullableSafeInteger(value.sequence) &&
      (value.segmentId === null || isBoundedString(value.segmentId, 1, 256)) &&
      isNullableSafeInteger(value.revision) &&
      (value.text === null || isBoundedString(value.text, 0, 100_000)) &&
      isBoundedStringArray(value.appliedFeatures) &&
      isBoundedStringArray(value.unsupportedOptionalFeatures)
    )
  }

  if (value.type === 'probe.stt.conformance.result') {
    return (
      typeof value.ok === 'boolean' &&
      isNonNegativeSafeInteger(value.connectionCount) &&
      isNonNegativeSafeInteger(value.providerCount) &&
      isNonNegativeSafeInteger(value.partialCount) &&
      isNonNegativeSafeInteger(value.finalSegmentCount) &&
      (value.finalText === null || isBoundedString(value.finalText, 0, 100_000)) &&
      isBoundedStringArray(value.appliedFeatures) &&
      isBoundedStringArray(value.unsupportedOptionalFeatures) &&
      typeof value.uploadDeleted === 'boolean' &&
      typeof value.aborted === 'boolean' &&
      (value.errorCode === undefined || isBoundedString(value.errorCode, 1, 128)) &&
      (value.error === undefined || isBoundedString(value.error, 1, 2_000))
    )
  }

  if (value.type === 'probe.chat.result') {
    return (
      typeof value.ok === 'boolean' &&
      (value.mode === 'append-only' || value.mode === 'append-and-generate') &&
      typeof value.chatMutationPermission === 'boolean' &&
      typeof value.generationPermission === 'boolean' &&
      typeof value.messageIdPresent === 'boolean' &&
      typeof value.generationIdPresent === 'boolean' &&
      (value.error === undefined || isBoundedString(value.error, 1, 2_000))
    )
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

function isSttApiSurface(value: unknown): value is SttApiSurface {
  if (!isRecord(value)) return false
  return (
    isBoundedStringArray(value.relevantRootMembers) &&
    isBoundedStringArray(value.connectionMembers) &&
    isBoundedStringArray(value.providerMembers) &&
    isBoundedStringArray(value.relevantHostCapabilities) &&
    isBoundedStringArray(value.invocationCandidates) &&
    isBoundedStringArray(value.registrationCandidates)
  )
}

function isBoundedStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => isBoundedString(item, 1, 128))
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value))
}
