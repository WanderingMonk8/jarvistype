import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NORMALIZATION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} from '../src/protocol/messages'
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

test('allows contextual normalization longer than ordinary requests', () => {
  assert.equal(NORMALIZATION_TIMEOUT_MS, 120_000)
  assert.ok(NORMALIZATION_TIMEOUT_MS > REQUEST_TIMEOUT_MS)
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
    permissions: {
      declared: ['media', 'chats', 'chat_mutation', 'generation'],
      granted: ['media'],
    },
  }
  assert.equal(isBackendResponse(response), true)
  assert.equal(
    isBackendResponse({
      ...response,
      permissions: {
        declared: ['media', 'chats', 'chat_mutation', 'generation'],
        granted: ['credentials'],
      },
    }),
    false,
  )
})

test('permission snapshots expose only unique declared Phase 4 permissions', () => {
  assert.deepEqual(sanitizeGrantedPermissions(['generation', 'media', 'media', 'chat_mutation']), {
    declared: ['media', 'chats', 'chat_mutation', 'generation'],
    granted: ['media', 'chat_mutation', 'generation'],
  })
})

test('validates bounded draft mutations', () => {
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: 'request-1',
      operationId: 'operation-1',
      chatId: 'chat-1',
      expectedVersion: 0,
      editGroupId: 'group-1',
      cleanText: 'Draft text',
    }),
    true,
  )
})

test('validates normalization connection and custom-model settings', () => {
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'settings-request',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        normalizationConnectionId: 'connection-1',
        normalizationModelOverride: 'custom-model',
      },
    }),
    true,
  )
})

test('validates transcript normalization and recording undo requests', () => {
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.normalize.request',
      requestId: 'recording-request-1',
      operationId: 'recording-operation-1',
      chatId: 'chat-1',
      expectedVersion: 2,
      rawTranscript: 'A completed transcript.',
    }),
    true,
  )
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.normalize.request',
      requestId: 'recording-request-2',
      operationId: 'recording-operation-2',
      chatId: 'chat-1',
      expectedVersion: 2,
      rawTranscript: '',
    }),
    false,
  )
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.recording.undo.request',
      requestId: 'recording-undo-request',
      operationId: 'recording-undo-operation',
      chatId: 'chat-1',
      expectedVersion: 3,
    }),
    true,
  )
})

test('validates semantic edit interpretation and confirmation requests', () => {
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-request',
      operationId: 'edit-operation',
      chatId: 'chat-1',
      expectedVersion: 4,
      instructionTranscript: 'Replace the first sentence in paragraph two.',
    }),
    true,
  )
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-request-empty',
      operationId: 'edit-operation-empty',
      chatId: 'chat-1',
      expectedVersion: 4,
      instructionTranscript: '',
    }),
    false,
  )
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'edit-confirm',
      operationId: 'edit-operation',
      chatId: 'chat-1',
      expectedVersion: 4,
    }),
    true,
  )
  assert.equal(
    isFrontendRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidate.select.request',
      requestId: 'edit-candidate-select',
      operationId: 'edit-operation',
      chatId: 'chat-1',
      expectedVersion: 4,
      candidateId: 'candidate-2',
    }),
    true,
  )
})

test('validates an edit ambiguity candidate response', () => {
  assert.equal(
    isBackendResponse({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidates.response',
      requestId: 'candidate-response',
      ok: true,
      outcome: 'selection-required',
      candidateSet: {
        operationId: 'edit-operation',
        chatId: 'chat-1',
        expectedVersion: 2,
        instructionTranscript: 'Change the repeated phrase.',
        candidates: [1, 2].map((paragraphOrdinal) => ({
          id: `candidate-${paragraphOrdinal}`,
          operationId: 'replace-phrase',
          paragraphId: `paragraph-${paragraphOrdinal}`,
          paragraphOrdinal,
          exactText: 'repeated phrase',
          preview: `The repeated phrase in paragraph ${paragraphOrdinal}.`,
        })),
      },
    }),
    true,
  )
})
