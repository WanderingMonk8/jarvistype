import type { SpindleAPI } from 'lumiverse-spindle-types'

declare const spindle: SpindleAPI

import { PROTOCOL_VERSION, type BackendResponse, type FrontendRequest } from './protocol/messages'
import { isFrontendRequest, sanitizeGrantedPermissions } from './protocol/validation'

interface RequestContext {
  userId: string
  frontendSessionId?: string
}

const activeRequests = new Map<string, { cancelled: boolean }>()

function send(response: BackendResponse, context: RequestContext): void {
  spindle.sendToFrontend(response, context.userId, {
    ...(context.frontendSessionId ? { frontendSessionId: context.frontendSessionId } : {}),
  })
}

spindle.onFrontendMessage((payload: unknown, userId: string, frontendSessionId?: string) => {
  const context = { userId, ...(frontendSessionId ? { frontendSessionId } : {}) }
  if (!isFrontendRequest(payload)) {
    spindle.log.warn('JarvisType rejected a malformed frontend message')
    return
  }
  void handleRequest(payload, context)
})

async function handleRequest(request: FrontendRequest, context: RequestContext): Promise<void> {
  if (request.type === 'app.operation.cancel') {
    const target = activeRequests.get(request.targetRequestId)
    if (target) target.cancelled = true
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'app.operation.cancelled',
        requestId: request.requestId,
        ok: true,
        targetRequestId: request.targetRequestId,
        cancellationAccepted: target !== undefined,
      },
      context,
    )
    return
  }

  const activeRequest = { cancelled: false }
  activeRequests.set(request.requestId, activeRequest)
  try {
    const [backendVersion, frontendVersion, granted] = await Promise.all([
      spindle.version.getBackend(),
      spindle.version.getFrontend(),
      spindle.permissions.getGranted(),
    ])
    if (activeRequest.cancelled) return

    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'app.health.response',
        requestId: request.requestId,
        ok: true,
        backendVersion,
        frontendVersion,
        serverTimestamp: new Date().toISOString(),
        permissions: sanitizeGrantedPermissions(granted),
      },
      context,
    )
  } catch (error) {
    if (activeRequest.cancelled) return
    spindle.log.error(`JarvisType health request failed: ${describeError(error)}`)
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'app.error',
        requestId: request.requestId,
        ok: false,
        code: 'INTERNAL_ERROR',
        message: 'JarvisType could not initialize its backend connection.',
        retryable: true,
      },
      context,
    )
  } finally {
    activeRequests.delete(request.requestId)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

spindle.log.info('JarvisType Phase 1 foundation loaded')
