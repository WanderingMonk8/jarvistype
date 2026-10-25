import assert from 'node:assert/strict'
import test from 'node:test'

import { applyManualEdit, restoreDraftSession } from '../src/domain/draft-session'
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
const decisionRequests: unknown[] = []
let decisionsEnabled = false
let decisionProbability = 0
let frontendHandler: FrontendHandler | null = null
let activeChatId: string | null = 'chat-default'
let appendShouldFail = false
let appendAcknowledgementGate: Promise<void> | null = null
let generationReturnsRawTranscript = false
let generationNormalizedText: string | null = null
let generationEditsOverride: unknown[] | null = null
let generationCommandDecisions: unknown[] = []
let editPlanResponse: unknown = null
let grammarRepairResponse: unknown = null
let grammarRepairHangs = false
let grammarRepairIgnoresAbort = false
let grammarRepairSignal: AbortSignal | undefined
let chatMessages: Array<{
  role: 'system' | 'user' | 'assistant'
  content: unknown
  metadata?: Record<string, unknown>
}> = []

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
    getGranted: () =>
      Promise.resolve([
        'media',
        'chats',
        'chat_mutation',
        'generation',
        'characters',
        ...(decisionsEnabled ? ['decisions'] : []),
      ]),
    has: (permission: string) =>
      ['media', 'chats', 'chat_mutation', 'generation', 'characters'].includes(permission) ||
      (permission === 'decisions' && decisionsEnabled),
  },
  decisions: {
    listConnections: () =>
      Promise.resolve(
        decisionsEnabled
          ? [
              {
                id: 'jev-default',
                name: 'Decision model',
                provider: 'test',
                api_url: 'http://localhost',
                model: 'jev-test',
                is_default: true,
                has_api_key: true,
                default_parameters: {},
                metadata: {},
                created_at: 0,
                updated_at: 0,
              },
            ]
          : [],
      ),
    evaluate: (request: unknown) => {
      decisionRequests.push(request)
      return Promise.resolve({
        model: 'jev-test',
        answers: {
          introducedGrammarError: { type: 'noul', noul: decisionProbability },
        },
      })
    },
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
    get: (chatId: string) =>
      Promise.resolve({
        id: chatId,
        character_id: 'character-1',
        name: 'Test',
        metadata: {},
        created_at: 0,
        updated_at: 0,
      }),
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
  characters: {
    get: () => Promise.resolve({ id: 'character-1', name: 'Aiko' }),
  },
  chat: {
    getMessages: () => Promise.resolve(chatMessages),
    appendMessage: async (
      chatId: string,
      message: { content: string },
      options?: { triggerGeneration?: boolean },
    ) => {
      if (appendShouldFail) throw new Error('provider failure')
      appended.push({
        chatId,
        content: message.content,
        triggerGeneration: options?.triggerGeneration === true,
      })
      if (appendAcknowledgementGate) await appendAcknowledgementGate
      return { id: `message-${appended.length}`, generationId: 'generation-1' }
    },
  },
  generate: {
    quiet: (request: {
      connection_id?: string
      parameters?: Record<string, unknown>
      messages?: Array<{ content: string }>
      signal?: AbortSignal
    }) => {
      generationRequests.push(request)
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as {
        candidate?: string
        rawTranscript?: string
        task?: string
      }
      if (input.task === 'Interpret this edit instruction against the numbered draft.')
        return Promise.resolve({ content: JSON.stringify(editPlanResponse) })
      if (input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.') {
        if (!grammarRepairHangs)
          return Promise.resolve({ content: JSON.stringify(grammarRepairResponse) })
        grammarRepairSignal = request.signal
        if (grammarRepairIgnoresAbort) return new Promise(() => undefined)
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true },
          )
        })
      }
      if (generationEditsOverride)
        return Promise.resolve({
          content: JSON.stringify({ edits: generationEditsOverride, commandDecisions: [] }),
        })
      const candidate = input.candidate ?? ''
      const target = generationReturnsRawTranscript
        ? (input.rawTranscript ?? '')
        : (generationNormalizedText ?? candidate)
      let start = 0
      while (
        start < candidate.length &&
        start < target.length &&
        candidate[start] === target[start]
      )
        start += 1
      let end = 0
      while (
        end < candidate.length - start &&
        end < target.length - start &&
        candidate[candidate.length - 1 - end] === target[target.length - 1 - end]
      )
        end += 1
      const editAt = (from: number) => ({
        find: candidate.slice(from, candidate.length - end),
        replace: target.slice(from, target.length - end),
      })
      let edit = editAt(start)
      if (!edit.find && start > 0) edit = editAt(start - 1)
      return Promise.resolve({
        content: JSON.stringify({
          edits: candidate === target ? [] : [edit],
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
  decisionRequests.length = 0
  decisionsEnabled = false
  decisionProbability = 0
  activeChatId = 'chat-default'
  appendShouldFail = false
  appendAcknowledgementGate = null
  generationReturnsRawTranscript = false
  generationNormalizedText = null
  generationEditsOverride = null
  generationCommandDecisions = []
  editPlanResponse = null
  grammarRepairResponse = null
  grammarRepairHangs = false
  grammarRepairIgnoresAbort = false
  grammarRepairSignal = undefined
  chatMessages = []
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

test('an explicit load refreshes a draft changed through shared storage on another device', async () => {
  const userId = 'cross-device-load-user'
  const chatId = 'cross-device-load-chat'
  await seedDraft(userId, chatId, 'Desktop draft')

  const storageKey = `${userId}:draft-${encodeURIComponent(chatId)}.json`
  const persisted = restoreDraftSession(stored.get(storageKey), chatId)
  assert.ok(persisted)
  const externalMutation = applyManualEdit(persisted, 'Mobile draft', {
    expectedVersion: persisted.draftVersion,
    editGroupId: 'mobile-edit-group',
  })
  assert.equal(externalMutation.applied, true)
  stored.set(storageKey, structuredClone(externalMutation.session))

  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.load.request',
      requestId: 'cross-device-refresh',
      chatId,
    },
    userId,
  )

  const refreshed = responses.at(-1)?.payload
  assert.equal(refreshed?.type, 'draft.snapshot.response')
  if (refreshed?.type === 'draft.snapshot.response') {
    assert.equal(refreshed.snapshot.cleanText, 'Mobile draft')
    assert.equal(refreshed.snapshot.draftVersion, 2)
  }
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
        grammarRepairMode: 'off',
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
    recordingAppendRequest(chatId, 'selected-connection-segment', 1, 'Plain speach text'),
    userId,
  )

  assert.equal(generationRequests.length, 1)
  assert.equal(generationRequests[0]?.connection_id, normalizationConnection.id)
  assert.equal(generationRequests[0]?.parameters?.model, 'custom-text-model')
})

test('reports whether a decision model connection is available for the when-needed check', async () => {
  const userId = 'decisions-availability-user'
  const settingsRequest = (requestId: string) => ({
    protocolVersion: PROTOCOL_VERSION,
    type: 'phase4.settings.update.request' as const,
    requestId,
    settings: {
      contextMessageCount: 5,
      contextualNormalizationEnabled: true,
      grammarRepairMode: 'when_needed' as const,
      normalizationConnectionId: null,
      normalizationModelOverride: '',
    },
  })

  decisionsEnabled = false
  await dispatch(settingsRequest('decisions-availability-missing'), userId)
  const missing = responses.at(-1)?.payload
  assert.equal(missing?.type, 'phase4.state.response')
  if (missing?.type === 'phase4.state.response') assert.equal(missing.decisionModelAvailable, false)

  decisionsEnabled = true
  await dispatch(settingsRequest('decisions-availability-present'), userId)
  const present = responses.at(-1)?.payload
  assert.equal(present?.type, 'phase4.state.response')
  if (present?.type === 'phase4.state.response') assert.equal(present.decisionModelAvailable, true)
  decisionsEnabled = false
})

test('uses local command context with compact conversational spelling references', async () => {
  const userId = 'split-context-user'
  const chatId = 'split-context-chat'
  activeChatId = chatId
  chatMessages = [
    { role: 'assistant', content: 'Captain Caelora Venn leads the Northern Survey.' },
    { role: 'user', content: 'Tell me more about her work.' },
    { role: 'assistant', content: 'She is mapping the coast near Port Meridian.' },
    { role: 'user', content: 'Continue that account.' },
  ]
  await seedDraft(userId, chatId, 'This draft content must not enter the normalization prompt.')

  await dispatch(
    recordingAppendRequest(chatId, 'split-context-segment', 1, 'She reached the harbor speach'),
    userId,
  )

  const request = generationRequests.at(-1)
  const prompt = JSON.parse(request?.messages?.at(-1)?.content ?? '{}') as Record<string, unknown>
  assert.equal('recentReferenceContext' in prompt, false)
  assert.equal(JSON.stringify(prompt).includes('Continue that account'), false)
  assert.ok(Array.isArray(prompt.conversationReferences))
  assert.ok(prompt.conversationReferences.includes('Caelora'))
  assert.ok(prompt.conversationReferences.includes('Northern Survey'))
  assert.equal('currentDraftTail' in prompt, false)
  assert.equal(JSON.stringify(prompt).includes('This draft content must not enter'), false)
})

test('uses an unambiguous recent-chat proper name when the model leaves the STT spelling unchanged', async () => {
  const userId = 'recent-name-user'
  const chatId = 'recent-name-chat'
  activeChatId = chatId
  chatMessages = [
    {
      role: 'assistant',
      content:
        'Yaniko opened her mouth. Kansai raised both hands, then Kansai offered to help with the dishes.',
    },
  ]

  await dispatch(
    recordingAppendRequest(
      chatId,
      'recent-name-segment',
      0,
      'And Kensai looks at me for half a second before getting up to pick up the dishes.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(
      response.proposal.candidateText,
      'And Kansai looks at me for half a second before getting up to pick up the dishes.',
    )
    assert.ok(response.proposal.reasons.includes('recent conversation spelling: Kensai → Kansai'))
  }
})

test('recovers a unique recent-chat name with a stable prefix and mistranscribed ending', async () => {
  const userId = 'recent-name-ending-user'
  const chatId = 'recent-name-ending-chat'
  activeChatId = chatId
  chatMessages = [
    {
      role: 'assistant',
      content: 'Willum notched the reckoning into his tally-stick as he spoke.',
    },
  ]

  await dispatch(
    recordingAppendRequest(
      chatId,
      'recent-name-ending-segment',
      0,
      'As Willie leaves with the lamp, we stay at the table.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(
      response.proposal.candidateText,
      'As Willum leaves with the lamp, we stay at the table.',
    )
    assert.ok(response.proposal.reasons.includes('recent conversation spelling: Willie → Willum'))
  }
})

test('recovers a short possessive character name from recent chat', async () => {
  const userId = 'recent-short-possessive-name-user'
  const chatId = 'recent-short-possessive-name-chat'
  activeChatId = chatId
  chatMessages = [
    {
      role: 'assistant',
      content: 'Kat’s patience finally ran out, and Kat stepped away from the table.',
    },
  ]

  await dispatch(
    recordingAppendRequest(
      chatId,
      'recent-short-possessive-name-segment',
      0,
      "Cat's hands tightened around the cup.",
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type !== 'transcript.normalization.response') return
  assert.equal(response.proposal.candidateText, "Kat's hands tightened around the cup.")
  assert.ok(response.proposal.reasons.includes('recent conversation spelling: Cat → Kat'))
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

test('coalesces a duplicate send while the first acknowledgement is delayed', async () => {
  const userId = 'delayed-send-user'
  const chatId = 'delayed-send-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Delayed acknowledgement marker')
  responses.length = 0

  let releaseAcknowledgement: () => void = () => undefined
  appendAcknowledgementGate = new Promise<void>((resolve) => {
    releaseAcknowledgement = resolve
  })
  const request = sendRequest(chatId, 'delayed-send-operation')
  await dispatch(request, userId)
  assert.equal(appended.length, 1)
  assert.equal(responses.length, 0)

  await dispatch({ ...request, requestId: 'delayed-send-retry' }, userId)
  assert.equal(appended.length, 1)
  assert.equal(responses.length, 0)

  releaseAcknowledgement()
  await settleAsyncWork()
  await settleAsyncWork()
  assert.equal(appended.length, 1)
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

test('appends a reviewed recording onto a concurrently changed same-chat draft', async () => {
  const userId = 'concurrent-recording-user'
  const chatId = 'concurrent-recording-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First device text.')
  responses.length = 0

  await dispatch(
    recordingAppendRequest(chatId, 'concurrent-recording-segment', 1, 'Recorded on mobile.'),
    userId,
  )
  const proposalResponse = responses.at(-1)?.payload
  assert.equal(proposalResponse?.type, 'transcript.normalization.response')
  if (proposalResponse?.type !== 'transcript.normalization.response') return
  assert.equal(proposalResponse.outcome, 'review')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: 'concurrent-desktop-mutation',
      operationId: 'concurrent-desktop-operation',
      chatId,
      expectedVersion: 1,
      editGroupId: 'concurrent-desktop-group',
      cleanText: 'First device text. Updated on desktop.',
    },
    userId,
  )

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: 'concurrent-recording-confirm',
      operationId: proposalResponse.proposal.operationId,
      chatId,
      expectedVersion: proposalResponse.proposal.expectedVersion,
    },
    userId,
  )

  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'transcript.normalization.response')
  if (committed?.type !== 'transcript.normalization.response') return
  assert.equal(committed.outcome, 'committed')
  assert.equal(
    committed.snapshot?.cleanText,
    'First device text. Updated on desktop. Recorded on mobile.',
  )
  assert.equal(committed.snapshot?.draftVersion, 3)
  assert.ok(
    committed.snapshot?.recordingSegments
      .at(-1)
      ?.normalization.reasons.includes('appended after concurrent draft change'),
  )
})

