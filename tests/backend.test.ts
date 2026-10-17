import assert from 'node:assert/strict'
import test from 'node:test'

import { PROTOCOL_VERSION, type BackendResponse } from '../src/protocol/messages'

type FrontendHandler = (payload: unknown, userId: string, frontendSessionId?: string) => void

const responses: Array<{ payload: BackendResponse; userId?: string }> = []
const warnings: string[] = []
const errors: string[] = []
const stored = new Map<string, unknown>()
const appended: Array<{ chatId: string; content: string; triggerGeneration: boolean }> = []
const generationRequests: Array<{
  connection_id?: string
  parameters?: Record<string, unknown>
  messages?: Array<{ content: string }>
}> = []
let frontendHandler: FrontendHandler | null = null
let activeChatId: string | null = 'chat-default'
let appendShouldFail = false
let generationReturnsRawTranscript = false
let generationNormalizedText: string | null = null
let generationCommandDecisions: unknown[] = []
let editPlanResponse: unknown = null

const spindleMock = {
  onFrontendMessage(handler: FrontendHandler) {
    frontendHandler = handler
    return () => undefined
  },
  sendToFrontend(payload: BackendResponse, userId?: string) {
    responses.push({ payload, userId })
  },
  version: {
    getBackend: () => Promise.resolve('1.2.5'),
    getFrontend: () => Promise.resolve('1.2.5'),
  },
  permissions: {
    getGranted: () => Promise.resolve(['media', 'chats', 'chat_mutation', 'generation']),
    has: (permission: string) =>
      ['media', 'chats', 'chat_mutation', 'generation'].includes(permission),
  },
  userStorage: {
    getJson: <T>(path: string, options?: { fallback?: T; userId?: string }) =>
      Promise.resolve((stored.get(`${options?.userId}:${path}`) ?? options?.fallback) as T),
    setJson: (path: string, value: unknown, options?: { userId?: string }) => {
      stored.set(`${options?.userId}:${path}`, structuredClone(value))
      return Promise.resolve()
    },
    delete: (path: string, userId?: string) => {
      stored.delete(`${userId}:${path}`)
      return Promise.resolve()
    },
  },
  chats: {
    getActive: () =>
      Promise.resolve(
        activeChatId
          ? {
              id: activeChatId,
              character_id: 'character-1',
              name: 'Test',
              metadata: {},
              created_at: 0,
              updated_at: 0,
            }
          : null,
      ),
  },
  chat: {
    getMessages: () => Promise.resolve([]),
    appendMessage: (
      chatId: string,
      message: { content: string },
      options?: { triggerGeneration?: boolean },
    ) => {
      if (appendShouldFail) return Promise.reject(new Error('provider failure'))
      appended.push({
        chatId,
        content: message.content,
        triggerGeneration: options?.triggerGeneration === true,
      })
      return Promise.resolve({ id: `message-${appended.length}`, generationId: 'generation-1' })
    },
  },
  generate: {
    quiet: (request: {
      connection_id?: string
      parameters?: Record<string, unknown>
      messages?: Array<{ content: string }>
    }) => {
      generationRequests.push(request)
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as {
        candidate?: string
        rawTranscript?: string
        task?: string
      }
      if (input.task === 'Interpret this edit instruction against the numbered draft.')
        return Promise.resolve({ content: JSON.stringify(editPlanResponse) })
      return Promise.resolve({
        content: JSON.stringify({
          normalizedText: generationReturnsRawTranscript
            ? (input.rawTranscript ?? '')
            : (generationNormalizedText ?? input.candidate ?? ''),
          commandDecisions: generationCommandDecisions,
        }),
      })
    },
  },
  connections: {
    list: () => Promise.resolve([normalizationConnection]),
    get: (connectionId: string) =>
      Promise.resolve(connectionId === normalizationConnection.id ? normalizationConnection : null),
  },
  log: {
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: (message: string) => errors.push(message),
  },
}

Object.assign(globalThis, { spindle: spindleMock })
await import('../src/backend')

test.beforeEach(() => {
  responses.length = 0
  warnings.length = 0
  errors.length = 0
  appended.length = 0
  generationRequests.length = 0
  activeChatId = 'chat-default'
  appendShouldFail = false
  generationReturnsRawTranscript = false
  generationNormalizedText = null
  generationCommandDecisions = []
  editPlanResponse = null
})

const normalizationConnection = {
  id: 'normalization-connection',
  name: 'Fast Text Model',
  provider: 'openai-compatible',
  api_url: 'https://example.invalid',
  model: 'configured-model',
  preset_id: null,
  is_default: false,
  has_api_key: true,
  metadata: {},
  reasoning_bindings: null,
  created_at: 0,
  updated_at: 0,
}

