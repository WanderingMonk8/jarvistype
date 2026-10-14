import type { SpindleAPI } from 'lumiverse-spindle-types'

import {
  applyManualEdit,
  clearDraftAfterSend,
  createDraftSession,
  isPersistedDraftSession,
  toDraftSnapshot,
  undoLatestDraftMutation,
  type PersistedDraftSession,
} from './domain/draft-session'
import {
  APP_VERSION,
  PROTOCOL_VERSION,
  type BackendResponse,
  type FrontendRequest,
} from './protocol/messages'
import { isFrontendRequest, sanitizeGrantedPermissions } from './protocol/validation'

declare const spindle: SpindleAPI

interface RequestContext {
  userId: string
  frontendSessionId?: string
}

interface ActiveRequest {
  cancelled: boolean
  cancellable: boolean
}

interface CompletedSend {
  messageIdPresent: true
  generationIdPresent: boolean
  session: PersistedDraftSession
}

const activeRequests = new Map<string, ActiveRequest>()
const draftCache = new Map<string, PersistedDraftSession>()
const draftLocks = new Map<string, Promise<void>>()
const completedSends = new Map<string, CompletedSend>()
const MAX_COMPLETED_SENDS = 100

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
    const cancellationAccepted = Boolean(target?.cancellable)
    if (target?.cancellable) target.cancelled = true
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'app.operation.cancelled',
        requestId: request.requestId,
        ok: true,
        targetRequestId: request.targetRequestId,
        cancellationAccepted,
      },
      context,
    )
    return
  }

  const activeRequest: ActiveRequest = {
    cancelled: false,
    cancellable: request.type !== 'draft.send.request',
  }
  activeRequests.set(request.requestId, activeRequest)
  try {
    if (request.type === 'app.health.request') {
      await handleHealth(request, context, activeRequest)
    } else if (request.type === 'draft.load.request') {
      await handleDraftLoad(request, context, activeRequest)
    } else if (request.type === 'draft.mutate.request') {
      await handleDraftMutation(request, context, activeRequest)
    } else if (request.type === 'draft.undo.request') {
      await handleDraftUndo(request, context, activeRequest)
    } else {
      await handleDraftSend(request, context)
    }
  } catch (error) {
    if (activeRequest.cancelled) return
    spindle.log.error(`JarvisType request failed: ${describeError(error)}`)
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'app.error',
        requestId: request.requestId,
        ok: false,
        code: 'INTERNAL_ERROR',
        message: 'JarvisType could not complete the request. The draft was preserved.',
        retryable: true,
        ...('operationId' in request ? { operationId: request.operationId } : {}),
      },
      context,
    )
  } finally {
    activeRequests.delete(request.requestId)
  }
}

async function handleHealth(
  request: Extract<FrontendRequest, { type: 'app.health.request' }>,
  context: RequestContext,
  activeRequest: ActiveRequest,
): Promise<void> {
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
}

async function handleDraftLoad(
  request: Extract<FrontendRequest, { type: 'draft.load.request' }>,
  context: RequestContext,
  activeRequest: ActiveRequest,
): Promise<void> {
  const session = await withDraftLock(context.userId, request.chatId, () =>
    loadDraft(context.userId, request.chatId),
  )
  if (activeRequest.cancelled) return
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.snapshot.response',
      requestId: request.requestId,
      ok: true,
      outcome: 'loaded',
      snapshot: toDraftSnapshot(session),
    },
    context,
  )
}