test('reviews a recording against the latest same-chat draft when its starting version is stale', async () => {
  const userId = 'stale-start-recording-user'
  const chatId = 'stale-start-recording-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Original draft.')
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: 'stale-start-newer-draft',
      operationId: 'stale-start-newer-draft-operation',
      chatId,
      expectedVersion: 1,
      editGroupId: 'stale-start-newer-draft-group',
      cleanText: 'Updated from another device.',
    },
    userId,
  )
  responses.length = 0

  await dispatch(
    recordingAppendRequest(chatId, 'stale-start-recording-segment', 1, 'recorded concurrently.'),
    userId,
  )

  const proposalResponse = responses.at(-1)?.payload
  assert.equal(proposalResponse?.type, 'transcript.normalization.response')
  if (proposalResponse?.type !== 'transcript.normalization.response') return
  assert.equal(proposalResponse.outcome, 'review')
  assert.equal(proposalResponse.proposal.expectedVersion, 2)
  assert.equal(proposalResponse.proposal.candidateText, 'Recorded concurrently.')
  assert.ok(proposalResponse.proposal.reasons.includes('normalized against newer same-chat draft'))

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: 'stale-start-recording-confirm',
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
    assert.equal(
      committed.snapshot?.cleanText,
      'Updated from another device. Recorded concurrently.',
    )
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