test('loads and persists a chat-owned draft', async () => {
  const userId = 'draft-user'
  const chatId = 'draft-chat'
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.load.request',
      requestId: 'load-1',
      chatId,
    },
    userId,
  )
  const load = responses.at(-1)?.payload
  assert.equal(load?.type, 'draft.snapshot.response')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: 'mutate-1',
      operationId: 'operation-1',
      chatId,
      expectedVersion: 0,
      editGroupId: 'group-1',
      cleanText: 'First\n\nSecond',
    },
    userId,
  )
  const mutation = responses.at(-1)?.payload
  assert.equal(mutation?.type, 'draft.snapshot.response')
  if (mutation?.type === 'draft.snapshot.response') {
    assert.equal(mutation.snapshot.draftVersion, 1)
    assert.equal(mutation.snapshot.paragraphs.length, 2)
  }
  assert.equal(
    [...stored.keys()].some((key) => key.startsWith(`${userId}:draft-`)),
    true,
  )
})

test('undoes and redoes a draft mutation through the backend protocol', async () => {
  const userId = 'redo-user'
  const chatId = 'redo-chat'
  await seedDraft(userId, chatId, 'Restorable text')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.undo.request',
      requestId: 'undo-for-redo',
      operationId: 'undo-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )
  const undone = responses.at(-1)?.payload
  assert.equal(undone?.type, 'draft.snapshot.response')
  if (undone?.type === 'draft.snapshot.response') {
    assert.equal(undone.snapshot.cleanText, '')
    assert.equal(undone.snapshot.canRedo, true)
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.redo.request',
      requestId: 'redo-1',
      operationId: 'redo-operation',
      chatId,
      expectedVersion: 2,
    },
    userId,
  )
  const redone = responses.at(-1)?.payload
  assert.equal(redone?.type, 'draft.snapshot.response')
  if (redone?.type === 'draft.snapshot.response') {
    assert.equal(redone.snapshot.cleanText, 'Restorable text')
    assert.equal(redone.snapshot.canRedo, false)
    assert.equal(redone.snapshot.canUndo, true)
  }
})

test('lists safe normalization connections and dispatches with selected connection and model', async () => {
  const userId = 'connection-user'
  const chatId = 'connection-chat'
  activeChatId = chatId

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'settings-connection',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        normalizationConnectionId: normalizationConnection.id,
        normalizationModelOverride: 'custom-text-model',
      },
    },
    userId,
  )
  const settingsResponse = responses.at(-1)?.payload
  assert.equal(settingsResponse?.type, 'phase4.state.response')
  if (settingsResponse?.type === 'phase4.state.response') {
    assert.deepEqual(settingsResponse.connections, [
      {
        id: normalizationConnection.id,
        name: normalizationConnection.name,
        provider: normalizationConnection.provider,
        model: normalizationConnection.model,
        isDefault: false,
      },
    ])
  }

  await seedDraft(userId, chatId, 'Existing draft')
  generationRequests.length = 0
  await dispatch(
    recordingAppendRequest(chatId, 'selected-connection-segment', 1, 'Plain text'),
    userId,
  )

  assert.equal(generationRequests.length, 1)
  assert.equal(generationRequests[0]?.connection_id, normalizationConnection.id)
  assert.equal(generationRequests[0]?.parameters?.model, 'custom-text-model')
})

test('blocks sending when the active chat does not own the draft', async () => {
  const userId = 'mismatch-user'
  const chatId = 'owner-chat'
  await seedDraft(userId, chatId, 'Private text')
  responses.length = 0
  activeChatId = 'different-chat'

  await dispatch(sendRequest(chatId, 'send-mismatch'), userId)

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'app.error')
  if (response?.type === 'app.error') assert.equal(response.code, 'CHAT_MISMATCH')
  assert.equal(appended.length, 0)
})

test('sends exactly clean text once, triggers generation, and clears only after success', async () => {
  const userId = 'send-user'
  const chatId = 'send-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First\n\nSecond')
  responses.length = 0

  const request = sendRequest(chatId, 'send-once')
  await dispatch(request, userId)
  await dispatch({ ...request, requestId: 'send-duplicate-request' }, userId)

  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0], {
    chatId,
    content: 'First\n\nSecond',
    triggerGeneration: true,
  })
  assert.equal(
    responses.filter((response) => response.payload.type === 'draft.send.response').length,
    2,
  )
})

