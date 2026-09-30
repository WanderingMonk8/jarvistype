declare const spindle: import('lumiverse-spindle-types').SpindleAPI

import {
  PROTOCOL_VERSION,
  hashBytes,
  isProbeRequest,
  type ProbeResponse,
  type SttApiSurface,
} from './shared'

function send(response: ProbeResponse, userId: string): void {
  spindle.sendToFrontend(response, userId)
}

const activeSttRuns = new Map<string, AbortController>()
const STT_CONFORMANCE_METHODS = [
  'transcribe',
  'transcribeStream',
  'getProviders',
  'listConnections',
  'getConnection',
] as const

spindle.onFrontendMessage(async (payload: unknown, userId: string) => {
  if (!isProbeRequest(payload)) {
    spindle.log.warn('JarvisType probe rejected a malformed frontend message')
    return
  }

  if (payload.type === 'probe.health.request') {
    try {
      const [backendVersion, frontendVersion] = await Promise.all([
        spindle.version.getBackend(),
        spindle.version.getFrontend(),
      ])

      send(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: 'probe.health.response',
          requestId: payload.requestId,
          ok: true,
          backendVersion,
          frontendVersion,
          serverTimestamp: new Date().toISOString(),
        },
        userId,
      )
    } catch (error) {
      send(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: 'probe.error',
          requestId: payload.requestId,
          ok: false,
          error: describeError(error),
        },
        userId,
      )
    }
    return
  }

  if (payload.type === 'probe.stt.surface.request') {
    const backend = inspectSttSurface(spindle as unknown)
    const hasInvocation =
      payload.frontend.invocationCandidates.length > 0 || backend.invocationCandidates.length > 0
    const hasRegistration =
      payload.frontend.registrationCandidates.length > 0 || backend.registrationCandidates.length > 0

    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'probe.stt.surface.response',
        requestId: payload.requestId,
        ok: true,
        frontend: payload.frontend,
        backend,
        conclusion: hasInvocation
          ? 'invocation-api-found'
          : hasRegistration
            ? 'registration-only'
            : 'no-stt-surface',
      },
      userId,
    )
    return
  }

  if (payload.type === 'probe.stt.conformance.capability') {
    const check = inspectProposedSttApi(spindle as unknown)
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'probe.stt.conformance.capability.result',
        requestId: payload.requestId,
        ok: true,
        hostCapabilityVersion: check.hostCapabilityVersion,
        permissionGranted: spindle.permissions.has('stt'),
        availableMethods: check.availableMethods,
        missingMethods: check.missingMethods,
        supported: check.supported,
      },
      userId,
    )
    return
  }

  if (payload.type === 'probe.stt.conformance.cancel') {
    const controller = activeSttRuns.get(sttRunKey(userId, payload.targetRequestId))
    if (controller) {
      controller.abort('Cancelled by the conformance-test user')
    } else {
      send(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: 'probe.error',
          requestId: payload.requestId,
          ok: false,
          error: 'No matching active STT conformance run was found',
        },
        userId,
      )
    }
    return
  }

  if (payload.type === 'probe.stt.conformance.run') {
    void runSttConformance(payload, userId)
    return
  }

  let deleted = false
  let actualSize: number | null = null
  let actualHash: string | null = null
  let fileName: string | null = null
  let errorMessage: string | undefined

  try {
    const uploaded = await spindle.uploads.get(payload.uploadId, userId)
    if (!uploaded) {
      throw new Error('The staged upload was missing, expired, or unavailable to this user')
    }

    actualSize = uploaded.size
    actualHash = hashBytes(uploaded.data)
    fileName = uploaded.fileName
  } catch (error) {
    errorMessage = describeError(error)
  } finally {
    try {
      deleted = await spindle.uploads.delete(payload.uploadId, userId)
    } catch (error) {
      spindle.log.warn(`JarvisType probe could not delete staged upload: ${describeError(error)}`)
    }

    const bytesMatched =
      actualSize === payload.expectedSize && actualHash === payload.expectedHash
    const ok = deleted && bytesMatched && errorMessage === undefined
    const resultError =
      errorMessage ??
      (!bytesMatched
        ? 'Staged upload bytes did not match the frontend sample'
        : !deleted
          ? 'Staged upload verification finished, but explicit deletion was not confirmed'
          : undefined)

    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'probe.upload.result',
        requestId: payload.requestId,
        ok,
        expectedSize: payload.expectedSize,
        actualSize,
        expectedHash: payload.expectedHash,
        actualHash,
        reportedMimeType: payload.reportedMimeType,
        fileName,
        deleted,
        ...(resultError ? { error: resultError } : {}),
      },
      userId,
    )
  }
})