test('capitalizes a new message opening but preserves a continued sentence across recordings', async () => {
  const newMessageUser = 'capitalized-opening-user'
  const newMessageChat = 'capitalized-opening-chat'
  activeChatId = newMessageChat

  await dispatch(
    recordingAppendRequest(
      newMessageChat,
      'capitalized-opening-segment',
      0,
      'we drift into sleep, holding each other through the night.',
    ),
    newMessageUser,
  )
  const opening = responses.at(-1)?.payload
  assert.equal(opening?.type, 'transcript.normalization.response')
  if (opening?.type === 'transcript.normalization.response') {
    assert.equal(
      opening.proposal.candidateText,
      'We drift into sleep, holding each other through the night.',
    )
  }

  const continuationUser = 'lowercase-continuation-user'
  const continuationChat = 'lowercase-continuation-chat'
  activeChatId = continuationChat
  await seedDraft(continuationUser, continuationChat, 'We drift into sleep')
  responses.length = 0
  await dispatch(
    recordingAppendRequest(
      continuationChat,
      'lowercase-continuation-segment',
      1,
      'and wake together.',
    ),
    continuationUser,
  )
  const continuation = responses.at(-1)?.payload
  assert.equal(continuation?.type, 'transcript.normalization.response')
  if (continuation?.type === 'transcript.normalization.response') {
    assert.equal(continuation.proposal.candidateText, 'and wake together.')
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

test('uses normal casing for unmodified explicit spelling', async () => {
  const userId = 'default-spelling-casing-user'
  const chatId = 'default-spelling-casing-chat'
  activeChatId = chatId
  responses.length = 0

  await dispatch(
    recordingAppendRequest(chatId, 'default-spelling-casing-segment', 0, 'Use C-O-O-L-E-Y period'),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type !== 'transcript.normalization.response') return
  assert.equal(response.outcome, 'review')
  assert.equal(response.proposal.candidateText, 'Use cooley.')
  assert.deepEqual(response.proposal.learningCandidates, [
    { canonical: 'cooley', spokenVariant: 'C-O-O-L-E-Y' },
  ])
  assert.deepEqual(response.proposal.ambiguities, [])
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

test('recovers a mistranscribed closing speech alias in the normalization proposal', async () => {
  const userId = 'fuzzy-speech-alias-user'
  const chatId = 'fuzzy-speech-alias-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0

  await dispatch(
    recordingAppendRequest(
      chatId,
      'fuzzy-speech-alias-segment',
      1,
      'Begin speech. No. I do not play Wonderful. I play jazz, though. So, I guess you can name your price and speech.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type !== 'transcript.normalization.response') return
  assert.equal(
    response.proposal.candidateText,
    '“No. I do not play Wonderful. I play jazz, though. So, I guess you can name your price”.',
  )
  assert.ok(response.proposal.reasons.includes('fuzzy spoken command recovery'))
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
    assert.equal(response.proposal.candidateText, 'She said “Proceed carefully”.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('does not let contextual normalization duplicate speech quotation marks', async () => {
  const userId = 'duplicated-speech-quotes-user'
  const chatId = 'duplicated-speech-quotes-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationRequests.length = 0
  generationNormalizedText =
    '““Yeah, no offense, but you do look like you have had a long day. Everything all right?”'

  await dispatch(
    recordingAppendRequest(
      chatId,
      'duplicated-speech-quotes-segment',
      1,
      'Begin speech. Yeah, no offense, but you do look like you have had a long day. Everything all right? End speech.',
      'double',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(
      response.proposal.candidateText,
      '“Yeah, no offense, but you do look like you have had a long day. Everything all right?”',
    )
    assert.equal(response.proposal.contextualModelUsed, false)
    assert.ok(response.proposal.reasons.includes('deterministic quotation fast path'))
    assert.equal(response.proposal.reasons.includes('streamed quotation command recovery'), false)
  }
  assert.equal(generationRequests.length, 0)
})

test('does not let contextual normalization duplicate single quotation marks', async () => {
  const userId = 'duplicated-single-quotes-user'
  const chatId = 'duplicated-single-quotes-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationRequests.length = 0
  generationNormalizedText = '‘‘A private thought.’'

  await dispatch(
    recordingAppendRequest(
      chatId,
      'duplicated-single-quotes-segment',
      1,
      'Begin single. A private thought. End single.',
      'single',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.candidateText, '‘A private thought.’')
    assert.equal(response.proposal.contextualModelUsed, false)
    assert.ok(response.proposal.reasons.includes('deterministic quotation fast path'))
    assert.equal(response.proposal.reasons.includes('streamed quotation command recovery'), false)
  }
  assert.equal(generationRequests.length, 0)
})

test('rejects mixed-style duplicate quotes from contextual normalization', async () => {
  const userId = 'mixed-duplicate-quotes-user'
  const chatId = 'mixed-duplicate-quotes-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationNormalizedText = 'She said \u201c"Proceed carefully\u201d.'

  await dispatch(
    recordingAppendRequest(
      chatId,
      'mixed-duplicate-quotes-segment',
      1,
      'She said quote proceed carefully quote period',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.proposal.candidateText, 'She said \u201cProceed carefully\u201d.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('formats an opening produced by a spoken quote command', async () => {
  const userId = 'formatted-commanded-quotes-user'
  const chatId = 'formatted-commanded-quotes-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0

  await dispatch(
    recordingAppendRequest(
      chatId,
      'formatted-commanded-quotes-segment',
      1,
      'quote, and I am not going anywhere quote.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.outcome, 'review')
    assert.equal(response.proposal.candidateText, '“And I am not going anywhere”.')
    assert.equal(response.proposal.contextualModelUsed, false)
  }
})

test('recovers paired boundary quotations observed only in the streaming transcript', async () => {
  const userId = 'streamed-boundary-quotes-user'
  const chatId = 'streamed-boundary-quotes-chat'
  activeChatId = chatId

  await dispatch(
    recordingAppendRequest(
      chatId,
      'streamed-boundary-quotes-segment',
      0,
      'No offense, but you do look like you have had a long day.',
      'double',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(
      response.proposal.rawTranscript,
      'No offense, but you do look like you have had a long day.',
    )
    assert.equal(
      response.proposal.candidateText,
      '“No offense, but you do look like you have had a long day.”',
    )
    assert.ok(response.proposal.reasons.includes('streamed quotation command recovery'))
  }
})

test('does not append a second period after a punctuated spoken quotation', async () => {
  const userId = 'closing-quote-period-user'
  const chatId = 'closing-quote-period-chat'
  activeChatId = chatId

  await dispatch(
    recordingAppendRequest(
      chatId,
      'closing-quote-period-segment',
      0,
      'quote I am not going anywhere. quote.',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.proposal.candidateText, '“I am not going anywhere.”')
  }
})

test('calls the contextual provider for every recording outside the quotation fast path', async () => {
  const userId = 'contextual-always-user'
  const chatId = 'contextual-always-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  generationEditsOverride = [{ find: 'beta', replace: 'BETA' }]

  generationRequests.length = 0
  await dispatch(
    recordingAppendRequest(chatId, 'contextual-always-plain', 1, 'Alpha beta gamma delta.'),
    userId,
  )
  let response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  assert.equal(generationRequests.length, 1)
  if (response?.type === 'transcript.normalization.response')
    assert.match(response.proposal.candidateText, /BETA/)

  generationRequests.length = 0
  await dispatch(
    recordingAppendRequest(chatId, 'contextual-always-signal', 2, 'Alpha beta gamma speach delta.'),
    userId,
  )
  response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  assert.equal(generationRequests.length, 1)
  generationEditsOverride = null
})

test('rejects ambiguous or missing contextual edits and keeps the deterministic candidate', async () => {
  const userId = 'contextual-edit-fallback-user'
  const chatId = 'contextual-edit-fallback-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier')
  responses.length = 0
  for (const edits of [
    [{ find: 'beta', replace: 'BETA' }],
    [{ find: 'missing phrase', replace: 'BETA' }],
  ]) {
    generationEditsOverride = edits
    await dispatch(
      recordingAppendRequest(
        chatId,
        `contextual-edit-fallback-${edits.length}`,
        1,
        'Alpha beta. Alpha beta.',
      ),
      userId,
    )
    const response = responses.at(-1)?.payload
    assert.equal(response?.type, 'transcript.normalization.response')
    if (response?.type === 'transcript.normalization.response') {
      assert.doesNotMatch(response.proposal.candidateText, /BETA/)
      assert.equal(response.proposal.contextualModelUsed, false)
    }
  }
  generationEditsOverride = null
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

test('keeps provider question punctuation instead of appending a spoken period', async () => {
  const userId = 'provider-question-punctuation-user'
  const chatId = 'provider-question-punctuation-chat'
  activeChatId = chatId

  await dispatch(
    recordingAppendRequest(
      chatId,
      'provider-question-punctuation-segment',
      0,
      "All right. How's that? period",
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.proposal.candidateText, "All right. How's that?")
    assert.ok(response.proposal.reasons.includes('provider terminal punctuation'))
  }
})

test('removes a provider-rendered period after existing question punctuation', async () => {
  const userId = 'provider-rendered-period-user'
  const chatId = 'provider-rendered-period-chat'
  activeChatId = chatId

  await dispatch(
    recordingAppendRequest(
      chatId,
      'provider-rendered-period-segment',
      0,
      'All right. How is that? ."',
    ),
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'transcript.normalization.response')
  if (response?.type === 'transcript.normalization.response') {
    assert.equal(response.proposal.candidateText, 'All right. How is that?"')
    assert.ok(response.proposal.reasons.includes('provider terminal punctuation'))
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

test('commits a chat-owned edit when the host global active chat drifts before approval', async () => {
  const userId = 'edit-global-active-drift-user'
  const chatId = 'edit-global-active-drift-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Digging a hole, it can disrupt the bugs living there.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the opening phrase.',
    operations: [
      {
        id: 'delete-opening-phrase-after-active-drift',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: 'Digging a hole' },
      },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-global-active-drift-interpret',
      operationId: 'edit-global-active-drift-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Remove the phrase digging a hole.',
    },
    userId,
  )
  assert.equal(responses.at(-1)?.payload.type, 'edit.proposal.response')

  activeChatId = 'host-global-chat-from-another-client'
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'edit-global-active-drift-confirm',
      operationId: 'edit-global-active-drift-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )

  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'edit.proposal.response')
  if (committed?.type !== 'edit.proposal.response') return
  assert.equal(committed.outcome, 'committed')
  assert.equal(committed.snapshot?.cleanText, 'It can disrupt the bugs living there.')
})

test('extends a sentence-targeted paragraph break through terminal punctuation', async () => {
  const userId = 'sentence-split-user'
  const chatId = 'sentence-split-chat'
  activeChatId = chatId
  const original =
    'Opening sentence. The brief eruption of discussion seemed to die down once more, and the general passivity returned to campus. Friday arrived.'
  await seedDraft(userId, chatId, original)
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Split after the requested sentence.',
    operations: [
      {
        id: 'split-discussion-sentence',
        type: 'split',
        target: {
          paragraphOrdinal: 1,
          exactText: 'The brief eruption of discussion seemed to die down once more,',
        },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'sentence-split-interpret',
      operationId: 'sentence-split-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Break the paragraph after the sentence about the brief eruption of discussion.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.plan.operations[0]?.includeTrailingPunctuation, true)
  assert.equal(
    proposal.proposal.afterText,
    'Opening sentence. The brief eruption of discussion seemed to die down once more, and the general passivity returned to campus.\n\nFriday arrived.',
  )
})

test('deletes the first sentence when identical text also appears last', async () => {
  const userId = 'duplicate-sentence-user'
  const chatId = 'duplicate-sentence-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Quotation. Okay, you are really cutting deep here. Quotation.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the first sentence.',
    operations: [
      {
        id: 'delete-duplicate-first-sentence',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: 'Quotation.' },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'duplicate-sentence-interpret',
      operationId: 'duplicate-sentence-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the first sentence.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.deepEqual(proposal.proposal.plan.operations[0]?.target, {
    sentenceOrdinal: 1,
  })
  assert.equal(proposal.proposal.afterText, 'Okay, you are really cutting deep here. Quotation.')
})

test('treats take off as a positional sentence deletion command', async () => {
  const userId = 'take-off-sentence-user'
  const chatId = 'take-off-sentence-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Quotation. Keep this sentence. Quotation.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Take off the first sentence.',
    operations: [
      {
        id: 'take-off-first-sentence',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: 'Quotation.' },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'take-off-sentence-interpret',
      operationId: 'take-off-sentence-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Take off the first sentence.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.deepEqual(proposal.proposal.plan.operations[0]?.target, {
    sentenceOrdinal: 1,
  })
  assert.equal(proposal.proposal.afterText, 'Keep this sentence. Quotation.')
})

test('takes off identical first and last sentences in one compound instruction', async () => {
  const userId = 'compound-duplicate-sentence-user'
  const chatId = 'compound-duplicate-sentence-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Quotation. Okay, you are really cutting deep here. Quotation.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'compound-duplicate-sentence-interpret',
      operationId: 'compound-duplicate-sentence-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Take off the first and last sentences.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.deepEqual(
    proposal.proposal.plan.operations.map((operation) => operation.target),
    [{ sentenceOrdinal: 1 }, { sentenceFromEnd: 1 }],
  )
  assert.equal(proposal.proposal.afterText, 'Okay, you are really cutting deep here.')
  assert.equal(
    generationRequests.some(
      (request) =>
        JSON.parse(request.messages?.at(-1)?.content ?? '{}').task ===
        'Interpret this edit instruction against the numbered draft.',
    ),
    false,
  )
})

test('deletes one positional sentence without a provider interpretation', async () => {
  const userId = 'single-sentence-deletion-user'
  const chatId = 'single-sentence-deletion-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First sentence. Second sentence. And speech.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'single-sentence-deletion-interpret',
      operationId: 'single-sentence-deletion-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the last sentence.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.deepEqual(
    proposal.proposal.plan.operations.map((operation) => operation.target),
    [{ sentenceFromEnd: 1 }],
  )
  assert.equal(proposal.proposal.afterText, 'First sentence. Second sentence.')
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Interpret this edit instruction against the numbered draft.'
    }).length,
    0,
  )
})

test('puts quotation marks around a spoken text range without a provider call', async () => {
  const userId = 'quotation-range-user'
  const chatId = 'quotation-range-chat'
  activeChatId = chatId
  const draft =
    "“Well, someone's got to do the planning around here, so I have to be practical while taking care of you.” I load the groceries in the small trunk of my sapphire blue Miata, then I open the passenger side door for her before walking over to the driver's seat. All right, dear, this is a fun ride, but not the most comfortable, just letting you know. Emphasis on fun."
  await seedDraft(userId, chatId, draft)
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'quotation-range-interpret',
      operationId: 'quotation-range-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'put quotations from all right, dear, to emphasis on fun.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    `“Well, someone's got to do the planning around here, so I have to be practical while taking care of you.” I load the groceries in the small trunk of my sapphire blue Miata, then I open the passenger side door for her before walking over to the driver's seat. “All right, dear, this is a fun ride, but not the most comfortable, just letting you know. Emphasis on fun.”`,
  )
  assert.deepEqual(
    proposal.proposal.plan.operations.map((operation) => operation.type),
    ['insert_before', 'insert_after'],
  )
  assert.equal(generationRequests.length, 0)
})

test('quotes a range ending at a repeated phrase inside the paragraph', async () => {
  const userId = 'quotation-range-repeated-end-user'
  const chatId = 'quotation-range-repeated-end-chat'
  activeChatId = chatId
  const draft =
    "I set the grocery bags on the counter, and I'm already moving. I go to the cabinet to take out some plates that have been unused for some time, and take another bowl from it, and begin mixing the flour for pancakes. As I work, I carefully narrate the process. The batter begins to take shape as I mix in more ingredients such as eggs, sugar, and milk. It becomes a viscous and fluffy mix, and gradually becomes doughy. Yes, the syrup, I got the good kind. You see, most of the syrup you get from the store aren't real syrup. This is from Canada, real syrup."
  await seedDraft(userId, chatId, draft)
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'quotation-range-repeated-end-interpret',
      operationId: 'quotation-range-repeated-end-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'put quotations from the sentence, Yes, the syrup to real syrup.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  const expected = draft.replace(
    'Yes, the syrup, I got the good kind.',
    '“Yes, the syrup, I got the good kind.',
  )
  assert.equal(proposal.proposal.afterText, `${expected}”`)
  assert.equal(proposal.proposal.afterText.endsWith('\n”'), false)
  assert.equal(generationRequests.length, 0)
})

test('quotes a range ending at a positional last sentence inside the paragraph', async () => {
  const userId = 'quotation-range-last-sentence-user'
  const chatId = 'quotation-range-last-sentence-chat'
  activeChatId = chatId
  const draft =
    "I mix the batter. Yes, the syrup, I got the good kind. You see, most of the syrup you get from the store aren't real syrup. This is from Canada, real syrup."
  await seedDraft(userId, chatId, draft)
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'quotation-range-last-sentence-interpret',
      operationId: 'quotation-range-last-sentence-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put quotations from the phrase Yes, the syrup to the last sentence.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    "I mix the batter. “Yes, the syrup, I got the good kind. You see, most of the syrup you get from the store aren't real syrup. This is from Canada, real syrup.”",
  )
  assert.deepEqual(
    proposal.proposal.plan.operations.map((operation) => operation.target),
    [{ exactText: 'Yes, the syrup', occurrence: 1 }, { sentenceFromEnd: 1 }],
  )
  assert.equal(generationRequests.length, 0)
})

test('supports single style and before-after quotation ranges', async () => {
  const userId = 'quotation-range-single-user'
  const chatId = 'quotation-range-single-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Intro sentence. Start here and end there. Tail.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'quotation-range-single-interpret',
      operationId: 'quotation-range-single-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'put single quotations before start here and after end there',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response') {
    assert.equal(proposal.proposal.afterText, 'Intro sentence. ‘Start here and end there.’ Tail.')
  }
})

test('inserts quotation marks around an exact sentence target', async () => {
  const userId = 'exact-sentence-quotation-user'
  const chatId = 'exact-sentence-quotation-chat'
  activeChatId = chatId
  const draft =
    '“Yeah, Round Midnight is a special tune. I play it, like you said, in all kinds of moods.” I pick up the paper cup and gulp down the coffee in one courageous move. Let out a long breath, the grimace returning fully. All right, this is some special coffee. Well, anyway, yeah, your whole discography.'
  await seedDraft(userId, chatId, draft)
  responses.length = 0
  generationRequests.length = 0

  const cases = [
    [
      'Insert quotes before the sentence, All right, this is some special coffee.',
      draft.replace(
        'All right, this is some special coffee.',
        '“All right, this is some special coffee.',
      ),
    ],
    [
      'Insert a quotation mark after the sentence, All right, this is some special coffee.',
      draft.replace(
        'All right, this is some special coffee.',
        'All right, this is some special coffee.”',
      ),
    ],
    [
      'Put quotation marks around the sentence, All right, this is some special coffee.',
      draft.replace(
        'All right, this is some special coffee.',
        '“All right, this is some special coffee.”',
      ),
    ],
  ] as const
  for (const [index, [instructionTranscript, expected]] of cases.entries()) {
    responses.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `exact-sentence-quotation-interpret-${index}`,
        operationId: `exact-sentence-quotation-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type === 'edit.proposal.response') {
      assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    }
  }
  assert.equal(generationRequests.length, 0)
})

test('deletes a sentence identified by its spoken text', async () => {
  const userId = 'sentence-text-deletion-user'
  const chatId = 'sentence-text-deletion-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    "Well, someone's got to do the planning. End speech. I load the groceries. Begin speech. All right, dear.",
  )
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'sentence-text-deletion-interpret',
      operationId: 'sentence-text-deletion-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the sentence Begin speech.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    "Well, someone's got to do the planning. End speech. I load the groceries. All right, dear.",
  )
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Interpret this edit instruction against the numbered draft.'
    }).length,
    0,
  )
})

test('supports sentence-text deletion aliases and quoted targets', async () => {
  const userId = 'sentence-text-deletion-alias-user'
  const chatId = 'sentence-text-deletion-alias-chat'
  activeChatId = chatId
  const draft = 'First sentence. Begin speech. Last sentence.'
  const cases = [
    ['Delete the sentence that says Begin speech.', 'First sentence. Last sentence.'],
    ['Remove the sentence saying Begin speech.', 'First sentence. Last sentence.'],
    ['Erase the sentence, “Begin speech.”', 'First sentence. Last sentence.'],
    ['In paragraph 1, take off the sentence Begin speech.', 'First sentence. Last sentence.'],
  ] as const
  for (const [index, [instructionTranscript, expected]] of cases.entries()) {
    await seedDraft(userId, `${chatId}-${index}`, draft)
    activeChatId = `${chatId}-${index}`
    responses.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `sentence-text-deletion-alias-interpret-${index}`,
        operationId: `sentence-text-deletion-alias-operation-${index}`,
        chatId: `${chatId}-${index}`,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type === 'edit.proposal.response') {
      assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    }
  }
})

test('deletes positional sentences across every alias and paragraph scope', async () => {
  const userId = 'sentence-deletion-alias-user'
  const chatId = 'sentence-deletion-alias-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First one. First two.\n\nSecond one. Second two. Second three.')
  responses.length = 0
  generationRequests.length = 0

  const cases = [
    [
      'In paragraph 2, delete the first sentence.',
      'First one. First two.\n\nSecond two. Second three.',
    ],
    [
      'Remove the second sentence in paragraph 2.',
      'First one. First two.\n\nSecond one. Second three.',
    ],
    [
      'Take off the final sentence of paragraph 2.',
      'First one. First two.\n\nSecond one. Second two.',
    ],
    ['Erase the last sentence.', 'First one. First two.\n\nSecond one. Second two.'],
    [
      'Please remove the second sentence in paragraph 2.',
      'First one. First two.\n\nSecond one. Second three.',
    ],
    ['Cut the first sentence.', 'First two.\n\nSecond one. Second two. Second three.'],
    [
      'Delete the penultimate sentence in paragraph 2.',
      'First one. First two.\n\nSecond one. Second three.',
    ],
  ] as const
  for (const [index, [instructionTranscript, expected]] of cases.entries()) {
    responses.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `sentence-deletion-alias-interpret-${index}`,
        operationId: `sentence-deletion-alias-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type === 'edit.proposal.response') {
      assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    }
  }
  assert.equal(generationRequests.length, 0)
})

test('deletes positional paragraphs without a provider interpretation', async () => {
  const userId = 'paragraph-deletion-position-user'
  const chatId = 'paragraph-deletion-position-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First.\n\nSecond.\n\nThird.')
  responses.length = 0
  generationRequests.length = 0

  const cases = [
    ['Delete the last paragraph.', 'First.\n\nSecond.'],
    ['Remove paragraph 2.', 'First.\n\nThird.'],
    ['Take off the penultimate paragraph.', 'First.\n\nThird.'],
    ['Erase the first paragraph.', 'Second.\n\nThird.'],
  ] as const
  for (const [index, [instructionTranscript, expected]] of cases.entries()) {
    responses.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `paragraph-deletion-position-interpret-${index}`,
        operationId: `paragraph-deletion-position-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type === 'edit.proposal.response') {
      assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    }
  }
  assert.equal(generationRequests.length, 0)
})

test('reviews and commits whole-paragraph deletion without leaving separator whitespace', async () => {
  const userId = 'delete-paragraph-user'
  const chatId = 'delete-paragraph-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First paragraph.\n\nSecond paragraph.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the first paragraph.',
    operations: [{ id: 'delete-first-paragraph', type: 'delete', target: { paragraphOrdinal: 1 } }],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'delete-paragraph-interpret',
      operationId: 'delete-paragraph-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the first paragraph.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'Second paragraph.')

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'delete-paragraph-confirm',
      operationId: 'delete-paragraph-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'edit.proposal.response')
  if (committed?.type !== 'edit.proposal.response') return
  assert.equal(committed.outcome, 'committed')
  assert.equal(committed.snapshot?.cleanText, 'Second paragraph.')
  assert.equal(committed.snapshot?.paragraphs.length, 1)
})

test('returns the authoritative snapshot when an edit proposal version becomes stale', async () => {
  const userId = 'stale-edit-proposal-user'
  const chatId = 'stale-edit-proposal-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First paragraph.\n\nSecond paragraph.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the first paragraph.',
    operations: [{ id: 'stale-delete-first', type: 'delete', target: { paragraphOrdinal: 1 } }],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'stale-edit-interpret',
      operationId: 'stale-edit-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the first paragraph.',
    },
    userId,
  )
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.mutate.request',
      requestId: 'stale-edit-manual-mutation',
      operationId: 'stale-edit-manual-operation',
      chatId,
      expectedVersion: 1,
      editGroupId: 'stale-edit-manual-group',
      cleanText: 'First paragraph revised.\n\nSecond paragraph.',
    },
    userId,
  )
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'stale-edit-confirm',
      operationId: 'stale-edit-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )

  const expired = responses.at(-1)?.payload
  assert.equal(expired?.type, 'app.error')
  if (expired?.type !== 'app.error') return
  assert.equal(expired.code, 'EDIT_PROPOSAL_EXPIRED')
  assert.match(expired.message, /advanced to version 2/)
  assert.equal(expired.snapshot?.draftVersion, 2)
  assert.equal(expired.snapshot?.cleanText, 'First paragraph revised.\n\nSecond paragraph.')
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
  assert.equal(proposal.proposal.afterText, 'She said “this is very good! and smiled.')

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
    assert.equal(committed.snapshot?.cleanText, 'She said “this is very good! and smiled.')
  }
})

test('resolves “last” punctuation from the end even when the model counts incorrectly', async () => {
  const userId = 'last-punctuation-user'
  const chatId = 'last-punctuation-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    'I nod at Toggard and consider the offer. “Yes, we will take the inn. We will stay away for now. We are not ready to confront them”.',
  )
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the last period in the paragraph.',
    operations: [
      {
        id: 'delete-last-period',
        type: 'delete',
        target: { paragraphOrdinal: 1, punctuation: 'period', occurrence: 3 },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'last-punctuation-interpret',
      operationId: 'last-punctuation-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the last period of this paragraph.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'I nod at Toggard and consider the offer. “Yes, we will take the inn. We will stay away for now. We are not ready to confront them”',
  )
  assert.equal(proposal.proposal.plan.operations[0]?.target.occurrence, undefined)
  assert.equal(proposal.proposal.plan.operations[0]?.target.occurrenceFromEnd, 1)
})

test('removes terminal punctuation when a short sentence is deleted', async () => {
  const userId = 'short-sentence-delete-user'
  const chatId = 'short-sentence-delete-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Enough! We should continue.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the short sentence.',
    operations: [
      {
        id: 'delete-short-sentence',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: 'Enough' },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'short-sentence-delete-interpret',
      operationId: 'short-sentence-delete-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the sentence Enough.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'We should continue.')
  assert.equal(proposal.proposal.plan.operations[0]?.includeTrailingPunctuation, true)
})

test('relocates terminal punctuation with an explicitly targeted short sentence', async () => {
  const userId = 'short-sentence-move-user'
  const chatId = 'short-sentence-move-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Enough! Continue now.\n\nLater.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Move the short sentence after Later.',
    operations: [
      {
        id: 'move-short-sentence',
        type: 'move_after',
        target: { paragraphOrdinal: 1, exactText: 'Enough' },
        destination: { paragraphOrdinal: 2, exactText: 'Later.' },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'short-sentence-move-interpret',
      operationId: 'short-sentence-move-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Relocate the sentence Enough after the sentence Later.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'Continue now.\n\nLater. Enough!')
  assert.equal(proposal.proposal.plan.operations[0]?.includeTrailingPunctuation, true)
})

test('uses chat references for newly dictated edit text without changing the draft target', async () => {
  const userId = 'edit-reference-user'
  const chatId = 'edit-reference-chat'
  activeChatId = chatId
  chatMessages = [
    {
      role: 'assistant',
      content: 'Willum notched the reckoning into his tally-stick as he spoke.',
    },
  ]
  await seedDraft(userId, chatId, 'As Willie leaves with the lamp, we stay at the table.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace Willie with the dictated name.',
    operations: [
      {
        id: 'replace-name-from-context',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'Willie' },
        text: 'Willem',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-reference-interpret',
      operationId: 'edit-reference-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace Willie with Willem.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'As Willum leaves with the lamp, we stay at the table.')
  assert.equal(proposal.proposal.plan.operations[0]?.target.exactText, 'Willie')
  assert.equal(proposal.proposal.plan.operations[0]?.text, 'Willum')

  assert.equal(generationRequests.length, 0)
})

test('keeps explicit edit spelling authoritative over a similar chat reference', async () => {
  const userId = 'edit-reference-spelling-user'
  const chatId = 'edit-reference-spelling-chat'
  activeChatId = chatId
  chatMessages = [
    {
      role: 'assistant',
      content: 'Willum notched the reckoning into his tally-stick as he spoke.',
    },
  ]
  await seedDraft(userId, chatId, 'The traveler arrives.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace the traveler with the explicitly spelled name.',
    operations: [
      {
        id: 'replace-explicit-name',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'traveler' },
        text: 'Willie',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-reference-spelling-interpret',
      operationId: 'edit-reference-spelling-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace traveler with W-I-L-L-I-E, Willie.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response') {
    assert.equal(proposal.proposal.afterText, 'The Willie arrives.')
    assert.equal(proposal.proposal.plan.operations[0]?.text, 'Willie')
  }
})

test('replaces one exact word deterministically when the edit model returns no plan', async () => {
  const userId = 'deterministic-simple-replacement-user'
  const chatId = 'deterministic-simple-replacement-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'He leaned closer. “The engine needs repair,” she muttered.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = null

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'deterministic-simple-replacement-interpret',
      operationId: 'deterministic-simple-replacement-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace muttered with needs you.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'He leaned closer. “The engine needs repair,” she needs you.',
  )
  assert.deepEqual(proposal.proposal.plan.operations[0]?.target, { exactText: 'muttered' })
  assert.equal(proposal.proposal.plan.operations[0]?.text, 'needs you')
  assert.equal(
    generationRequests.some(
      (request) =>
        JSON.parse(request.messages?.at(-1)?.content ?? '{}').task ===
        'Interpret this edit instruction against the numbered draft.',
    ),
    false,
  )
})

test('inserts deterministically after a sentence label with punctuation-insensitive targeting', async () => {
  const userId = 'deterministic-inline-insertion-user'
  const chatId = 'deterministic-inline-insertion-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'She answered, “So, yeah.”')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = null

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'deterministic-inline-insertion-interpret',
      operationId: 'deterministic-inline-insertion-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Insert after the sentence so yeah, with Are you clocking out soon?',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'She answered, “So, yeah.” Are you clocking out soon?')
  assert.deepEqual(proposal.proposal.plan.operations[0]?.target, { exactText: 'so yeah' })
  assert.equal(proposal.proposal.plan.operations[0]?.text, 'Are you clocking out soon?')
})

test('removes an unquoted phrase label from deterministic replacement text', async () => {
  const userId = 'deterministic-phrase-label-user'
  const chatId = 'deterministic-phrase-label-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'She pauses, then my voice mutters.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = null

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'deterministic-phrase-label-interpret',
      operationId: 'deterministic-phrase-label-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Replace the phrase My voice mutters with the phrase My voice needs you.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'She pauses, then my voice needs you.')
  assert.equal(proposal.proposal.plan.operations[0]?.text, 'My voice needs you')
  assert.equal(generationRequests.length, 0)
})

test('preserves a phrase label when it is inside quoted replacement text', async () => {
  const userId = 'deterministic-literal-phrase-label-user'
  const chatId = 'deterministic-literal-phrase-label-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Use placeholder here.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'deterministic-literal-phrase-label-interpret',
      operationId: 'deterministic-literal-phrase-label-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace placeholder with “the phrase needs you”.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response') {
    assert.equal(proposal.proposal.afterText, 'Use the phrase needs you here.')
  }
})

test('falls back to one fuzzy draft target when the provider compounds a split phrase', async () => {
  const userId = 'fuzzy-target-user'
  const chatId = 'fuzzy-target-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    'I look at her long body stretched out on bare feet. Mao let her in return and step off the bed.',
  )
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace the provider-compounded phrase using its unique fuzzy match.',
    operations: [
      {
        id: 'replace-fuzzy-phrase',
        type: 'replace',
        target: { exactText: 'mouthlet' },
        text: 'I smile at',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'fuzzy-target-interpret',
      operationId: 'fuzzy-target-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace the phrase mouthlet with I smile at.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response') {
    assert.equal(
      proposal.proposal.afterText,
      'I look at her long body stretched out on bare feet. I smile at her in return and step off the bed.',
    )
    assert.equal(proposal.proposal.operations[0]?.beforeText, 'Mao let')
  }
})

test('replaces a positional sentence without a provider interpretation', async () => {
  const userId = 'sentence-replacement-user'
  const chatId = 'sentence-replacement-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    'First sentence. Second sentence. So, I guess you can name your price and speech.',
  )
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'sentence-replacement-interpret',
      operationId: 'sentence-replacement-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Replace the last sentence with, so I guess you can name your price now.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'First sentence. Second sentence. So I guess you can name your price now.',
  )
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Interpret this edit instruction against the numbered draft.'
    }).length,
    0,
  )
})

test('replaces a positional sentence scoped to a paragraph', async () => {
  const userId = 'scoped-sentence-replacement-user'
  const chatId = 'scoped-sentence-replacement-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    'First paragraph. Still first.\n\nSecond paragraph. Last one here.',
  )
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'scoped-sentence-replacement-interpret',
      operationId: 'scoped-sentence-replacement-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'In paragraph 2, replace the first sentence with Hello there.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'First paragraph. Still first.\n\nHello there. Last one here.',
  )
})

test('keeps beginning and end insertions inside the targeted paragraph', async () => {
  const userId = 'paragraph-boundary-user'
  const chatId = 'paragraph-boundary-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Starting right, not starting over.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Put quotation marks around the paragraph.',
    operations: [
      {
        id: 'opening-quote',
        type: 'insert_before',
        target: { paragraphOrdinal: 1 },
        text: '"',
      },
      {
        id: 'closing-quote',
        type: 'insert_after',
        target: { paragraphOrdinal: 1 },
        text: '"',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'paragraph-boundary-interpret',
      operationId: 'paragraph-boundary-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put quotes at the beginning and the end of this paragraph.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, '"Starting right, not starting over."')
    assert.deepEqual(
      response.proposal.plan.operations.map((operation) => operation.type),
      ['prepend', 'append'],
    )
  }
})

test('puts one pair of quotations around a numbered paragraph instead of each sentence', async () => {
  const userId = 'deterministic-paragraph-quotation-user'
  const chatId = 'deterministic-paragraph-quotation-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First sentence. Second sentence. Third sentence.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'deterministic-paragraph-quotation-interpret',
      operationId: 'deterministic-paragraph-quotation-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put quotations around the paragraph 1.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, '“First sentence. Second sentence. Third sentence.”')
    assert.deepEqual(
      response.proposal.plan.operations.map((operation) => operation.type),
      ['prepend', 'append'],
    )
  }
  assert.equal(generationRequests.length, 0)
})

test('supports every alias and word order of the paragraph quotation command', async () => {
  const userId = 'paragraph-quotation-alias-user'
  const chatId = 'paragraph-quotation-alias-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First paragraph text.')
  responses.length = 0
  generationRequests.length = 0

  const instructions = [
    'Put quotations around the first paragraph.',
    'Put quotation marks around the first paragraph.',
    'Put quote marks around the first paragraph.',
    'Put quotes around the first paragraph.',
    'Place quotations around the first paragraph.',
    'Add quotes to the first paragraph.',
    'Surround the first paragraph with quotes.',
    'Wrap the first paragraph in quotation marks.',
    'Put the first paragraph in quotes.',
    'Quote the first paragraph.',
    'Put quote marks on the first paragraph.',
    'Put quotation marks before and after the first paragraph.',
    'Put quotation marks at the beginning and end of the first paragraph.',
  ]
  for (const [index, instructionTranscript] of instructions.entries()) {
    responses.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `paragraph-quotation-alias-interpret-${index}`,
        operationId: `paragraph-quotation-alias-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const response = responses.at(-1)?.payload
    assert.equal(response?.type, 'edit.proposal.response', instructionTranscript)
    if (response?.type === 'edit.proposal.response') {
      assert.equal(response.proposal.afterText, '“First paragraph text.”', instructionTranscript)
    }
  }
  assert.equal(generationRequests.length, 0)
})

test('supports single-style paragraph quotations', async () => {
  const userId = 'paragraph-quotation-single-user'
  const chatId = 'paragraph-quotation-single-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First paragraph text.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'paragraph-quotation-single-interpret',
      operationId: 'paragraph-quotation-single-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put single quotation marks around the first paragraph.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, '‘First paragraph text.’')
  }
})

test('supports last and penultimate paragraph quotation positions', async () => {
  const userId = 'paragraph-quotation-position-user'
  const chatId = 'paragraph-quotation-position-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'paragraph-quotation-last-interpret',
      operationId: 'paragraph-quotation-last-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put quotes around the last paragraph.',
    },
    userId,
  )
  const last = responses.at(-1)?.payload
  assert.equal(last?.type, 'edit.proposal.response')
  if (last?.type === 'edit.proposal.response') {
    assert.equal(
      last.proposal.afterText,
      'First paragraph.\n\nSecond paragraph.\n\n“Third paragraph.”',
    )
  }

  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'paragraph-quotation-penultimate-interpret',
      operationId: 'paragraph-quotation-penultimate-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put quotes around the penultimate paragraph.',
    },
    userId,
  )
  const penultimate = responses.at(-1)?.payload
  assert.equal(penultimate?.type, 'edit.proposal.response')
  if (penultimate?.type === 'edit.proposal.response') {
    assert.equal(
      penultimate.proposal.afterText,
      'First paragraph.\n\n“Second paragraph.”\n\nThird paragraph.',
    )
  }
})