test('retains the draft when Lumiverse rejects the send', async () => {
  const userId = 'failure-user'
  const chatId = 'failure-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Keep me')
  responses.length = 0
  appendShouldFail = true

  await dispatch(sendRequest(chatId, 'send-failure'), userId)

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'app.error')
  if (response?.type === 'app.error') {
    assert.equal(response.code, 'SEND_FAILED')
    assert.equal(response.snapshot?.cleanText, 'Keep me')
    assert.match(response.diagnosticId ?? '', /^JT-SEND-[0-9a-f-]+$/i)
    assert.equal(response.message.includes(response.diagnosticId ?? 'missing'), true)
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /Private provider details were redacted/)
  assert.equal(
    errors.some((message) => message.includes('provider failure')),
    false,
  )
  assert.equal(
    errors.some((message) => message.includes('Keep me')),
    false,
  )
})

test('commits recording segments once, in order, and undoes only the latest segment', async () => {
  const userId = 'recording-user'
  const chatId = 'recording-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Typed')
  responses.length = 0

  const first = recordingAppendRequest(chatId, 'segment-one', 1, 'First')
  await normalizeAndConfirmRecording(first, userId)
  await normalizeAndConfirmRecording(
    recordingAppendRequest(chatId, 'segment-two', 2, 'Second'),
    userId,
  )

  const appendedResponse = responses.at(-1)?.payload
  assert.equal(appendedResponse?.type, 'transcript.normalization.response')
  if (appendedResponse?.type === 'transcript.normalization.response' && appendedResponse.snapshot) {
    assert.equal(appendedResponse.snapshot.cleanText, 'Typed First Second')
    assert.deepEqual(
      appendedResponse.snapshot.recordingSegments.map((segment) => segment.id),
      ['segment-one', 'segment-two'],
    )
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.recording.undo.request',
      requestId: 'undo-recording-request',
      operationId: 'undo-recording-operation',
      chatId,
      expectedVersion: 3,
    },
    userId,
  )
  const undoResponse = responses.at(-1)?.payload
  assert.equal(undoResponse?.type, 'draft.snapshot.response')
  if (undoResponse?.type === 'draft.snapshot.response') {
    assert.equal(undoResponse.snapshot.cleanText, 'Typed First')
    assert.equal(undoResponse.snapshot.recordingSegments.length, 1)
    assert.equal(undoResponse.snapshot.canUndoRecording, true)
  }
})

test('requires review even when a transcript needs no normalization', async () => {
  const userId = 'unchanged-review-user'
  const chatId = 'unchanged-review-chat'
  activeChatId = chatId

  await dispatch(
    recordingAppendRequest(chatId, 'unchanged-review-segment', 0, 'Plain unchanged text'),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.rawTranscript, 'Plain unchanged text')
    assert.equal(response.proposal.candidateText, 'Plain unchanged text')
    assert.equal(response.snapshot, undefined)
  }
})

test('allows non-mutating transcript review but blocks confirmation after the active chat changes', async () => {
  const userId = 'recording-mismatch-user'
  const chatId = 'recording-owner-chat'
  await seedDraft(userId, chatId, 'Preserve this')
  responses.length = 0
  activeChatId = 'different-recording-chat'

  await dispatch(recordingAppendRequest(chatId, 'blocked-segment', 1, 'Do not append'), userId)

  const proposalResponse = responses.at(-1)?.payload
  assert.equal(proposalResponse?.type, 'transcript.normalization.response')
  if (proposalResponse?.type !== 'transcript.normalization.response') return
  assert.equal(proposalResponse.outcome, 'review')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: 'blocked-confirm-request',
      operationId: proposalResponse.proposal.operationId,
      chatId,
      expectedVersion: proposalResponse.proposal.expectedVersion,
    },
    userId,
  )

  const confirmation = responses.at(-1)?.payload
  assert.equal(confirmation?.type, 'app.error')
  if (confirmation?.type === 'app.error') {
    assert.equal(confirmation.code, 'CHAT_MISMATCH')
    assert.equal(confirmation.snapshot?.cleanText, 'Preserve this')
    assert.equal(confirmation.snapshot?.recordingSegments.length, 0)
  }
})