async function handleDraftMutation(
  request: Extract<FrontendRequest, { type: 'draft.mutate.request' }>,
  context: RequestContext,
  activeRequest: ActiveRequest,
): Promise<void> {
  const result = await withDraftLock(context.userId, request.chatId, async () => {
    const session = await loadDraft(context.userId, request.chatId)
    const mutation = applyManualEdit(session, request.cleanText, {
      expectedVersion: request.expectedVersion,
      editGroupId: request.editGroupId,
    })
    if (mutation.applied) await persistDraft(context.userId, mutation.session)
    return mutation
  })
  if (activeRequest.cancelled) return
  if (result.reason === 'too-large') {
    sendDraftError(
      request,
      context,
      'DRAFT_TOO_LARGE',
      'The draft exceeds the safe size limit.',
      result.session,
    )
    return
  }
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.snapshot.response',
      requestId: request.requestId,
      ok: true,
      outcome: result.applied
        ? 'applied'
        : result.reason === 'stale-version'
          ? 'stale-version'
          : 'unchanged',
      operationId: request.operationId,
      snapshot: toDraftSnapshot(result.session),
    },
    context,
  )
}

async function handleDraftUndo(
  request: Extract<FrontendRequest, { type: 'draft.undo.request' }>,
  context: RequestContext,
  activeRequest: ActiveRequest,
): Promise<void> {
  const result = await withDraftLock(context.userId, request.chatId, async () => {
    const session = await loadDraft(context.userId, request.chatId)
    const mutation = undoLatestDraftMutation(session, request.expectedVersion)
    if (mutation.applied) await persistDraft(context.userId, mutation.session)
    return mutation
  })
  if (activeRequest.cancelled) return
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.snapshot.response',
      requestId: request.requestId,
      ok: true,
      outcome: result.applied
        ? 'applied'
        : result.reason === 'stale-version'
          ? 'stale-version'
          : 'unchanged',
      operationId: request.operationId,
      snapshot: toDraftSnapshot(result.session),
    },
    context,
  )
}

async function handleDraftSend(
  request: Extract<FrontendRequest, { type: 'draft.send.request' }>,
  context: RequestContext,
): Promise<void> {
  const sendKey = `${context.userId}:${request.operationId}`
  const completed = completedSends.get(sendKey)
  if (completed) {
    sendSendResponse(request, context, completed)
    return
  }

  const result = await withDraftLock(context.userId, request.chatId, async () => {
    const alreadyCompleted = completedSends.get(sendKey)
    if (alreadyCompleted) return { completed: alreadyCompleted }
    const session = await loadDraft(context.userId, request.chatId)
    if (session.draftVersion !== request.expectedVersion) {
      return { error: 'stale' as const, session }
    }
    if (session.cleanText.trim().length === 0) return { error: 'empty' as const, session }
    if (
      !spindle.permissions.has('chats') ||
      !spindle.permissions.has('chat_mutation') ||
      !spindle.permissions.has('generation')
    ) {
      return { error: 'permission' as const, session }
    }
    const activeChat = await spindle.chats.getActive(context.userId)
    if (!activeChat || activeChat.id !== request.chatId) {
      return { error: 'chat-mismatch' as const, session }
    }

    try {
      const appendResult = await spindle.chat.appendMessage(
        request.chatId,
        {
          role: 'user',
          content: session.cleanText,
          metadata: {
            jarvistype: {
              version: APP_VERSION,
              operation_id: request.operationId,
              draft_version: session.draftVersion,
            },
          },
        },
        { triggerGeneration: true },
      )
      if (!appendResult.id) throw new Error('Lumiverse did not confirm a message identifier')

      const cleared = clearDraftAfterSend(session)
      draftCache.set(draftKey(context.userId, request.chatId), cleared)
      await clearPersistedDraft(context.userId, request.chatId, cleared)
      const completed: CompletedSend = {
        messageIdPresent: true as const,
        generationIdPresent: Boolean(appendResult.generationId),
        session: cleared,
      }
      rememberCompletedSend(sendKey, completed)
      return { completed }
    } catch (error) {
      spindle.log.error(`JarvisType send failed: ${describeError(error)}`)
      return { error: 'send' as const, session }
    }
  })

  if ('error' in result && result.session) {
    if (result.error === 'stale') {
      sendDraftError(
        request,
        context,
        'INTERNAL_ERROR',
        'The draft changed before sending. Review it and try again.',
        result.session,
      )
    } else if (result.error === 'empty') {
      sendDraftError(request, context, 'DRAFT_EMPTY', 'The draft is empty.', result.session)
    } else if (result.error === 'permission') {
      sendDraftError(
        request,
        context,
        'PERMISSION_DENIED',
        'Required Lumiverse send permissions are not granted.',
        result.session,
      )
    } else if (result.error === 'chat-mismatch') {
      sendDraftError(
        request,
        context,
        'CHAT_MISMATCH',
        'The active chat no longer owns this draft. Return to its chat before sending.',
        result.session,
      )
    } else {
      sendDraftError(
        request,
        context,
        'SEND_FAILED',
        'Lumiverse did not confirm the send. The draft was preserved for retry.',
        result.session,
      )
    }
    return
  }

  if ('completed' in result && result.completed) {
    sendSendResponse(request, context, result.completed)
  }
}