test('capitalizes append and insert-after text only after sentence-ending targets', async () => {
  const userId = 'after-insertion-casing-user'
  const chatId = 'after-insertion-casing-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First.\n\nSecond. End.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Preserve dictated casing in after-position insertions.',
    operations: [
      {
        id: 'append-lowercase',
        type: 'append',
        target: { paragraphOrdinal: 1 },
        text: 'continued',
      },
      {
        id: 'insert-after-lowercase',
        type: 'insert_after',
        target: { paragraphOrdinal: 2, exactText: 'Second.' },
        text: 'quietly',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'after-insertion-casing-interpret',
      operationId: 'after-insertion-casing-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Append continued to paragraph 1 and insert quietly after Second in paragraph 2.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type !== 'edit.proposal.response') return
  assert.equal(response.proposal.afterText, 'First. Continued\n\nSecond. Quietly End.')
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
  assert.equal(generationRequests.length, 0)
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

test('offers choices for multiple fuzzy sentence targets in one paragraph', async () => {
  const userId = 'fuzzy-candidate-user'
  const chatId = 'fuzzy-candidate-chat'
  activeChatId = chatId
  const draft =
    "Well, someone's got to do the planning around here. End speech. I load the groceries. Begin speech. All right, dear. Emphasis on fun. End speech."
  await seedDraft(userId, chatId, draft)
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'fuzzy-candidate-interpret',
      operationId: 'fuzzy-candidate-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the sentence and speech.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.candidates.response')
  if (response?.type !== 'edit.candidates.response') return
  assert.equal(generationRequests.length, 0)
  assert.deepEqual(
    response.candidateSet.candidates.map(({ paragraphOrdinal }) => paragraphOrdinal),
    [1, 1],
  )
  assert.notEqual(
    response.candidateSet.candidates[0]?.preview,
    response.candidateSet.candidates[1]?.preview,
  )
  assert.equal(response.candidateSet.candidates[0]?.exactText, 'End speech')
  assert.equal(stored.has(`${userId}:edit-candidates-${encodeURIComponent(chatId)}.json`), true)

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidate.select.request',
      requestId: 'fuzzy-candidate-select',
      operationId: 'fuzzy-candidate-operation',
      chatId,
      expectedVersion: 1,
      candidateId: response.candidateSet.candidates[1]!.id,
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    "Well, someone's got to do the planning around here. End speech. I load the groceries. Begin speech. All right, dear. Emphasis on fun.",
  )

  // Selecting again must still work: the candidate context is persisted and is
  // not discarded when the first proposal is prepared.
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidate.select.request',
      requestId: 'fuzzy-candidate-select-retry',
      operationId: 'fuzzy-candidate-operation',
      chatId,
      expectedVersion: 1,
      candidateId: response.candidateSet.candidates[1]!.id,
    },
    userId,
  )
  const retried = responses.at(-1)?.payload
  assert.equal(retried?.type, 'edit.proposal.response')
  if (retried?.type === 'edit.proposal.response') {
    assert.equal(retried.proposal.afterText, proposal.proposal.afterText)
  }
})