test('offers review and commits safely after the user manually clears the entire draft', async () => {
  const userId = 'cleared-draft-recording-user'
  const chatId = 'cleared-draft-recording-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Delete all of this before recording.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: 'clear-draft-request',
      operationId: 'clear-draft-operation',
      chatId,
      expectedVersion: 1,
      editGroupId: 'clear-draft-group',
      cleanText: '',
    },
    userId,
  )
  const cleared = responses.at(-1)?.payload
  assert.equal(cleared?.type, 'draft.snapshot.response')
  if (cleared?.type !== 'draft.snapshot.response') return
  assert.equal(cleared.snapshot.cleanText, '')

  await dispatch(
    recordingAppendRequest(
      chatId,
      'record-after-clear-segment',
      cleared.snapshot.draftVersion,
      'Testing comma testing period',
    ),
    userId,
  )
  const proposalResponse = responses.at(-1)?.payload
  assert.equal(proposalResponse?.type, 'transcript.normalization.response')
  if (proposalResponse?.type !== 'transcript.normalization.response') return
  assert.equal(proposalResponse.outcome, 'review')
  assert.equal(proposalResponse.proposal.candidateText, 'Testing, testing.')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: 'confirm-after-clear-request',
      operationId: proposalResponse.proposal.operationId,
      chatId,
      expectedVersion: proposalResponse.proposal.expectedVersion,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'transcript.normalization.response')
  if (committed?.type === 'transcript.normalization.response') {
    assert.equal(committed.outcome, 'committed')
    assert.equal(committed.snapshot?.cleanText, 'Testing, testing.')
  }
})

test('traces a manual rewrite and preserves it as the baseline for the next recording', async () => {
  const userId = 'manual-rewrite-recording-user'
  const chatId = 'manual-rewrite-recording-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Original baseline.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: 'manual-rewrite-request',
      operationId: 'manual-rewrite-operation',
      chatId,
      expectedVersion: 1,
      editGroupId: 'manual-rewrite-group',
      cleanText: 'Manually revised baseline.',
    },
    userId,
  )
  const rewritten = responses.at(-1)?.payload
  assert.equal(rewritten?.type, 'draft.snapshot.response')
  if (rewritten?.type !== 'draft.snapshot.response') return
  assert.equal(rewritten.snapshot.cleanText, 'Manually revised baseline.')
  assert.equal(rewritten.snapshot.draftVersion, 2)
  assert.equal(rewritten.snapshot.history.at(-1)?.kind, 'manual-edit')
  assert.equal(rewritten.snapshot.history.at(-1)?.editGroupId, 'manual-rewrite-group')
  assert.equal(rewritten.snapshot.history.at(-1)?.beforeVersion, 1)
  assert.equal(rewritten.snapshot.history.at(-1)?.afterVersion, 2)
  assert.deepEqual(rewritten.snapshot.history.at(-1)?.diff.affectedParagraphOrdinals, [1])

  await dispatch(
    recordingAppendRequest(
      chatId,
      'record-after-manual-rewrite-segment',
      rewritten.snapshot.draftVersion,
      'Follow-up period',
    ),
    userId,
  )
  const proposalResponse = responses.at(-1)?.payload
  assert.equal(proposalResponse?.type, 'transcript.normalization.response')
  if (proposalResponse?.type !== 'transcript.normalization.response') return
  assert.equal(proposalResponse.outcome, 'review')
  assert.equal(proposalResponse.proposal.candidateText, 'Follow-up.')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: 'confirm-after-manual-rewrite-request',
      operationId: proposalResponse.proposal.operationId,
      chatId,
      expectedVersion: proposalResponse.proposal.expectedVersion,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'transcript.normalization.response')
  if (committed?.type === 'transcript.normalization.response') {
    assert.equal(committed.outcome, 'committed')
    assert.equal(committed.snapshot?.cleanText, 'Manually revised baseline. Follow-up.')
    assert.deepEqual(
      committed.snapshot?.history.slice(-2).map((entry) => entry.kind),
      ['manual-edit', 'recording-append'],
    )
    assert.equal(
      committed.snapshot?.recordingSegments.at(-1)?.beforeVersion,
      rewritten.snapshot.draftVersion,
    )
  }
})

test('requires review before committing explicit spelling and learns only after confirmation', async () => {
  const userId = 'spelling-user'
  const chatId = 'spelling-chat'
  activeChatId = chatId

  await dispatch(
    recordingAppendRequest(
      chatId,
      'spelling-segment',
      0,
      'Write capitalized C-A-E-S-A-R Caesar period',
    ),
    userId,
  )
  const proposalResponse = responses.at(-1)?.payload
  assert.equal(proposalResponse?.type, 'transcript.normalization.response')
  if (proposalResponse?.type !== 'transcript.normalization.response') return
  assert.equal(proposalResponse.outcome, 'review')
  assert.equal(proposalResponse.proposal.candidateText, 'Write Caesar.')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.load.request',
      requestId: 'glossary-before',
    },
    userId,
  )
  const before = responses.at(-1)?.payload
  assert.equal(before?.type === 'phase4.state.response' ? before.glossary.length : -1, 0)

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: 'confirm-spelling',
      operationId: 'spelling-segment',
      chatId,
      expectedVersion: 0,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'transcript.normalization.response')
  if (committed?.type === 'transcript.normalization.response') {
    assert.equal(committed.snapshot?.cleanText, 'Write Caesar.')
    assert.equal(
      committed.snapshot?.recordingSegments[0]?.rawTranscript,
      'Write capitalized C-A-E-S-A-R Caesar period',
    )
    assert.equal(committed.glossaryLearned?.[0]?.canonical, 'Caesar')
  }
})

