import assert from 'node:assert/strict'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../src/protocol/messages'
import {
  isBackendResponse,
  isFrontendRequest,
  sanitizeGrantedPermissions,
} from '../src/protocol/validation'

test('accepts a valid health request', () => {
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.health.request',
      requestId: 'request-1',
      clientTimestamp: '2026-10-13T08:00:00.000Z',
      activeChatId: 'chat-1',
    }),
    true,
  )
})

test('rejects malformed and future-version requests', () => {
  assert.equal(isFrontendRequest(null), false)
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION + 1,
      type: 'app.health.request',
      requestId: 'request-1',
      clientTimestamp: 'now',
      activeChatId: null,
    }),
    false,
  )
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.operation.cancel',
      requestId: 'cancel-1',
      targetRequestId: '',
    }),
    false,
  )
})

test('accepts valid health responses and rejects malformed permission snapshots', () => {
  const response = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'app.health.response',
    requestId: 'request-1',
    ok: true,
    backendVersion: '1.2.5',
    frontendVersion: '1.2.5',
    serverTimestamp: '2026-10-13T08:00:00.000Z',
    permissions: { declared: ['media'], granted: ['media'] },
  }
  assert.equal(isBackendResponse(response), true)
  assert.equal(
    isBackendResponse({
      ...response,
      permissions: { declared: ['media'], granted: ['credentials'] },
    }),
    false,
  )
})

test('permission snapshots expose only unique declared Phase 1 permissions', () => {
  assert.deepEqual(sanitizeGrantedPermissions(['generation', 'media', 'media', 'chat_mutation']), {
    declared: ['media'],
    granted: ['media'],
  })
})