test('interprets an explicit add-new-paragraph synonym deterministically', async () => {
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
        'Add a new paragraph after paragraph 2 that says, The route has been approved.',
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

test('normalizes spoken punctuation only inside newly inserted edit content', async () => {
  const userId = 'edit-input-punctuation-user'
  const chatId = 'edit-input-punctuation-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Placeholder.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace the placeholder with the newly dictated content.',
    operations: [
      {
        id: 'replace-with-dictated-content',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'Placeholder.' },
        text: 'First thought period new paragraph Second thought period',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-input-punctuation-interpret',
      operationId: 'edit-input-punctuation-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Replace Placeholder with First thought period new paragraph Second thought period.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, 'First thought.\n\nSecond thought.')
    assert.equal(response.proposal.plan.operations[0]?.target.exactText, 'Placeholder.')
  }
})

test('preserves natural punctuation words inside newly inserted edit content', async () => {
  const userId = 'edit-input-literal-user'
  const chatId = 'edit-input-literal-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First paragraph.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'edit-input-literal-interpret',
      operationId: 'edit-input-literal-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Insert a new paragraph after paragraph 1 that says, The period of growth challenged everyone period',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(
      response.proposal.afterText,
      'First paragraph.\n\nThe period of growth challenged everyone.',
    )
  }
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

test('restores explicit casing after the edit interpreter collapses spelled letters', async () => {
  const userId = 'collapsed-edit-spelling-casing-user'
  const chatId = 'collapsed-edit-spelling-casing-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'I arrive Safeway on the cooley and begin browsing.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Apply the explicitly requested casing.',
    operations: [
      {
        id: 'capitalize-cooley',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'cooley' },
        text: 'COOLEY',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'collapsed-edit-spelling-casing-interpret',
      operationId: 'collapsed-edit-spelling-casing-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace cooley with capitalized C-O-O-L-E-Y.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'I arrive Safeway on the Cooley and begin browsing.')
  assert.equal(proposal.proposal.plan.operations[0]?.text, 'Cooley')
  assert.deepEqual(proposal.proposal.learningCandidates, [
    { canonical: 'Cooley', spokenVariant: 'C-O-O-L-E-Y' },
  ])
})

test('keeps apostrophe-s lowercase in capitalized explicit spelling during editing', async () => {
  const userId = 'possessive-edit-spelling-user'
  const chatId = 'possessive-edit-spelling-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Judy’s hair tightens around cats.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Apply the explicitly spelled possessive.',
    operations: [
      {
        id: 'spell-kats',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'cats' },
        text: "Kat'S",
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'possessive-edit-spelling-interpret',
      operationId: 'possessive-edit-spelling-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace cats with capitalized K-A-T-apostrophe-S.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'Judy’s hair tightens around Kat’s.')
  assert.deepEqual(proposal.proposal.learningCandidates, [
    { canonical: 'Kat’s', spokenVariant: 'K-A-T’S' },
  ])
})

test('uses normal casing for unmodified explicit spelling in edit input', async () => {
  const userId = 'default-edit-spelling-casing-user'
  const chatId = 'default-edit-spelling-casing-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'The project codename is Kalora.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Apply the explicit spelling.',
    operations: [
      {
        id: 'spell-cooley',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'Kalora' },
        text: 'COOLEY',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'default-edit-spelling-casing-interpret',
      operationId: 'default-edit-spelling-casing-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'In paragraph 1, replace Kalora with C-O-O-L-E-Y.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'The project codename is cooley.')
  assert.deepEqual(proposal.proposal.learningCandidates, [
    { canonical: 'cooley', spokenVariant: 'C-O-O-L-E-Y' },
  ])
})

test('preserves sentence casing when replacing an opening phrase', async () => {
  const userId = 'replacement-target-casing-user'
  const chatId = 'replacement-target-casing-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Opening phrase continues into the draft.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace the opening phrase.',
    operations: [
      {
        id: 'replace-opening-phrase',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'Opening phrase' },
        text: 'replacement words',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'replacement-target-casing-interpret',
      operationId: 'replacement-target-casing-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace Opening phrase with replacement words.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'Replacement words continues into the draft.')
})

test('splits compound instructions into deterministic clauses without swallowing later commands', async () => {
  const userId = 'compound-clause-user'
  const chatId = 'compound-clause-chat'
  activeChatId = chatId
  const draft =
    'I slide the cooked pancake onto a plate with my spatula. You know, what you said about the real people. Now, do you wanna give it a try? I will show you how to tilt the pan. You just use the spatula. What do you say? End speech.'
  const cases: Array<readonly [string, string]> = [
    [
      'Remove the sentence and speech, and then put quotations from the phrase, you know to what do you say.',
      'I slide the cooked pancake onto a plate with my spatula. “You know, what you said about the real people. Now, do you wanna give it a try? I will show you how to tilt the pan. You just use the spatula. What do you say?”',
    ],
    [
      'Remove the sentence and speech, and then replace tilt with lift.',
      'I slide the cooked pancake onto a plate with my spatula. You know, what you said about the real people. Now, do you wanna give it a try? I will show you how to lift the pan. You just use the spatula. What do you say?',
    ],
  ]
  for (const [index, [instructionTranscript, expected]] of cases.entries()) {
    await seedDraft(userId, chatId, draft)
    responses.length = 0
    generationRequests.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `compound-clause-interpret-${index}`,
        operationId: `compound-clause-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type !== 'edit.proposal.response') return
    assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    assert.equal(generationRequests.length, 0, instructionTranscript)
  }
})

test('removes adjacent and trailing sentences without leaving stray separators', async () => {
  const userId = 'sentence-separator-user'
  const chatId = 'sentence-separator-chat'
  activeChatId = chatId
  const draft = 'Alpha one. Beta two. Gamma three.\n\nDelta four. Epsilon five.'
  const cases: Array<readonly [string, string]> = [
    ['Remove the sentence Gamma three.', 'Alpha one. Beta two.\n\nDelta four. Epsilon five.'],
    [
      'Remove the sentence Beta two, and then remove the sentence Gamma three.',
      'Alpha one.\n\nDelta four. Epsilon five.',
    ],
    [
      'Replace Beta two with Second and delete the first sentence.',
      'Second. Gamma three.\n\nDelta four. Epsilon five.',
    ],
  ]
  for (const [index, [instructionTranscript, expected]] of cases.entries()) {
    await seedDraft(userId, chatId, draft)
    responses.length = 0
    generationRequests.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `separator-interpret-${index}`,
        operationId: `separator-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type !== 'edit.proposal.response') return
    assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    assert.equal(generationRequests.length, 0, instructionTranscript)
  }
})

test('resolves a misheard “delete and speech” deterministically', async () => {
  const userId = 'delete-and-speech-user'
  const chatId = 'delete-and-speech-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Hello there. Second item. End speech.')
  responses.length = 0
  generationRequests.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'delete-and-speech-interpret',
      operationId: 'delete-and-speech-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete and speech.',
    },
    userId,
  )
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type === 'edit.proposal.response')
    assert.equal(proposal.proposal.afterText, 'Hello there. Second item.')
  assert.equal(generationRequests.length, 0)
})

test('choosing a provider delete candidate removes the whole sentence and its period', async () => {
  const userId = 'provider-delete-candidate-user'
  const chatId = 'provider-delete-candidate-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Keep this. End speech. Middle line. End speech.')
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete end speech.',
    operations: [{ id: 'provider-delete', type: 'delete', target: { exactText: 'End speech' } }],
  }
  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'provider-delete-candidate-interpret',
      operationId: 'provider-delete-candidate-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Take out the closing speech line.',
    },
    userId,
  )
  editPlanResponse = null
  const choice = responses.at(-1)?.payload
  assert.equal(choice?.type, 'edit.candidates.response')
  if (choice?.type !== 'edit.candidates.response') return
  const expected = ['Keep this. Middle line. End speech.', 'Keep this. End speech. Middle line.']
  for (const [index, candidate] of choice.candidateSet.candidates.entries()) {
    responses.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.candidate.select.request',
        requestId: `provider-delete-candidate-select-${index}`,
        operationId: 'provider-delete-candidate-operation',
        chatId,
        expectedVersion: 1,
        candidateId: candidate.id,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response')
    if (proposal?.type === 'edit.proposal.response')
      assert.equal(proposal.proposal.afterText, expected[index], `candidate ${index}`)
  }
})