test('re-applies deterministic commands when contextual output returns the raw provider text', async () => {
  const userId = 'provider-punctuation-user'
  const chatId = 'provider-punctuation-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationReturnsRawTranscript = true

  await dispatch(
    recordingAppendRequest(
      chatId,
      'provider-punctuation-segment',
      1,
      'Use the word period here, period.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.rawTranscript, 'Use the word period here, period.')
    assert.equal(response.proposal.candidateText, 'Use period here.')
    assert.equal(response.snapshot, undefined)
  }
})

test('contextually recovers a standout spoken command without prior chat or draft context', async () => {
  const userId = 'contextual-command-user'
  const chatId = 'contextual-command-chat'
  activeChatId = chatId
  generationNormalizedText =
    'That completes the introduction new paragraph Our second concern is cost.'
  generationCommandDecisions = [
    {
      sourceText: 'new pair of graph',
      interpretation: 'command',
      command: 'new paragraph',
    },
  ]

  await dispatch(
    recordingAppendRequest(
      chatId,
      'contextual-command-segment',
      0,
      'That completes the introduction new pair of graph Our second concern is cost period',
    ),
    userId,
  )

  assert.equal(generationRequests.length, 1)
  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(
      response.proposal.candidateText,
      'That completes the introduction\n\nOur second concern is cost.',
    )
    assert.equal(response.proposal.contextualModelUsed, true)
    assert.ok(response.proposal.reasons.includes('contextual spoken command: new paragraph'))
  }

  const systemPrompt = generationRequests[0]?.messages?.[0]?.content ?? ''
  assert.match(systemPrompt, /natural noun, verb, descriptive/)
  assert.match(systemPrompt, /commandDecisions/)
})

