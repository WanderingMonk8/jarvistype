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