test('asks for a choice without the provider when “delete and speech” matches twice', async () => {
  const userId = 'delete-and-speech-duplicate-user'
  const chatId = 'delete-and-speech-duplicate-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'End speech. Middle line. End speech.')
  responses.length = 0
  generationRequests.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'delete-and-speech-duplicate-interpret',
      operationId: 'delete-and-speech-duplicate-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete and speech.',
    },
    userId,
  )
  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.candidates.response')
  assert.equal(generationRequests.length, 0)
})

test('every replace alias works deterministically with and without polite wording', async () => {
  const userId = 'replace-alias-user'
  const chatId = 'replace-alias-chat'
  activeChatId = chatId
  const draft = 'The status is pending. Second item.\n\nThird sentence here. Last one.'
  const approved = 'The status is approved. Second item.\n\nThird sentence here. Last one.'
  const cases: Array<readonly [string, string]> = [
    ['Replace pending with approved.', approved],
    ['Change pending to approved.', approved],
    ['Change pending into approved.', approved],
    ['Swap pending with approved.', approved],
    ['Swap pending for approved.', approved],
    ['Substitute pending with approved.', approved],
    ['Substitute pending for approved.', approved],
    ['Change ‘pending’ to ‘approved’ in paragraph 1.', approved],
    ['Please swap pending with approved.', approved],
    ['Replace pending with approved, please.', approved],
    [
      'Replace the first sentence with Hello there.',
      'Hello there. Second item.\n\nThird sentence here. Last one.',
    ],
    [
      'Substitute the third sentence with Fresh start.',
      'The status is pending. Second item.\n\nFresh start. Last one.',
    ],
    [
      'Change the last sentence to Done.',
      'The status is pending. Second item.\n\nThird sentence here. Done.',
    ],
    [
      'Swap the second sentence for New one.',
      'The status is pending. New one.\n\nThird sentence here. Last one.',
    ],
  ]
  for (const [index, [instructionTranscript, expected]] of cases.entries()) {
    await seedDraft(userId, chatId, draft)
    responses.length = 0
    generationRequests.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `replace-alias-interpret-${index}`,
        operationId: `replace-alias-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type !== 'edit.proposal.response') return
    assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    assert.equal(generationRequests.length, 0, instructionTranscript)
  }
})

test('treats remove and trailing please exactly like delete', async () => {
  const userId = 'remove-alias-user'
  const chatId = 'remove-alias-chat'
  activeChatId = chatId
  const draft = 'First one. Very good. Last one.\n\nSecond two. Second three.'
  const instructions = [
    'Delete the sentence very good.',
    'Remove the sentence very good.',
    'Remove the sentence very good, please.',
    'Please remove the sentence very good.',
  ]
  const results: unknown[] = []
  for (const [index, instructionTranscript] of instructions.entries()) {
    await seedDraft(userId, chatId, draft)
    responses.length = 0
    generationRequests.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `remove-alias-interpret-${index}`,
        operationId: `remove-alias-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response')
    if (proposal?.type !== 'edit.proposal.response') return
    results.push(proposal.proposal.afterText)
    assert.equal(generationRequests.length, 0)
  }
  assert.deepEqual(results, [
    'First one. Last one.\n\nSecond two. Second three.',
    'First one. Last one.\n\nSecond two. Second three.',
    'First one. Last one.\n\nSecond two. Second three.',
    'First one. Last one.\n\nSecond two. Second three.',
  ])
})

test('keeps grammar repairs from moving a quotation mark outside the paragraph', async () => {
  const userId = 'quotation-grammar-bound-user'
  const chatId = 'quotation-grammar-bound-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'quotation-grammar-bound-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'always',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  const draft =
    'I mix the batter. Yes, the syrup, I got the good kind. This is from Canada, real syrup.'
  await seedDraft(userId, chatId, draft)
  responses.length = 0
  grammarRepairResponse = {
    edits: [
      {
        segmentId: 'paragraph-1-segment-1',
        find: 'real syrup.',
        replace: 'real syrup.\n\n”',
        reason: 'Moved closing quotation mark.',
      },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'quotation-grammar-bound-interpret',
      operationId: 'quotation-grammar-bound-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put quotations from the phrase Yes, the syrup to the last sentence.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'I mix the batter. “Yes, the syrup, I got the good kind. This is from Canada, real syrup.”',
  )
})

test('applies and discloses an enabled conservative post-edit grammar repair', async () => {
  const userId = 'grammar-repair-user'
  const chatId = 'grammar-repair-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'grammar-repair-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'always',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(
    userId,
    chatId,
    'Earlier one. Earlier two. This is a narrow entrance. Later one. Later two.',
  )
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace narrow with unusual.',
    operations: [
      {
        id: 'replace-adjective',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'narrow' },
        text: 'unusual',
      },
    ],
  }
  grammarRepairResponse = {
    edits: [
      {
        segmentId: 'paragraph-1-segment-1',
        find: 'a unusual',
        replace: 'an unusual',
        reason: 'Changed “a” to “an” before “unusual”.',
      },
    ],
  }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'grammar-repair-interpret',
      operationId: 'grammar-repair-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace narrow with unusual.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'Earlier one. Earlier two. This is an unusual entrance. Later one. Later two.',
  )
  assert.deepEqual(proposal.proposal.grammarRepairChanges, [
    'Changed “a” to “an” before “unusual”.',
  ])
  const grammarRequest = generationRequests.find((request) => {
    const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
    return input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.'
  })
  assert.ok(grammarRequest)
  const grammarInput = JSON.parse(grammarRequest.messages?.at(-1)?.content ?? '{}') as {
    segments?: Array<{ text?: string }>
  }
  assert.deepEqual(
    grammarInput.segments?.map((segment) => segment.text),
    ['Earlier two. This is a unusual entrance. Later one.'],
  )

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: 'grammar-repair-confirm',
      operationId: 'grammar-repair-operation',
      chatId,
      expectedVersion: 1,
    },
    userId,
  )
  const committed = responses.at(-1)?.payload
  assert.equal(committed?.type, 'edit.proposal.response')
  if (committed?.type !== 'edit.proposal.response') return
  assert.equal(committed.outcome, 'committed')
  assert.equal(
    committed.snapshot?.cleanText,
    'Earlier one. Earlier two. This is an unusual entrance. Later one. Later two.',
  )
})

test('falls back to the deterministic edit when grammar repair overreaches', async () => {
  const userId = 'unsafe-grammar-repair-user'
  const chatId = 'unsafe-grammar-repair-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'unsafe-grammar-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'always',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(userId, chatId, 'This is a narrow entrance.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace narrow with accessible.',
    operations: [
      {
        id: 'replace-adjective-unsafely',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'narrow' },
        text: 'accessible',
      },
    ],
  }
  grammarRepairResponse = {
    edits: [
      {
        segmentId: 'paragraph-1-segment-1',
        find: 'This is an accessible entrance.',
        replace: 'A magnificent marble gateway welcomed every traveler into the transformed city.',
        reason: 'Rewrote the paragraph.',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'unsafe-grammar-interpret',
      operationId: 'unsafe-grammar-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace narrow with accessible.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'This is an accessible entrance.')
  assert.equal(proposal.proposal.grammarRepairChanges, undefined)
})

test('skips a routine mid-sentence grammar call in when-needed mode', async () => {
  const userId = 'conditional-grammar-repair-user'
  const chatId = 'conditional-grammar-repair-chat'
  activeChatId = chatId
  decisionsEnabled = true
  decisionProbability = 0.2
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'conditional-grammar-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'when_needed',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(userId, chatId, 'This is a narrow entrance.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace narrow with wide.',
    operations: [
      {
        id: 'replace-routine-adjective',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'narrow' },
        text: 'wide',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'conditional-grammar-interpret',
      operationId: 'conditional-grammar-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace narrow with wide.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'This is a wide entrance.')
  assert.equal(decisionRequests.length, 1)
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.'
    }).length,
    0,
  )
})

test('uses a high Jev probability to invoke bounded grammar repair', async () => {
  const userId = 'jev-gated-grammar-repair-user'
  const chatId = 'jev-gated-grammar-repair-chat'
  activeChatId = chatId
  decisionsEnabled = true
  decisionProbability = 0.9
  grammarRepairResponse = { edits: [] }
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'jev-gated-grammar-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'when_needed',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(userId, chatId, 'This is a narrow entrance.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'jev-gated-grammar-interpret',
      operationId: 'jev-gated-grammar-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace narrow with wide.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'This is a wide entrance.')
  assert.equal(decisionRequests.length, 1)
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.'
    }).length,
    1,
  )
})

test('repairs a deterministic article artifact without a provider call', async () => {
  const userId = 'deterministic-grammar-repair-user'
  const chatId = 'deterministic-grammar-repair-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'deterministic-grammar-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'when_needed',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(userId, chatId, 'This is a narrow entrance.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace narrow with accessible.',
    operations: [
      {
        id: 'replace-article-trigger',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'narrow' },
        text: 'accessible',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'deterministic-grammar-interpret',
      operationId: 'deterministic-grammar-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace narrow with accessible.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'This is an accessible entrance.')
  assert.equal(proposal.proposal.grammarRepairChanges, undefined)
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.'
    }).length,
    0,
  )
})

test('does not treat a domain period as a sentence boundary during cleanup', async () => {
  const userId = 'domain-sentence-boundary-user'
  const chatId = 'domain-sentence-boundary-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Visit example.com for details.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'domain-sentence-boundary-interpret',
      operationId: 'domain-sentence-boundary-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace details with info.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'Visit example.com for info.')
  assert.equal(generationRequests.length, 0)
})

test('rejects a provider casing change to a domain', async () => {
  const userId = 'grammar-domain-user'
  const chatId = 'grammar-domain-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'grammar-domain-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'always',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(userId, chatId, 'Visit example.com for details.')
  responses.length = 0
  generationRequests.length = 0
  grammarRepairResponse = {
    edits: [
      {
        segmentId: 'paragraph-1-segment-1',
        find: 'example.com',
        replace: 'example.Com',
        reason: 'Capitalized the domain.',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'grammar-domain-interpret',
      operationId: 'grammar-domain-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace details with info.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'Visit example.com for info.')
  assert.equal(proposal.proposal.grammarRepairChanges, undefined)
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.'
    }).length,
    1,
  )
})

test('bounds candidate selection when the grammar provider ignores abort', async () => {
  const userId = 'candidate-selection-timeout-user'
  const chatId = 'candidate-selection-timeout-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'candidate-selection-timeout-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'always',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(
    userId,
    chatId,
    'First sentence. End speech. Middle sentence. End speech. Last sentence.',
  )
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'candidate-selection-timeout-interpret',
      operationId: 'candidate-selection-timeout-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the sentence and speech.',
    },
    userId,
  )
  const candidates = responses.at(-1)?.payload
  assert.equal(candidates?.type, 'edit.candidates.response')
  if (candidates?.type !== 'edit.candidates.response') return

  grammarRepairIgnoresAbort = true
  const startedAt = Date.now()
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidate.select.request',
      requestId: 'candidate-selection-timeout-select',
      operationId: 'candidate-selection-timeout-operation',
      chatId,
      expectedVersion: 1,
      candidateId: candidates.candidateSet.candidates[0]!.id,
    },
    userId,
  )
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline && responses.at(-1)?.payload.type !== 'edit.proposal.response')
    await new Promise((resolve) => setTimeout(resolve, 100))
  const elapsed = Date.now() - startedAt
  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  assert.ok(elapsed < 5_500, `selection took ${elapsed} ms`)
})

test('aborts an in-flight grammar request when the operation is cancelled', async () => {
  const userId = 'cancelled-grammar-repair-user'
  const chatId = 'cancelled-grammar-repair-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'cancelled-grammar-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'always',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
      },
    },
    userId,
  )
  await seedDraft(userId, chatId, 'This is a unusual entrance.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace unusual with uncommon.',
    operations: [
      {
        id: 'replace-grammar-hang',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'unusual' },
        text: 'uncommon',
      },
    ],
  }
  grammarRepairHangs = true

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'cancelled-grammar-interpret',
      operationId: 'cancelled-grammar-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace unusual with uncommon.',
    },
    userId,
  )

  assert.ok(grammarRepairSignal)
  assert.equal(grammarRepairSignal.aborted, false)
  assert.equal(
    responses.some((response) => response.payload.type === 'edit.proposal.response'),
    false,
  )

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.operation.cancel',
      requestId: 'cancelled-grammar-cancel',
      targetRequestId: 'cancelled-grammar-interpret',
    },
    userId,
  )
  await settleAsyncWork()

  assert.equal(grammarRepairSignal.aborted, true)
  assert.equal(
    responses.some(
      (response) =>
        response.payload.type === 'edit.proposal.response' || response.payload.type === 'app.error',
    ),
    false,
  )
})

