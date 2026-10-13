import assert from 'node:assert/strict'
import test from 'node:test'

import { PROTOCOL_VERSION, type BackendResponse } from '../src/protocol/messages'

type FrontendHandler = (payload: unknown, userId: string, frontendSessionId?: string) => void

const responses: Array<{
  payload: BackendResponse
  userId?: string
  frontendSessionId?: string
}> = []
const warnings: string[] = []
let frontendHandler: FrontendHandler | null = null
let resolveBackendVersion: ((value: string) => void) | null = null

const spindleMock = {
  onFrontendMessage(handler: FrontendHandler) {
    frontendHandler = handler
    return () => undefined
  },
  sendToFrontend(
    payload: BackendResponse,
    userId?: string,
    options?: { frontendSessionId?: string },
  ) {
    responses.push({ payload, userId, frontendSessionId: options?.frontendSessionId })
  },
  version: {
    getBackend: () => Promise.resolve('1.2.5'),
    getFrontend: () => Promise.resolve('1.2.5'),
  },
  permissions: {
    getGranted: () => Promise.resolve(['media']),
  },
  log: {
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: () => undefined,
  },
}

Object.assign(globalThis, { spindle: spindleMock })
await import('../src/backend')

test.beforeEach(() => {
  responses.length = 0
  warnings.length = 0
  resolveBackendVersion = null
  spindleMock.version.getBackend = () => Promise.resolve('1.2.5')
})

test('returns a validated health response to the originating frontend session', async () => {
  assert.ok(frontendHandler)
  frontendHandler(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.health.request',
      requestId: 'health-1',
      clientTimestamp: '2026-10-13T08:00:00.000Z',
      activeChatId: 'chat-1',
    },
    'user-1',
    'frontend-1',
  )
  await settleAsyncWork()

  assert.equal(responses.length, 1)
  assert.equal(responses[0]?.payload.type, 'app.health.response')
  assert.equal(responses[0]?.userId, 'user-1')
  assert.equal(responses[0]?.frontendSessionId, 'frontend-1')
})

test('rejects malformed requests without replying', async () => {
  assert.ok(frontendHandler)
  frontendHandler({ type: 'untrusted' }, 'user-1', 'frontend-1')
  await settleAsyncWork()

  assert.equal(responses.length, 0)
  assert.equal(warnings.length, 1)
})

test('accepts cancellation only while the target request is active', async () => {
  spindleMock.version.getBackend = () =>
    new Promise<string>((resolve) => {
      resolveBackendVersion = resolve
    })
  assert.ok(frontendHandler)
  frontendHandler(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.health.request',
      requestId: 'slow-health',
      clientTimestamp: '2026-10-13T08:00:00.000Z',
      activeChatId: null,
    },
    'user-1',
    'frontend-1',
  )
  frontendHandler(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.operation.cancel',
      requestId: 'cancel-1',
      targetRequestId: 'slow-health',
    },
    'user-1',
    'frontend-1',
  )
  resolveBackendVersion?.('1.2.5')
  await settleAsyncWork()

  assert.equal(responses.length, 1)
  assert.deepEqual(responses[0]?.payload, {
    protocolVersion: PROTOCOL_VERSION,
    type: 'app.operation.cancelled',
    requestId: 'cancel-1',
    ok: true,
    targetRequestId: 'slow-health',
    cancellationAccepted: true,
  })
})

function settleAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