spindle.log.info('JarvisType Phase 0 capability probe loaded')

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ProposedSttApi {
  transcribe(input: unknown): Promise<unknown>
  transcribeStream(input: unknown): AsyncIterable<unknown>
  getProviders(userId?: string): Promise<unknown>
  listConnections(userId?: string): Promise<unknown>
  getConnection(connectionId: string, userId?: string): Promise<unknown>
}

async function runSttConformance(
  payload: Extract<import('./shared').ProbeRequest, { type: 'probe.stt.conformance.run' }>,
  userId: string,
): Promise<void> {
  const key = sttRunKey(userId, payload.requestId)
  if (activeSttRuns.has(key)) return

  const controller = new AbortController()
  activeSttRuns.set(key, controller)
  let connectionCount = 0
  let providerCount = 0
  let partialCount = 0
  let finalSegmentCount = 0
  let finalText: string | null = null
  let appliedFeatures: string[] = []
  let unsupportedOptionalFeatures: string[] = []
  let uploadDeleted = false
  let error: string | undefined
  let errorCode: string | undefined
  let aborted = false

  try {
    const check = inspectProposedSttApi(spindle as unknown)
    if (!check.supported || !check.api) {
      throw conformanceError('STT_CAPABILITY_UNAVAILABLE', 'Host does not implement stt-invocation-v1')
    }
    if (!spindle.permissions.has('stt')) {
      throw conformanceError('PERMISSION_DENIED', 'The stt permission has not been granted')
    }

    const [providers, connections] = await Promise.all([
      check.api.getProviders(userId),
      check.api.listConnections(userId),
    ])
    providerCount = Array.isArray(providers) ? providers.length : 0
    connectionCount = Array.isArray(connections) ? connections.length : 0

    const stream = check.api.transcribeStream({
      source: {
        kind: 'upload',
        upload_id: payload.uploadId,
        mime_type: payload.reportedMimeType || undefined,
      },
      language: 'en',
      context_prompt:
        'JarvisType is a voice-composition extension. This conformance recording mentions JarvisType and Pip-Boy.',
      keywords: ['JarvisType', 'Pip-Boy'],
      punctuation: 'enabled',
      timeout_ms: 120_000,
      signal: controller.signal,
    })

    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw conformanceError('STT_INVALID_STREAM', 'transcribeStream did not return an async iterable')
    }

    for await (const rawEvent of stream) {
      const event = asRecord(rawEvent)
      const eventType = readString(event, 'type')
      if (eventType === 'started') {
        appliedFeatures = readStringArray(event, 'applied_features')
        unsupportedOptionalFeatures = readStringArray(event, 'unsupported_optional_features')
        sendSttEvent(payload.requestId, userId, 'started', event)
      } else if (eventType === 'partial') {
        partialCount += 1
        sendSttEvent(payload.requestId, userId, 'partial', event)
      } else if (eventType === 'final_segment') {
        finalSegmentCount += 1
        sendSttEvent(payload.requestId, userId, 'final_segment', event)
      } else if (eventType === 'done') {
        const result = asRecord(event.result)
        finalText = readNullableString(result, 'text')
        appliedFeatures = readStringArray(result, 'applied_features', appliedFeatures)
        unsupportedOptionalFeatures = readStringArray(
          result,
          'unsupported_optional_features',
          unsupportedOptionalFeatures,
        )
      }
    }

    if (finalText === null) {
      throw conformanceError('STT_MISSING_FINAL', 'Stream ended without an authoritative final transcript')
    }
  } catch (caught) {
    aborted = controller.signal.aborted || readErrorCode(caught) === 'STT_ABORTED'
    errorCode = aborted ? 'STT_ABORTED' : readErrorCode(caught)
    error = safeSttErrorMessage(caught, errorCode)
  } finally {
    activeSttRuns.delete(key)
    try {
      uploadDeleted = await spindle.uploads.delete(payload.uploadId, userId)
    } catch (caught) {
      spindle.log.warn(`JarvisType STT conformance upload cleanup failed: ${describeError(caught)}`)
    }
  }

  if (!uploadDeleted && error === undefined) {
    errorCode = 'STT_UPLOAD_DELETE_FAILED'
    error = 'Transcription finished, but staged-upload deletion was not confirmed'
  }

  const ok = error === undefined && finalText !== null && uploadDeleted
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'probe.stt.conformance.result',
      requestId: payload.requestId,
      ok,
      connectionCount,
      providerCount,
      partialCount,
      finalSegmentCount,
      finalText,
      appliedFeatures,
      unsupportedOptionalFeatures,
      uploadDeleted,
      aborted,
      ...(errorCode ? { errorCode } : {}),
      ...(error ? { error } : {}),
    },
    userId,
  )
}

