declare const spindle: import('lumiverse-spindle-types').SpindleAPI

import {
  PROTOCOL_VERSION,
  hashBytes,
  isProbeRequest,
  type ProbeResponse,
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