test('cleans local grammar after an edit even when provider repair is off', async () => {
  const userId = 'universal-cleanup-off-user'
  const chatId = 'universal-cleanup-off-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Earlier. This is a wide entrance.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'universal-cleanup-off-interpret',
      operationId: 'universal-cleanup-off-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace wide with accessible.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'Earlier. This is an accessible entrance.')
  assert.equal(proposal.proposal.grammarRepairChanges, undefined)
  assert.equal(generationRequests.length, 0)
})

test('fixes errant punctuation and sentence casing left by an edit', async () => {
  const userId = 'universal-cleanup-punctuation-user'
  const chatId = 'universal-cleanup-punctuation-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First sentence. Second sentence.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Leave errant punctuation and casing for local cleanup.',
    operations: [
      {
        id: 'leave-errant-punctuation',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'Second sentence.' },
        text: 'second sentence.,',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'universal-cleanup-punctuation-interpret',
      operationId: 'universal-cleanup-punctuation-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace Second sentence with second sentence.,',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'First sentence. Second sentence.')
  assert.equal(generationRequests.length, 0)
})

test('removes an orphaned opening separator and capitalizes the remaining sentence locally', async () => {
  const userId = 'opening-phrase-cleanup-user'
  const chatId = 'opening-phrase-cleanup-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'Digging a hole, it can disrupt the bugs living there.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the opening phrase.',
    operations: [
      {
        id: 'delete-opening-phrase',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: 'Digging a hole' },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'opening-phrase-cleanup-interpret',
      operationId: 'opening-phrase-cleanup-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the phrase digging a hole.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'It can disrupt the bugs living there.')
  assert.equal(generationRequests.length, 0)
})

test('removes the duplicate trailing separator when deleting a delimited middle phrase', async () => {
  const userId = 'middle-phrase-cleanup-user'
  const chatId = 'middle-phrase-cleanup-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    'And I say to the sergeant, beginning speech, I have two full sheaves here.',
  )
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Delete the comma-delimited middle phrase.',
    operations: [
      {
        id: 'delete-delimited-middle-phrase',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: 'beginning speech' },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'middle-phrase-cleanup-interpret',
      operationId: 'middle-phrase-cleanup-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Delete the phrase beginning speech.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'And I say to the sergeant, I have two full sheaves here.',
  )
  assert.equal(generationRequests.length, 0)
})

test('does not clean sentences outside the edited sentence', async () => {
  const userId = 'universal-cleanup-scope-user'
  const chatId = 'universal-cleanup-scope-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'this one stays lower. This is a wide entrance.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'universal-cleanup-scope-interpret',
      operationId: 'universal-cleanup-scope-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace wide with accessible.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'this one stays lower. This is an accessible entrance.')
})

test('does not undo an explicit case command with sentence capitalization', async () => {
  const userId = 'universal-cleanup-case-user'
  const chatId = 'universal-cleanup-case-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First sentence. Second sentence.')
  responses.length = 0
  generationRequests.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Lowercase the paragraph.',
    operations: [
      {
        id: 'lowercase-paragraph',
        type: 'case',
        caseMode: 'lowercase',
        target: { paragraphOrdinal: 1 },
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'universal-cleanup-case-interpret',
      operationId: 'universal-cleanup-case-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Lowercase paragraph 1.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'first sentence. second sentence.')
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.'
    }).length,
    0,
  )
})

test('replaces with a qualified as in reference without a provider interpretation', async () => {
  const userId = 'qualified-reference-replacement-user'
  const chatId = 'qualified-reference-replacement-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, "So, I guess you can name your price. I'm in debt to you now.")
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'qualified-reference-replacement-interpret',
      operationId: 'qualified-reference-replacement-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Replace in debt with indebted, as in, you are indebted and therefore owe people money.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    "So, I guess you can name your price. I'm indebted to you now.",
  )
  assert.equal(proposal.proposal.operations[0]?.text, 'indebted')
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Interpret this edit instruction against the numbered draft.'
    }).length,
    0,
  )
})

test('matches an expanded contraction in a referenced edit target', async () => {
  const userId = 'contraction-reference-user'
  const chatId = 'contraction-reference-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    "I set the groceries down on the kitchen counter, and before turning on the light, we're viewing an apartment that is modest but well-kept, neat and clean, perhaps far too clean and neat for a man that she is used to.",
  )
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'contraction-reference-interpret',
      operationId: 'contraction-reference-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        'Replace the phrase We are viewing an apartment with reviewing an apartment, as in reviewing outfits.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(
    proposal.proposal.afterText,
    'I set the groceries down on the kitchen counter, and before turning on the light, reviewing an apartment that is modest but well-kept, neat and clean, perhaps far too clean and neat for a man that she is used to.',
  )
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Interpret this edit instruction against the numbered draft.'
    }).length,
    0,
  )
})

test('inserts a quotation mark at a sentence position without a provider interpretation', async () => {
  const userId = 'sentence-quotation-user'
  const chatId = 'sentence-quotation-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First sentence. Last sentence.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'sentence-quotation-interpret',
      operationId: 'sentence-quotation-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Insert a quotation mark after the last sentence.',
    },
    userId,
  )

  const proposal = responses.at(-1)?.payload
  assert.equal(proposal?.type, 'edit.proposal.response')
  if (proposal?.type !== 'edit.proposal.response') return
  assert.equal(proposal.proposal.afterText, 'First sentence. Last sentence.”')
  assert.equal(
    generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Interpret this edit instruction against the numbered draft.'
    }).length,
    0,
  )
})

test('inserts opening marks and paired quotation marks at sentence positions', async () => {
  const userId = 'sentence-quotation-shapes-user'
  const chatId = 'sentence-quotation-shapes-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'First sentence. Last sentence.')
  responses.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'sentence-quotation-before-interpret',
      operationId: 'sentence-quotation-before-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Insert an opening quotation mark before the first sentence.',
    },
    userId,
  )
  const before = responses.at(-1)?.payload
  assert.equal(before?.type, 'edit.proposal.response')
  if (before?.type === 'edit.proposal.response') {
    assert.equal(before.proposal.afterText, '“First sentence. Last sentence.')
  }

  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'sentence-quotation-around-interpret',
      operationId: 'sentence-quotation-around-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Put quotation marks around the last sentence.',
    },
    userId,
  )
  const around = responses.at(-1)?.payload
  assert.equal(around?.type, 'edit.proposal.response')
  if (around?.type === 'edit.proposal.response') {
    assert.equal(around.proposal.afterText, 'First sentence. “Last sentence.”')
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

test('uses an active-draft name to canonicalize exact replacement casing', async () => {
  const userId = 'draft-reference-payload-user'
  const chatId = 'draft-reference-payload-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'I turned to Watt. I call out to watch.')
  responses.length = 0
  generationRequests.length = 0

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'draft-reference-payload-interpret',
      operationId: 'draft-reference-payload-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace to watch with to watt.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, 'I turned to Watt. I call out to Watt.')
  }
  assert.equal(generationRequests.length, 0)
})

test('rejects an as in reference without an exact repetition or clear inflection', async () => {
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

test('accepts a clear inflection after as in as an explanatory reference', async () => {
  const userId = 'inflected-reference-user'
  const chatId = 'inflected-reference-chat'
  activeChatId = chatId
  await seedDraft(userId, chatId, 'I feel the bucket quickly.')
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace the requested phrase and omit its explanatory reference.',
    operations: [
      {
        id: 'inflected-as-in-replacement',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'I feel' },
        text: 'I filled',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'inflected-reference-interpret',
      operationId: 'inflected-reference-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace I feel with I filled, as in filling something up.',
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(response.proposal.afterText, 'I filled the bucket quickly.')
    assert.equal(response.proposal.afterText.includes('as in'), false)
  }
})

test('removes qualified as in references from every text-bearing edit operation', async () => {
  const userId = 'all-edit-payload-references-user'
  const chatId = 'all-edit-payload-references-chat'
  activeChatId = chatId
  await seedDraft(
    userId,
    chatId,
    'Replace source.\n\nPrepend base.\n\nAppend base.\n\nInsert before base.\n\nInsert after base.',
  )
  responses.length = 0
  editPlanResponse = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Apply every requested phrase while omitting explanatory references.',
    operations: [
      {
        id: 'reference-replace',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'source' },
        text: 'filled, as in filling something up',
      },
      {
        id: 'reference-prepend',
        type: 'prepend',
        target: { paragraphOrdinal: 2 },
        text: "I nod, as in nodding one's head",
      },
      {
        id: 'reference-append',
        type: 'append',
        target: { paragraphOrdinal: 3 },
        text: 'I agree, as in agreeing to proceed',
      },
      {
        id: 'reference-insert-before',
        type: 'insert_before',
        target: { paragraphOrdinal: 4, exactText: 'before' },
        text: 'walk, as in walking',
      },
      {
        id: 'reference-insert-after',
        type: 'insert_after',
        target: { paragraphOrdinal: 5, exactText: 'after' },
        text: 'pause, as in pausing',
      },
    ],
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'all-edit-payload-references-interpret',
      operationId: 'all-edit-payload-references-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript:
        "Replace source with filled, as in filling something up; prepend I nod, as in nodding one's head; append I agree, as in agreeing to proceed; insert walk, as in walking, before before; and insert pause, as in pausing, after after.",
    },
    userId,
  )

  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'edit.proposal.response')
  if (response?.type === 'edit.proposal.response') {
    assert.equal(
      response.proposal.afterText,
      'Replace filled.\n\nI nod Prepend base.\n\nAppend base. I agree\n\nInsert walk before base.\n\nInsert after pause base.',
    )
    assert.equal(response.proposal.afterText.includes('as in'), false)
  }
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

test('defaults collapsed uppercase edit spellings to lowercase and honors an explicit casing cue', async () => {
  const cases: Array<readonly [string, string, string]> = [
    [
      'I slide the arrow into the sheath.',
      'Replace SHEATH with SHEAF.',
      'I slide the arrow into the sheaf.',
    ],
    [
      'I slide the arrow into the sheath.',
      'Replace sheath with sheaf.',
      'I slide the arrow into the sheaf.',
    ],
    ['She said erbold.', 'Replace ERBOLD with uppercase ERBOLD.', 'She said ERBOLD.'],
    ['She said erbold.', 'Replace ERBOLD with capitalized ERBOLD.', 'She said Erbold.'],
    ['She said ERBOLD.', 'Replace ERBOLD with lowercase ERBOLD.', 'She said erbold.'],
    ['She said erbold.', 'Replace ERBOLD with all caps ERBOLD.', 'She said ERBOLD.'],
  ]
  for (const [index, [draft, instructionTranscript, expected]] of cases.entries()) {
    const userId = `compact-edit-spelling-${index}`
    const chatId = `compact-edit-spelling-chat-${index}`
    activeChatId = chatId
    await seedDraft(userId, chatId, draft)
    responses.length = 0
    generationRequests.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `compact-edit-spelling-interpret-${index}`,
        operationId: `compact-edit-spelling-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript,
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', instructionTranscript)
    if (proposal?.type !== 'edit.proposal.response') return
    assert.equal(proposal.proposal.afterText, expected, instructionTranscript)
    assert.equal(generationRequests.length, 0, instructionTranscript)
  }
})

test('restores a known proper noun after explicit spelling in a recording', async () => {
  const cases: Array<readonly [Array<{ role: 'assistant' | 'user'; content: string }>, string]> = [
    [
      [{ role: 'assistant', content: 'Erbold hears it, and his jaw sets.' }],
      'Turn towards Erbold.',
    ],
    [[], 'Turn towards erbold.'],
  ]
  for (const [index, [chat, expected]] of cases.entries()) {
    const userId = `spelled-proper-noun-${index}`
    const chatId = `spelled-proper-noun-chat-${index}`
    activeChatId = chatId
    chatMessages = chat
    await seedDraft(userId, chatId, 'Earlier')
    responses.length = 0
    generationRequests.length = 0
    await dispatch(
      recordingAppendRequest(
        chatId,
        `spelled-proper-noun-segment-${index}`,
        1,
        'Turn towards E-R-B-O-L-D.',
      ),
      userId,
    )
    const response = responses.at(-1)?.payload
    assert.equal(response?.type, 'transcript.normalization.response', `case ${index}`)
    if (response?.type !== 'transcript.normalization.response') return
    assert.equal(response.proposal.candidateText, expected, `case ${index}`)
  }
})

test('restores a known proper noun when a compact uppercase edit spelling defaults to lowercase', async () => {
  const draft =
    "Brenner's voice comes up the lane raw and thin, and it is not an order. It is a report, and Erdl hears it, and his jaw sets."
  const cases: Array<readonly [Array<{ role: 'assistant' | 'user'; content: string }>, string]> = [
    [[{ role: 'assistant', content: 'Erbold hears it, and his jaw sets.' }], 'Erbold'],
    [[], 'erbold'],
  ]
  for (const [index, [chat, expectedName]] of cases.entries()) {
    const userId = `proper-noun-casing-${index}`
    const chatId = `proper-noun-casing-chat-${index}`
    activeChatId = chatId
    chatMessages = chat
    await seedDraft(userId, chatId, draft)
    responses.length = 0
    generationRequests.length = 0
    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `proper-noun-casing-interpret-${index}`,
        operationId: `proper-noun-casing-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript: 'Replace ERDL with ERBOLD.',
      },
      userId,
    )
    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response')
    if (proposal?.type !== 'edit.proposal.response') return
    assert.match(proposal.proposal.afterText, new RegExp(`and ${expectedName} hears it`))
    assert.equal(generationRequests.length, 0)
  }
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