function inspectProposedSttApi(root: unknown): {
  hostCapabilityVersion: number
  availableMethods: string[]
  missingMethods: string[]
  supported: boolean
  api: ProposedSttApi | null
} {
  const host = asRecord(readMember(root, 'host'))
  const capabilities = asRecord(host.capabilities)
  const rawVersion = capabilities['stt-invocation-v1']
  const hostCapabilityVersion =
    typeof rawVersion === 'number' && Number.isSafeInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : 0
  const candidate = readMember(root, 'stt')
  const availableMethods = STT_CONFORMANCE_METHODS.filter(
    (method) => typeof readMember(candidate, method) === 'function',
  )
  const missingMethods = STT_CONFORMANCE_METHODS.filter(
    (method) => !availableMethods.includes(method),
  )
  const supported = hostCapabilityVersion >= 1 && missingMethods.length === 0
  return {
    hostCapabilityVersion,
    availableMethods: [...availableMethods],
    missingMethods: [...missingMethods],
    supported,
    api: supported ? (candidate as ProposedSttApi) : null,
  }
}

function sendSttEvent(
  requestId: string,
  userId: string,
  eventType: 'started' | 'partial' | 'final_segment',
  event: Record<string, unknown>,
): void {
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'probe.stt.conformance.event',
      requestId,
      ok: true,
      eventType,
      sequence: readNullableInteger(event, 'sequence'),
      segmentId: readNullableString(event, 'segment_id'),
      revision: readNullableInteger(event, 'revision'),
      text: readNullableString(event, 'text'),
      appliedFeatures: readStringArray(event, 'applied_features'),
      unsupportedOptionalFeatures: readStringArray(event, 'unsupported_optional_features'),
    },
    userId,
  )
}

function sttRunKey(userId: string, requestId: string): string {
  return `${userId}:${requestId}`
}

function conformanceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function readErrorCode(error: unknown): string {
  const code = readMember(error, 'code')
  return typeof code === 'string' && code.length <= 128 ? code : 'STT_UNKNOWN_ERROR'
}

function safeSttErrorMessage(error: unknown, code: string): string {
  if (
    code === 'STT_CAPABILITY_UNAVAILABLE' ||
    code === 'PERMISSION_DENIED' ||
    code === 'STT_INVALID_STREAM' ||
    code === 'STT_MISSING_FINAL'
  ) {
    return describeError(error)
  }
  if (code === 'STT_ABORTED') return 'STT conformance run was cancelled'
  return `STT conformance run failed with ${code}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length <= 100_000 ? value : null
}

function readNullableInteger(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  fallback: string[] = [],
): string[] {
  const value = record[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 64)
    : fallback
}

function inspectSttSurface(root: unknown): SttApiSurface {
  return {
    relevantRootMembers: relevantMembers(root),
    connectionMembers: memberNames(readMember(root, 'connections')),
    providerMembers: memberNames(readMember(root, 'providers')),
    relevantHostCapabilities: relevantCapabilityNames(readMember(root, 'host')),
    invocationCandidates: existingFunctionPaths(root, [
      'transcribe',
      'stt',
      'stt.transcribe',
      'stt.invoke',
      'speechToText',
      'speechToText.transcribe',
      'speech',
      'speech.transcribe',
      'transcription',
      'transcription.transcribe',
      'voice.transcribe',
      'audio.transcribe',
      'media.transcribe',
      'connections.transcribe',
      'providers.invoke',
      'providers.call',
      'providers.execute',
      'providers.transcribe',
    ]),
    registrationCandidates: existingFunctionPaths(root, [
      'registerSttEngine',
      'providers.register',
      'providers.handle',
    ]),
  }
}

function relevantMembers(value: unknown): string[] {
  return memberNames(value).filter((name) => /(stt|speech|transcri|voice|provider|connection)/i.test(name))
}

function memberNames(value: unknown): string[] {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return []
  const names = new Set<string>()
  let cursor: object | null = value as object
  for (let depth = 0; cursor && depth < 3; depth += 1) {
    try {
      for (const name of Object.getOwnPropertyNames(cursor)) {
        if (name !== 'constructor' && name.length <= 128) names.add(name)
      }
      cursor = Object.getPrototypeOf(cursor) as object | null
    } catch {
      break
    }
  }
  return [...names].sort().slice(0, 64)
}

function relevantCapabilityNames(host: unknown): string[] {
  const capabilities = readMember(host, 'capabilities')
  if (typeof capabilities !== 'object' || capabilities === null) return []
  return Object.keys(capabilities)
    .filter((name) => /(stt|speech|transcri|voice|provider|connection)/i.test(name))
    .sort()
    .slice(0, 64)
}

function existingFunctionPaths(root: unknown, paths: string[]): string[] {
  return paths.filter((path) => {
    let value = root
    for (const segment of path.split('.')) value = readMember(value, segment)
    return typeof value === 'function'
  })
}

function readMember(value: unknown, name: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  try {
    return (value as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}
