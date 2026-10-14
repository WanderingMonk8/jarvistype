import assert from 'node:assert/strict'
import test from 'node:test'

import { PROTOCOL_VERSION, type BackendResponse } from '../src/protocol/messages'

type FrontendHandler = (payload: unknown, userId: string, frontendSessionId?: string) => void

const responses: Array<{ payload: BackendResponse; userId?: string }> = []
const warnings: string[] = []
const stored = new Map<string, unknown>()
const appended: Array<{ chatId: string; content: string; triggerGeneration: boolean }> = []
let frontendHandler: FrontendHandler | null = null
let activeChatId: string | null = 'chat-default'
let appendShouldFail = false

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
  appended.length = 0
  activeChatId = 'chat-default'
  appendShouldFail = false
})

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

async function dispatch(payload: unknown, userId: string): Promise<void> {
  assert.ok(frontendHandler)
  frontendHandler(payload, userId, `frontend-${userId}`)
  await settleAsyncWork()
}

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