test('rejects contextual command decisions that do not quote the raw transcript', async () => {
  const userId = 'invented-command-user'
  const chatId = 'invented-command-chat'
  activeChatId = chatId
  generationNormalizedText = 'Ordinary prose new paragraph More prose'
  generationCommandDecisions = [
    {
      sourceText: 'words that were never spoken',
      interpretation: 'command',
      command: 'new paragraph',
    },
  ]

  await dispatch(
    recordingAppendRequest(chatId, 'invented-command-segment', 0, 'Ordinary prose period'),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.proposal.candidateText, 'Ordinary prose.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('falls back safely when the model misses a standalone phonetic paragraph command', async () => {
  const userId = 'missed-contextual-command-user'
  const chatId = 'missed-contextual-command-chat'
  activeChatId = chatId

  await dispatch(
    recordingAppendRequest(
      chatId,
      'missed-contextual-command-segment',
      0,
      'That completes the introduction. New pair of graph. Our second concern is cost.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(
      response.proposal.candidateText,
      'That completes the introduction.\n\nOur second concern is cost.',
    )
    assert.ok(response.proposal.reasons.includes('contextual recovery: new paragraph'))
  }
})

test('does not let contextual normalization replace an authoritative literal punctuation word', async () => {
  const userId = 'literal-punctuation-user'
  const chatId = 'literal-punctuation-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationNormalizedText = 'The. of time is challenging for many.'

  await dispatch(
    recordingAppendRequest(
      chatId,
      'literal-punctuation-segment',
      1,
      'The period of time is challenging for many period',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.candidateText, 'The period of time is challenging for many.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('does not let contextual normalization discard literal as in wording', async () => {
  const userId = 'literal-as-in-user'
  const chatId = 'literal-as-in-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationNormalizedText = 'Use the prior example.'

  await dispatch(
    recordingAppendRequest(chatId, 'literal-as-in-segment', 1, 'Use this as in the prior example.'),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.candidateText, 'Use this as in the prior example.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('does not let contextual normalization discard commanded quotation marks', async () => {
  const userId = 'commanded-quotes-user'
  const chatId = 'commanded-quotes-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationNormalizedText = 'She said proceed carefully.'

  await dispatch(
    recordingAppendRequest(
      chatId,
      'commanded-quotes-segment',
      1,
      'She said quote proceed carefully quote period',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.candidateText, 'She said “proceed carefully”.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('does not let contextual normalization discard ordinary spoken punctuation commands', async () => {
  const userId = 'commanded-punctuation-user'
  const chatId = 'commanded-punctuation-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationNormalizedText = 'Alpha beta.'

  await dispatch(
    recordingAppendRequest(chatId, 'commanded-punctuation-segment', 1, 'Alpha comma beta period'),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.candidateText, 'Alpha, beta.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('commits a leading new-paragraph command as a paragraph boundary', async () => {
  const userId = 'leading-paragraph-user'
  const chatId = 'leading-paragraph-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    'First paragraph.\n\nA healthier limit is half of the actual context window.',
  )
  responses.length = 0

  const request = recordingAppendRequest(
    chatId,
    'leading-paragraph-segment',
    1,
    'New paragraph. It is often assumed that those who work harder tend to be more successful. Period.',
  )
  await dispatch(request, userId)

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'transcript.normalization.response')
  if (proposal?.type !== 'transcript.normalization.response') return
  assert.equal(
    proposal.proposal.candidateText,
    '\n\nIt is often assumed that those who work harder tend to be more successful.',
  )

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: 'confirm-leading-paragraph',
      operationId: request.operationId,
      chatId,
      expectedVersion: 1,
    },
    userId,
  )

  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'transcript.normalization.response')
  if (committed?.type === 'transcript.normalization.response') {
    assert.equal(
      committed.snapshot?.cleanText,
      'First paragraph.\n\nA healthier limit is half of the actual context window.\n\nIt is often assumed that those who work harder tend to be more successful.',
    )
    assert.equal(committed.snapshot?.paragraphs.length, 3)
  }
})

test('does not let contextual normalization override authoritative explicit spelling', async () => {
  const userId = 'authoritative-spelling-user'
  const chatId = 'authoritative-spelling-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationNormalizedText = 'Write PIP-BOY.'

  await dispatch(
    recordingAppendRequest(
      chatId,
      'authoritative-spelling-segment',
      1,
      'Write capitalized PIP-BOY, PIP-BOY.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.candidateText, 'Write Pip-Boy.')
    assert.equal(response.proposal.contextualModelUsed, false)
    assert.deepEqual(response.proposal.learningCandidates, [
      { canonical: 'Pip-Boy', spokenVariant: 'PIP-BOY' },
    ])
  }
})

test('keeps spoken edit instructions out of the draft until the structured proposal is approved', async () => {
  const userId = 'edit-user'
  const chatId = 'edit-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'We hiked up the mountain.\n\nThe weather changed.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Correct the requested phrase in paragraph one.',
    operations: [
      {
        id: 'replace-1',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'hiked up the mountain' },
        text: 'climbed the mountain',
      },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-interpret-1',
      operationId: 'edit-operation-1',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'In paragraph one, replace hiked up the mountain with climbed the mountain.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.outcome, 'review')
  assert.equal(proposal.snapshot, undefined)
  assert.equal(proposal.proposal.beforeText, 'We hiked up the mountain.\n\nThe weather changed.')
  assert.equal(proposal.proposal.afterText, 'We climbed the mountain.\n\nThe weather changed.')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'edit-confirm-1',
      operationId: 'edit-operation-1',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'edit.proposal.response')
  if (committed?.type === 'edit.proposal.response') {
    assert.equal(committed.outcome, 'committed')
    assert.equal(committed.snapshot?.cleanText, 'We climbed the mountain.\n\nThe weather changed.')
    assert.equal(committed.snapshot?.history.at(-1)?.kind, 'automated-edit')
  }
})

test('reviews and commits a word move through the structured edit pipeline', async () => {
  const userId = 'inline-move-user'
  const chatId = 'inline-move-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'The status is pending but nearly approved.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Move the requested word before its destination.',
    operations: [
      {
        id: 'move-approved',
        type: 'move_before',
        target: { paragraphOrdinal: 1, exactText: 'approved' },
        destination: { paragraphOrdinal: 1, exactText: 'pending' },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'inline-move-interpret',
      operationId: 'inline-move-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Move approved before pending.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.outcome, 'review')
  assert.equal(proposal.proposal.beforeText, 'The status is pending but nearly approved.')
  assert.equal(proposal.proposal.afterText, 'The status is approved pending but nearly.')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'inline-move-confirm',
      operationId: 'inline-move-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'edit.proposal.response')
  if (committed?.type === 'edit.proposal.response') {
    assert.equal(committed.outcome, 'committed')
    assert.equal(committed.snapshot?.cleanText, 'The status is approved pending but nearly.')
    assert.equal(committed.snapshot?.history.at(-1)?.kind, 'automated-edit')
  }
})

test('reviews and commits a punctuation target resolved relative to a phrase', async () => {
  const userId = 'punctuation-target-user'
  const chatId = 'punctuation-target-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'She said “this is very good”, and smiled.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace the quote after the requested phrase.',
    operations: [
      {
        id: 'replace-relative-quote',
        type: 'replace',
        target: {
          punctuation: 'quote',
          relativePosition: 'after',
          relativeToText: 'this is very good',
        },
        text: '!',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'punctuation-target-interpret',
      operationId: 'punctuation-target-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Replace the quote after the phrase this is very good with an exclamation mark.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.outcome, 'review')
  assert.equal(proposal.proposal.afterText, 'She said “this is very good!, and smiled.')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'punctuation-target-confirm',
      operationId: 'punctuation-target-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'edit.proposal.response')
  if (committed?.type === 'edit.proposal.response') {
    assert.equal(committed.outcome, 'committed')
    assert.equal(committed.snapshot?.cleanText, 'She said “this is very good!, and smiled.')
  }
})

test('offers explicit choices for paragraph-resolvable ambiguity without mutating the draft', async () => {
  const userId = 'unsafe-edit-user'
  const chatId = 'unsafe-edit-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Same phrase.\n\nSame phrase.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Ambiguous replacement.',
    operations: [
      { id: 'ambiguous', type: 'replace', target: { exactText: 'Same phrase' }, text: 'Changed' },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'unsafe-edit-interpret',
      operationId: 'unsafe-edit-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace same phrase with changed.',
    },
    userId,
  )
  const interpretationPrompt = generationRequests.at(-1)?.messages?.[0]?.content ?? ''
  assert.match(
    interpretationPrompt,
    /application will present those occurrences as explicit choices/,
  )
  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.candidates.response')
  if (response?.type !== 'edit.candidates.response') return
  assert.deepEqual(
    response.candidateSet.candidates.map(({ paragraphOrdinal }) => paragraphOrdinal),
    [1, 2],
  )
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidate.select.request',
      requestId: 'unsafe-edit-select',
      operationId: 'unsafe-edit-operation',
      chatId,
      expectedVersion: 1,
      candidateId: response.candidateSet.candidates[1]!.id,
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response') {
    assert.equal(proposal.proposal.beforeText, 'Same phrase.\n\nSame phrase.')
    assert.equal(proposal.proposal.afterText, 'Same phrase.\n\nChanged.')
    assert.equal(proposal.snapshot, undefined)
  }
})

test('interprets an explicit new-paragraph command deterministically', async () => {
  const userId = 'paragraph-insert-user'
  const chatId = 'paragraph-insert-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.')
  responses.length = 0
  generationRequests.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'paragraph-insert-interpret',
      operationId: 'paragraph-insert-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Insert a new paragraph after paragraph 2 that says, The route has been approved.',
    },
    userId,
  )
  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(
      response.proposal.afterText,
      'First paragraph.\n\nSecond paragraph.\n\nThe route has been approved.\n\nThird paragraph.',
    )
  }
  assert.equal(generationRequests.length, 0)
})