test('collects a copiable backend timing log when debug logging is enabled', async () => {
  const userId = 'debug-log-user'
  const chatId = 'debug-log-chat'
  activeChatId = chatId
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'debug-log-settings',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'off',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
        debugLoggingEnabled: true,
      },
    },
    userId,
  )
  await seedDraft(userId, chatId, 'Earlier one. This is a wide entrance.')
  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'debug.log.request',
      requestId: 'debug-log-clear',
      clear: true,
    },
    userId,
  )
  const cleared = responses.at(-1)?.payload
  assert.equal(cleared?.type, 'debug.log.response')
  if (cleared?.type === 'debug.log.response') {
    assert.equal(
      cleared.entries.some((entry) => entry.includes('[request] start')),
      false,
    )
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'debug-log-first-edit',
      operationId: 'debug-log-first-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace wide with accessible.',
    },
    userId,
  )
  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'debug.log.request',
      requestId: 'debug-log-read',
    },
    userId,
  )
  const response = responses.at(-1)?.payload
  assert.equal(response?.type, 'debug.log.response')
  if (response?.type !== 'debug.log.response') return
  const text = response.entries.join('\n')
  assert.ok(text.includes('# JarvisType debug timing log'))
  assert.match(text, /\[request\] start type=edit\.interpret\.request/u)
  assert.match(text, /request=debug-log-first-edit/u)
  assert.match(text, /\[edit\] start/u)
  assert.match(text, /\[edit\.interpret\]/u)
  assert.match(text, /\[edit\.execute\]/u)
  assert.match(text, /\[grammar\.local\]/u)
  assert.match(text, /\[request\] end type=edit\.interpret\.request/u)
  assert.match(text, /\+\d+\.\dms/u)
  assert.equal(text.includes('entrance'), false)
  assert.equal(text.includes('accessible'), false)

  // Drawing the drawer must not reset the log or add its own settings work.
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.load.request',
      requestId: 'debug-log-drawer-load',
    },
    userId,
  )
  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'debug.log.request',
      requestId: 'debug-log-read-after-drawer',
    },
    userId,
  )
  const afterDrawer = responses.at(-1)?.payload
  assert.equal(afterDrawer?.type, 'debug.log.response')
  if (afterDrawer?.type === 'debug.log.response') {
    const afterDrawerText = afterDrawer.entries.join('\n')
    assert.match(afterDrawerText, /request=debug-log-first-edit/u)
    assert.equal(afterDrawerText.includes('phase4.load'), false)
    assert.equal(afterDrawerText.includes('connections.list'), false)
  }

  // A new user action starts a fresh log.
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: 'debug-log-second-edit',
      operationId: 'debug-log-second-operation',
      chatId,
      expectedVersion: 1,
      instructionTranscript: 'Replace entrance with doorway.',
    },
    userId,
  )
  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'debug.log.request',
      requestId: 'debug-log-read-second',
    },
    userId,
  )
  const secondResponse = responses.at(-1)?.payload
  assert.equal(secondResponse?.type, 'debug.log.response')
  if (secondResponse?.type === 'debug.log.response') {
    const secondText = secondResponse.entries.join('\n')
    assert.match(secondText, /request=debug-log-second-edit/u)
    assert.equal(secondText.includes('debug-log-first-edit'), false)
  }

  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: 'debug-log-settings-off',
      settings: {
        contextMessageCount: 5,
        contextualNormalizationEnabled: true,
        grammarRepairMode: 'off',
        normalizationConnectionId: null,
        normalizationModelOverride: '',
        debugLoggingEnabled: false,
      },
    },
    userId,
  )
  responses.length = 0
  await dispatch(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'debug.log.request',
      requestId: 'debug-log-read-off',
    },
    userId,
  )
  const disabled = responses.at(-1)?.payload
  assert.equal(disabled?.type, 'debug.log.response')
  if (disabled?.type === 'debug.log.response') {
    assert.ok(disabled.entries.some((entry) => entry.includes('Debug logging is currently off.')))
  }
})

test('cleaner end-to-end matrix', async () => {
  interface CleanerCase {
    name: string
    draft: string
    instruction: string
    expected: string
    plan?: unknown
    glossary?: { canonical: string; variants: string[]; hint: string }
  }

  const cases: CleanerCase[] = [
    {
      name: 'article agreement',
      draft: 'Earlier one. This is a wide entrance.',
      instruction: 'Replace wide with accessible.',
      expected: 'Earlier one. This is an accessible entrance.',
    },
    {
      name: 'sentence capitalization',
      draft: 'She waited. the room was quiet.',
      instruction: 'Replace quiet with silent.',
      expected: 'She waited. The room was silent.',
    },
    {
      name: 'repeated word',
      draft: 'The the draft is ready.',
      instruction: 'Replace ready with final.',
      expected: 'The draft is final.',
    },
    {
      name: 'repeated spaces',
      draft: 'This is a very  wide entrance.',
      instruction: 'Replace entrance with doorway.',
      expected: 'This is a very wide doorway.',
    },
    {
      name: 'missing space after a comma',
      draft: "This is fine,isn't it?",
      instruction: 'Replace fine with good.',
      expected: "This is good, isn't it?",
    },
    {
      name: 'spaces inside quotation marks',
      draft: 'He said “ hello ”.',
      instruction: 'Replace said with whispered.',
      expected: 'He whispered “hello”.',
    },
    {
      name: 'spaces inside parentheses',
      draft: 'A ( note ) here.',
      instruction: 'Replace here with there.',
      expected: 'A (note) there.',
    },
    {
      name: 'capitalized article at a sentence opening',
      draft: 'A apple fell.',
      instruction: 'Replace fell with dropped.',
      expected: 'An apple dropped.',
    },
    {
      name: 'errant punctuation after a sentence ending',
      draft: 'This is fine.',
      instruction: 'Replace fine. with good.,',
      expected: 'This is good.',
    },
    {
      name: 'errant question mark punctuation',
      draft: 'This is fine.',
      instruction: 'Replace fine. with “good.?”',
      expected: 'This is good?',
    },
    {
      name: 'repeated period',
      draft: 'This is fine.',
      instruction: 'Replace fine. with “good..”',
      expected: 'This is good.',
    },
    {
      name: 'separator run before a sentence ending',
      draft: 'This is fine.',
      instruction: 'Replace fine. with good;;.',
      expected: 'This is good.',
      plan: {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'Leave separators for local cleanup.',
        operations: [
          {
            id: 'separator-run',
            type: 'replace',
            target: { paragraphOrdinal: 1, exactText: 'fine.' },
            text: 'good;;.',
          },
        ],
      },
    },
    {
      name: 'period before an exclamation mark',
      draft: 'This is fine.',
      instruction: 'Replace fine. with “good.!”',
      expected: 'This is good!',
    },
    {
      name: 'abbreviation guard',
      draft: 'Mr.Smith arrived. He waited.',
      instruction: 'Replace arrived with came.',
      expected: 'Mr.Smith came. He waited.',
    },
    {
      name: 'domain guard',
      draft: 'Visit example.com for details.',
      instruction: 'Replace details with info.',
      expected: 'Visit example.com for info.',
    },
    {
      name: 'url guard',
      draft: 'Open https://example.com/?a=b now.',
      instruction: 'Replace now with today.',
      expected: 'Open https://example.com/?a=b today.',
    },
    {
      name: 'email and dotted identifier guard',
      draft: 'user@example.com is here.',
      instruction: 'Replace here with present.',
      expected: 'user@example.com is present.',
    },
    {
      name: 'speech tag guard',
      draft: 'He said “Stop!” and left.',
      instruction: 'Replace left with stayed.',
      expected: 'He said “Stop!” and stayed.',
    },
    {
      name: 'quoted text casing guard',
      draft: 'He said “this is fine.” and left.',
      instruction: 'Replace left with stayed.',
      expected: 'He said “this is fine.” and stayed.',
    },
    {
      name: 'unaffected sentence scope',
      draft: 'this one stays lower. This is a wide entrance.',
      instruction: 'Replace wide with accessible.',
      expected: 'this one stays lower. This is an accessible entrance.',
    },
    {
      name: 'explicit lowercase command',
      draft: 'First sentence. Second sentence.',
      instruction: 'Lowercase paragraph 1.',
      expected: 'first sentence. second sentence.',
      plan: {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'Lowercase the paragraph.',
        operations: [
          {
            id: 'lowercase-paragraph',
            type: 'case',
            caseMode: 'lowercase',
            target: { paragraphOrdinal: 1 },
          },
        ],
      },
    },
    {
      name: 'protected glossary term',
      draft: 'ebay is here.',
      instruction: 'Replace here with present.',
      expected: 'ebay is present.',
      glossary: { canonical: 'eBay', variants: [], hint: '' },
    },
    {
      name: 'sentence replacement payload',
      draft: 'First sentence. Second sentence. So, I guess you can name your price and speech.',
      instruction: 'Replace the last sentence with, so I guess you can name your price now.',
      expected: 'First sentence. Second sentence. So I guess you can name your price now.',
    },
    {
      name: 'positional sentence deletion',
      draft: 'First sentence. Second sentence. And speech.',
      instruction: 'Delete the last sentence.',
      expected: 'First sentence. Second sentence.',
    },
    {
      name: 'per-command insertion spacing',
      draft: 'First sentence. Second sentence.',
      instruction: 'Insert before the sentence Second with New',
      expected: 'First sentence. New second sentence.',
    },
    {
      name: 'per-command replacement casing',
      draft: 'She said my answer was ready.',
      instruction: 'Replace my answer with My response.',
      expected: 'She said my response was ready.',
    },
    {
      name: 'per-command append spacing',
      draft: 'A list',
      instruction: 'Append of items to paragraph 1.',
      expected: 'A list of items',
      plan: {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'Append the dictated words.',
        operations: [
          {
            id: 'append-words',
            type: 'append',
            target: { paragraphOrdinal: 1 },
            text: 'of items',
          },
        ],
      },
    },
  ]

  for (const [index, testCase] of cases.entries()) {
    const userId = `cleaner-e2e-user-${index}`
    const chatId = `cleaner-e2e-chat-${index}`
    activeChatId = chatId
    responses.length = 0
    generationRequests.length = 0
    editPlanResponse = testCase.plan ?? null
    grammarRepairResponse = null

    if (testCase.glossary) {
      await dispatch(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: 'glossary.upsert.request',
          requestId: `cleaner-e2e-glossary-${index}`,
          ...testCase.glossary,
        },
        userId,
      )
    }

    await seedDraft(userId, chatId, testCase.draft)
    responses.length = 0
    generationRequests.length = 0

    await dispatch(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'edit.interpret.request',
        requestId: `cleaner-e2e-interpret-${index}`,
        operationId: `cleaner-e2e-operation-${index}`,
        chatId,
        expectedVersion: 1,
        instructionTranscript: testCase.instruction,
      },
      userId,
    )

    const proposal = responses.at(-1)?.payload
    assert.equal(proposal?.type, 'edit.proposal.response', testCase.name)
    if (proposal?.type !== 'edit.proposal.response') continue
    assert.equal(proposal.proposal.afterText, testCase.expected, testCase.name)

    const grammarRequests = generationRequests.filter((request) => {
      const input = JSON.parse(request.messages?.at(-1)?.content ?? '{}') as { task?: string }
      return input.task === 'Conservatively repair edit-caused grammar in editable paragraphs.'
    })
    assert.equal(grammarRequests.length, 0, `${testCase.name}: expected no provider grammar pass`)
  }
})

function recordingAppendRequest(
  chatId: string,
  operationId: string,
  expectedVersion: number,
  rawTranscript: string,
  quotationBoundaryHint?: 'double' | 'single',
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'transcript.normalize.request' as const,
    requestId: `request-${operationId}`,
    operationId,
    chatId,
    expectedVersion,
    rawTranscript,
    ...(quotationBoundaryHint ? { quotationBoundaryHint } : {}),
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