function sendSendResponse(
  request: Extract<FrontendRequest, { type: 'draft.send.request' }>,
  context: RequestContext,
  completed: CompletedSend,
): void {
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.send.response',
      requestId: request.requestId,
      ok: true,
      operationId: request.operationId,
      messageIdPresent: true,
      generationIdPresent: completed.generationIdPresent,
      snapshot: toDraftSnapshot(completed.session),
    },
    context,
  )
}

function sendDraftError(
  request: Extract<FrontendRequest, { operationId: string }>,
  context: RequestContext,
  code: Extract<BackendResponse, { type: 'app.error' }>['code'],
  message: string,
  session: PersistedDraftSession,
): void {
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.error',
      requestId: request.requestId,
      ok: false,
      code,
      message,
      retryable: code !== 'DRAFT_EMPTY',
      operationId: request.operationId,
      snapshot: toDraftSnapshot(session),
    },
    context,
  )
}

async function loadDraft(userId: string, chatId: string): Promise<PersistedDraftSession> {
  const key = draftKey(userId, chatId)
  const cached = draftCache.get(key)
  if (cached) return cached

  const raw = await spindle.userStorage.getJson<unknown>(draftPath(chatId), {
    fallback: null,
    userId,
  })
  const session = isPersistedDraftSession(raw, chatId) ? raw : createDraftSession(chatId)
  draftCache.set(key, session)
  return session
}

async function persistDraft(userId: string, session: PersistedDraftSession): Promise<void> {
  await spindle.userStorage.setJson(draftPath(session.chatId), session, { userId })
  draftCache.set(draftKey(userId, session.chatId), session)
}

async function clearPersistedDraft(
  userId: string,
  chatId: string,
  cleared: PersistedDraftSession,
): Promise<void> {
  try {
    await spindle.userStorage.delete(draftPath(chatId), userId)
  } catch {
    try {
      await spindle.userStorage.setJson(draftPath(chatId), cleared, { userId })
    } catch (error) {
      spindle.log.error(
        `JarvisType sent the draft but could not clear its persisted copy: ${describeError(error)}`,
      )
    }
  }
}

async function withDraftLock<T>(
  userId: string,
  chatId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = draftKey(userId, chatId)
  const previous = draftLocks.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const chain = previous.then(() => current)
  draftLocks.set(key, chain)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (draftLocks.get(key) === chain) draftLocks.delete(key)
  }
}

function rememberCompletedSend(key: string, completed: CompletedSend): void {
  completedSends.set(key, completed)
  while (completedSends.size > MAX_COMPLETED_SENDS) {
    const oldest = completedSends.keys().next().value
    if (typeof oldest !== 'string') break
    completedSends.delete(oldest)
  }
}

function draftKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`
}

function draftPath(chatId: string): string {
  return `draft-${encodeURIComponent(chatId)}.json`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

spindle.log.info('JarvisType Phase 2 draft service loaded')