test('learns explicit spelling from an approved edit but not from its proposal', async () => {
  const userId = 'edit-spelling-user'
  const chatId = 'edit-spelling-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'The project codename is Cesar.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Apply the explicitly spelled codename.',
    operations: [
      {
        id: 'spell-caesar',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'Cesar' },
        text: 'Caesar',
      },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-spelling-interpret',
      operationId: 'edit-spelling-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace Cesar with C-A-E-S-A-R, Caesar.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.learningCandidates.some(({ canonical }) => canonical === 'Caesar'),
    true,
  )

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.load.request',
      requestId: 'glossary-before-edit-confirm',
    },
    userId,
  )
  const before = responses.at(-1)?.payload
  assert.equal(before?.type === 'phase4.state.response' && before.glossary.length, 0)

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'edit-spelling-confirm',
      operationId: 'edit-spelling-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'edit.proposal.response')
  if (committed?.type === 'edit.proposal.response') {
    assert.equal(committed.snapshot?.cleanText, 'The project codename is Caesar.')
    assert.equal(
      committed.glossaryLearned?.some(({ canonical }) => canonical === 'Caesar'),
      true,
    )
  }
})

test('uses authoritative explicit spelling instead of inserting the spelling cue', async () => {
  const userId = 'authoritative-edit-spelling-user'
  const chatId = 'authoritative-edit-spelling-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'The project codename is Kalora.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Apply the explicit spelling.',
    operations: [
      {
        id: 'spell-caelora',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'Kalora' },
        text: 'C-A-E-L-O-R-A, Calora.',
      },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'authoritative-edit-spelling-interpret',
      operationId: 'authoritative-edit-spelling-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'In paragraph 1, replace Calora with capitalized C-A-E-L-O-R-A, Calora.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response') {
    assert.equal(proposal.proposal.afterText, 'The project codename is Caelora.')
    assert.deepEqual(proposal.proposal.learningCandidates, [
      { canonical: 'Caelora', spokenVariant: 'C-A-E-L-O-R-A' },
    ])
  }
})

test('keeps a one-time explanatory reference out of replacement text and glossary learning', async () => {
  const userId = 'reference-edit-user'
  const chatId = 'reference-edit-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Please ask can the worker for help.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Use the Barbie reference only to disambiguate Ken.',
    operations: [
      {
        id: 'reference-ken',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'can the worker' },
        text: 'Ken the worker',
      },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'reference-edit-interpret',
      operationId: 'reference-edit-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Where I said can the worker, I meant Ken the worker. Ken, as in Barbie and Ken.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response') {
    assert.equal(proposal.proposal.afterText, 'Please ask Ken the worker for help.')
    assert.equal(proposal.proposal.afterText.includes('Barbie'), false)
    assert.equal(proposal.proposal.learningCandidates.length, 0)
  }
})

test('recovers a referential homophone when speech-to-text collapses target and replacement', async () => {
  const userId = 'collapsed-reference-user'
  const chatId = 'collapsed-reference-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Please ask can the worker for help.')
  responses.length = 0
  generationRequests.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'collapsed-reference-interpret',
      operationId: 'collapsed-reference-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'In paragraph 1, replace Ken the worker with Ken the worker. Ken, as in Barbie and Ken, is only a reference for the name.',
    },
    userId,
  )
  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, 'Please ask Ken the worker for help.')
    assert.equal(response.proposal.afterText.includes('Barbie'), false)
  }
  assert.equal(generationRequests.length, 0)
})

test('requires a repeated intended token before treating as in as a reference cue', async () => {
  const userId = 'guarded-reference-user'
  const chatId = 'guarded-reference-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Please ask can the worker for help.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'guarded-reference-interpret',
      operationId: 'guarded-reference-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'In paragraph 1, replace Ken the worker with Ken the worker. Ken, as in the character from Barbie, is only a reference for the name.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'app.error')
  if (response?.type === 'app.error') assert.equal(response.code, 'EDIT_INTERPRETATION_FAILED')
  assert.equal(generationRequests.length, 1)
})

test('allows as in when it is explicit replacement text rather than a reference cue', async () => {
  const userId = 'literal-as-in-edit-user'
  const chatId = 'literal-as-in-edit-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Use placeholder here.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Insert the requested literal wording.',
    operations: [
      {
        id: 'literal-as-in-replacement',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'placeholder' },
        text: 'as in the previous example',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'literal-as-in-edit-interpret',
      operationId: 'literal-as-in-edit-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace placeholder with as in the previous example.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, 'Use as in the previous example here.')
  }
})

test('rejects malformed messages without replying', async () => {
  await dispatch({ type: 'untrusted' }, 'malformed-user')
  assert.equal(responses.length, 0)
  assert.equal(warnings.length, 1)
})

async function seedDraft(userId: string, chatId: string, cleanText: string): Promise<void> {
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: `seed-${userId}`,
      operationId: `seed-operation-${userId}`,
      chatId,
      expectedVersion: 0,
      editGroupId: `seed-group-${userId}`,
      cleanText,
    },
    userId,
  )
}

function sendRequest(chatId: string, operationId: string) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'draft.send.request' as const,
    requestId: `request-${operationId}`,
    operationId,
    chatId,
    expectedVersion: 1,
  }
}

function recordingAppendRequest(
  chatId: string,
  operationId: string,
  expectedVersion: number,
  rawTranscript: string,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'transcript.normalize.request' as const,
    requestId: `request-${operationId}`,
    operationId,
    chatId,
    expectedVersion,
    rawTranscript,
  }
}

async function normalizeAndConfirmRecording(
  request: ReturnType<typeof recordingAppendRequest>,
  userId: string,
): Promise<void> {
  await dispatch(request, userId)
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'transcript.normalization.response')
  if (proposal?.type !== 'transcript.normalization.response') return
  assert.equal(proposal.outcome, 'review')
  assert.equal(proposal.snapshot, undefined)
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: `confirm-${request.operationId}`,
      operationId: request.operationId,
      chatId: request.chatId,
      expectedVersion: request.expectedVersion,
    },
    userId,
  )
}

async function dispatch(payload: unknown, userId: string): Promise<void> {
  assert.ok(frontendHandler)
  frontendHandler(payload, userId, `frontend-${userId}`)
  await settleAsyncWork()
}

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
