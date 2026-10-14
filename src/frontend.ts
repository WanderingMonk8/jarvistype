import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

import { MAX_DRAFT_CHARACTERS, type DraftSnapshot } from './domain/draft-session'
import { RequestRegistry, type RequestOutcome } from './domain/request-registry'
import {
  APP_VERSION,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
  createRequestId,
  type BackendResponse,
  type FrontendRequest,
  type PermissionSnapshot,
} from './protocol/messages'
import { isBackendResponse, sanitizeGrantedPermissions } from './protocol/validation'

type BackendState = 'connecting' | 'ready' | 'unavailable'

interface ComposerState {
  activeChatId: string | null
  snapshot: DraftSnapshot | null
  backendState: BackendState
  backendVersion: string | null
  frontendVersion: string | null
  permissions: PermissionSnapshot
  statusMessage: string
  loading: boolean
  saving: boolean
  automatedBusy: boolean
  sending: boolean
  sendOutcomeUnknown: boolean
  historyExpanded: boolean
}

export function setup(ctx: SpindleFrontendContext): () => void {
  ctx.deferReady()

  const tab = ctx.ui.registerDrawerTab({
    id: 'jarvistype-composer',
    title: 'JarvisType',
    shortName: 'Jarvis',
    description: 'Compose and revise a private message before sending it.',
    keywords: ['voice', 'dictation', 'draft', 'speech'],
  })
  const inputAction = ctx.ui.registerInputBarAction({
    id: 'jarvistype-open',
    label: 'JarvisType',
    subtitle: 'Open private composition draft',
  })

  tab.root.innerHTML = shellMarkup()
  const backendStatus = requireElement<HTMLElement>(tab.root, '[data-backend-status]')
  const hostVersions = requireElement<HTMLElement>(tab.root, '[data-host-versions]')
  const activeChatStatus = requireElement<HTMLElement>(tab.root, '[data-active-chat]')
  const ownerChatStatus = requireElement<HTMLElement>(tab.root, '[data-owner-chat]')
  const permissionStatus = requireElement<HTMLElement>(tab.root, '[data-permission-status]')
  const shellStatus = requireElement<HTMLElement>(tab.root, '[data-shell-status]')
  const mismatchNotice = requireElement<HTMLElement>(tab.root, '[data-chat-mismatch]')
  const retryButton = requireElement<HTMLButtonElement>(tab.root, '[data-retry-backend]')
  const switchDraftButton = requireElement<HTMLButtonElement>(tab.root, '[data-switch-draft]')
  const editor = requireElement<HTMLTextAreaElement>(tab.root, '[data-draft-editor]')
  const draftMeta = requireElement<HTMLElement>(tab.root, '[data-draft-meta]')
  const paragraphList = requireElement<HTMLElement>(tab.root, '[data-paragraph-list]')
  const diffPanel = requireElement<HTMLElement>(tab.root, '[data-diff-panel]')
  const diffParagraphs = requireElement<HTMLElement>(tab.root, '[data-diff-paragraphs]')
  const diffRemoved = requireElement<HTMLElement>(tab.root, '[data-diff-removed]')
  const diffAdded = requireElement<HTMLElement>(tab.root, '[data-diff-added]')
  const undoButton = requireElement<HTMLButtonElement>(tab.root, '[data-undo]')
  const historyButton = requireElement<HTMLButtonElement>(tab.root, '[data-history-toggle]')
  const historyPanel = requireElement<HTMLElement>(tab.root, '[data-history-panel]')
  const historyList = requireElement<HTMLOListElement>(tab.root, '[data-history-list]')
  const sendButton = requireElement<HTMLButtonElement>(tab.root, '[data-send]')

  const state: ComposerState = {
    activeChatId: ctx.getActiveChat().chatId,
    snapshot: null,
    backendState: 'connecting',
    backendVersion: null,
    frontendVersion: null,
    permissions: {
      declared: ['media', 'chats', 'chat_mutation', 'generation'],
      granted: [],
    },
    statusMessage: 'Connecting to the JarvisType backend…',
    loading: false,
    saving: false,
    automatedBusy: false,
    sending: false,
    sendOutcomeUnknown: false,
    historyExpanded: false,
  }

  let alive = true
  let currentHealthRequestId: string | null = null
  let desiredText = ''
  let mutationInFlight = false
  let editGroupId: string | null = null
  let editGroupTimer: ReturnType<typeof setTimeout> | null = null
  let sendFlowActive = false
  const disposers: Array<() => void> = []

  const sendCancellation = (requestId: string) => {
    if (!alive) return
    send({
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.operation.cancel',
      requestId: createRequestId('cancel'),
      targetRequestId: requestId,
    })
  }
  const registry = new RequestRegistry<BackendResponse>(REQUEST_TIMEOUT_MS, sendCancellation)
  const sendRegistry = new RequestRegistry<BackendResponse>(SEND_TIMEOUT_MS, sendCancellation)

  const hasChatMismatch = () =>
    Boolean(
      state.snapshot?.dirty &&
      state.snapshot.chatId &&
      state.activeChatId !== state.snapshot.chatId,
    )

  const render = () => {
    backendStatus.textContent =
      state.backendState === 'ready'
        ? 'Ready'
        : state.backendState === 'connecting'
          ? 'Connecting…'
          : 'Unavailable'
    backendStatus.dataset.state = state.backendState
    hostVersions.textContent =
      state.backendVersion && state.frontendVersion
        ? `Lumiverse backend ${state.backendVersion} · frontend ${state.frontendVersion}`
        : 'Host versions pending'
    activeChatStatus.textContent = state.activeChatId
      ? `Active chat: ${state.activeChatId}`
      : 'Active chat: none'
    ownerChatStatus.textContent = state.snapshot
      ? `Draft owner: ${state.snapshot.chatId}`
      : 'Draft owner: not loaded'
    const granted = state.permissions.granted
    permissionStatus.textContent = `Permissions: media ${grantLabel(granted, 'media')} · chats ${grantLabel(granted, 'chats')} · send ${grantLabel(granted, 'chat_mutation')} · generation ${grantLabel(granted, 'generation')}`
    shellStatus.textContent = state.statusMessage
    retryButton.hidden = state.backendState !== 'unavailable'

    const mismatch = hasChatMismatch()
    mismatchNotice.hidden = !mismatch
    switchDraftButton.hidden = !state.activeChatId || state.activeChatId === state.snapshot?.chatId

    const editorEnabled =
      state.backendState === 'ready' &&
      state.snapshot !== null &&
      !state.loading &&
      !state.automatedBusy &&
      !state.sending
    editor.disabled = !editorEnabled
    draftMeta.textContent = state.snapshot
      ? `Version ${state.snapshot.draftVersion} · ${desiredText.length.toLocaleString()} / ${MAX_DRAFT_CHARACTERS.toLocaleString()} characters${state.saving ? ' · Saving…' : ' · Saved'}`
      : 'Draft not loaded'
    renderParagraphs(paragraphList, desiredText)
    renderDiff(state.snapshot, diffPanel, diffParagraphs, diffRemoved, diffAdded)
    renderHistory(historyList, state.snapshot)
    historyPanel.hidden = !state.historyExpanded
    historyButton.textContent = state.historyExpanded ? 'Hide History' : 'Show History'
    historyButton.disabled = !state.snapshot || state.snapshot.history.length === 0
    undoButton.disabled =
      !editorEnabled ||
      state.saving ||
      !state.snapshot?.canUndo ||
      desiredText !== state.snapshot.cleanText
    sendButton.disabled =
      !editorEnabled ||
      state.saving ||
      mismatch ||
      desiredText.trim().length === 0 ||
      desiredText !== state.snapshot?.cleanText ||
      state.sendOutcomeUnknown ||
      sendFlowActive
  }

  const send = (request: FrontendRequest) => {
    if (alive) ctx.sendToBackend(request)
  }

  const performRequest = async (
    request: FrontendRequest,
    isSend = false,
  ): Promise<RequestOutcome<BackendResponse>> => {
    const targetRegistry = isSend ? sendRegistry : registry
    const outcome = targetRegistry.wait(request.requestId)
    send(request)
    return outcome
  }

  const applySnapshot = (snapshot: DraftSnapshot, syncEditor: boolean) => {
    state.snapshot = snapshot
    if (syncEditor) {
      desiredText = snapshot.cleanText
      editor.value = snapshot.cleanText
    }
    if (desiredText === snapshot.cleanText) clearDraftBackup(snapshot.chatId)
  }

  const loadDraft = async (chatId: string) => {
    if (!alive || state.loading) return
    state.loading = true
    state.statusMessage = 'Loading the chat-owned draft…'
    render()
    const requestId = createRequestId('load')
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.load.request',
      requestId,
      chatId,
    })
    state.loading = false
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'draft.snapshot.response') {
      applySnapshot(outcome.value.snapshot, true)
      state.sendOutcomeUnknown = false
      const backup = loadDraftBackup(chatId)
      if (backup !== null && backup !== outcome.value.snapshot.cleanText) {
        desiredText = backup
        editor.value = backup
        state.statusMessage = 'Recovering locally buffered text into the private draft…'
        void drainMutations()
      } else {
        state.statusMessage = outcome.value.snapshot.dirty
          ? 'Restored the private draft for this chat.'
          : 'Draft ready. Nothing is sent until you confirm.'
      }
    } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
      state.statusMessage = outcome.value.message
    } else if (outcome.status === 'timed-out') {
      state.statusMessage = 'Draft loading timed out. Retry the backend connection.'
    }
    render()
  }

  const refreshPermissions = async () => {
    try {
      state.permissions = sanitizeGrantedPermissions(await ctx.permissions.getGranted())
    } catch {
      state.statusMessage = 'Permission status is temporarily unavailable.'
    }
    if (alive) render()
  }

  const refreshHostState = async () => {
    const nextChatId = ctx.getActiveChat().chatId
    const changed = nextChatId !== state.activeChatId
    state.activeChatId = nextChatId
    await refreshPermissions()
    if (!alive || !changed || !nextChatId || state.loading) return

    if (!state.snapshot || (!state.snapshot.dirty && desiredText.length === 0)) {
      await loadDraft(nextChatId)
    } else if (state.snapshot.chatId !== nextChatId) {
      state.statusMessage =
        'Active chat changed. This draft remains attached to its original chat and cannot be sent here.'
      render()
    }
  }

  const checkBackend = async () => {
    if (!alive) return
    if (currentHealthRequestId) registry.cancel(currentHealthRequestId)
    const requestId = createRequestId('health')
    currentHealthRequestId = requestId
    state.backendState = 'connecting'
    state.statusMessage = 'Connecting to the JarvisType backend…'
    render()

    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'app.health.request',
      requestId,
      clientTimestamp: new Date().toISOString(),
      activeChatId: state.activeChatId,
    })
    if (!alive || currentHealthRequestId !== requestId) return
    currentHealthRequestId = null

    if (outcome.status === 'resolved' && outcome.value.type === 'app.health.response') {
      state.backendState = 'ready'
      state.backendVersion = outcome.value.backendVersion
      state.frontendVersion = outcome.value.frontendVersion
      state.permissions = outcome.value.permissions
      state.statusMessage = 'Backend ready. Loading the active chat draft…'
      render()
      if (state.activeChatId) await loadDraft(state.activeChatId)
      else {
        state.statusMessage = 'Select a chat to begin a private draft.'
        render()
      }
    } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
      state.backendState = 'unavailable'
      state.statusMessage = outcome.value.message
      render()
    } else if (outcome.status === 'timed-out') {
      state.backendState = 'unavailable'
      state.statusMessage = 'The backend did not respond. No draft content was sent.'
      render()
    }
  }

  const beginEditGroup = (): string => {
    editGroupId ??= createRequestId('edit-group')
    if (editGroupTimer) clearTimeout(editGroupTimer)
    editGroupTimer = setTimeout(() => {
      editGroupId = null
      editGroupTimer = null
    }, 1_200)
    return editGroupId
  }

  const drainMutations = async () => {
    if (mutationInFlight || !state.snapshot || !alive) return
    mutationInFlight = true
    state.saving = true
    render()
    try {
      while (
        alive &&
        state.snapshot &&
        desiredText !== state.snapshot.cleanText &&
        !state.automatedBusy &&
        !state.sending
      ) {
        const snapshot = state.snapshot
        const requestId = createRequestId('mutate')
        const operationId = createRequestId('manual-edit')
        const textForRequest = desiredText
        const outcome = await performRequest({
          protocolVersion: PROTOCOL_VERSION,
          type: 'draft.mutate.request',
          requestId,
          operationId,
          chatId: snapshot.chatId,
          expectedVersion: snapshot.draftVersion,
          editGroupId: beginEditGroup(),
          cleanText: textForRequest,
        })
        if (!alive) return
        if (outcome.status === 'resolved' && outcome.value.type === 'draft.snapshot.response') {
          applySnapshot(outcome.value.snapshot, false)
          state.statusMessage =
            outcome.value.outcome === 'stale-version'
              ? 'Draft changed elsewhere; reconciling your latest text safely…'
              : 'Draft saved privately.'
          if (desiredText === outcome.value.snapshot.cleanText) {
            clearDraftBackup(outcome.value.snapshot.chatId)
          }
        } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
          if (outcome.value.snapshot) applySnapshot(outcome.value.snapshot, false)
          state.statusMessage = outcome.value.message
          break
        } else {
          state.statusMessage =
            'Draft save timed out. Your text remains visible; retry before leaving.'
          break
        }
      }
    } finally {
      mutationInFlight = false
      state.saving = desiredText !== state.snapshot?.cleanText
      render()
    }
  }

  const handleEditorInput = () => {
    desiredText = editor.value
    if (state.snapshot) saveDraftBackup(state.snapshot.chatId, desiredText)
    beginEditGroup()
    state.statusMessage = 'Saving the private draft…'
    state.saving = true
    render()
    void drainMutations()
  }

  const handleUndo = async () => {
    if (!state.snapshot || state.automatedBusy || state.sending) return
    await drainMutations()
    if (!state.snapshot.canUndo || desiredText !== state.snapshot.cleanText) return
    state.automatedBusy = true
    state.statusMessage = 'Undoing the latest draft mutation…'
    render()
    const snapshot = state.snapshot
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.undo.request',
      requestId: createRequestId('undo'),
      operationId: createRequestId('undo-operation'),
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion,
    })
    state.automatedBusy = false
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'draft.snapshot.response') {
      applySnapshot(outcome.value.snapshot, true)
      state.statusMessage =
        outcome.value.outcome === 'applied' ? 'Latest draft mutation undone.' : 'Nothing to undo.'
    } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
      state.statusMessage = outcome.value.message
    } else {
      state.statusMessage = 'Undo timed out. The existing draft was preserved.'
    }
    render()
  }

  const requestSendPermissions = async (): Promise<boolean> => {
    const required = ['chats', 'chat_mutation', 'generation'] as const
    const missing = required.filter((permission) => !state.permissions.granted.includes(permission))
    if (missing.length === 0) return true
    try {
      const granted = await ctx.permissions.request(missing, {
        reason:
          'Verify the owning chat, add the confirmed draft as one user message, and start the normal Lumiverse response.',
      })
      state.permissions = sanitizeGrantedPermissions(granted)
      return required.every((permission) => granted.includes(permission))
    } catch {
      state.statusMessage =
        'Send permissions were not granted. The draft remains private and unchanged.'
      return false
    }
  }

  const handleSend = async () => {
    if (sendFlowActive || !state.snapshot) return
    sendFlowActive = true
    render()
    try {
      await drainMutations()
      const snapshot = state.snapshot
      const currentChatId = ctx.getActiveChat().chatId
      state.activeChatId = currentChatId
      if (
        !snapshot ||
        desiredText !== snapshot.cleanText ||
        snapshot.cleanText.trim().length === 0
      ) {
        state.statusMessage = 'Wait for the draft to finish saving before sending.'
        return
      }
      if (!currentChatId || currentChatId !== snapshot.chatId) {
        state.statusMessage = 'Return to the draft’s owning chat before sending.'
        return
      }
      if (!(await requestSendPermissions())) return

      const confirmation = await ctx.ui.showConfirm({
        title: 'Confirm and send draft?',
        message:
          'JarvisType will add exactly the clean draft text to this chat and start the normal Lumiverse response.',
        variant: 'success',
        confirmLabel: 'Confirm & Send',
      })
      if (!confirmation.confirmed) {
        state.statusMessage = 'Send cancelled. The draft remains private.'
        return
      }

      state.sending = true
      state.statusMessage = 'Sending the confirmed clean draft…'
      render()
      const operationId = createRequestId('send-operation')
      const outcome = await performRequest(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: 'draft.send.request',
          requestId: createRequestId('send'),
          operationId,
          chatId: snapshot.chatId,
          expectedVersion: snapshot.draftVersion,
        },
        true,
      )
      state.sending = false
      if (!alive) return
      if (outcome.status === 'resolved' && outcome.value.type === 'draft.send.response') {
        applySnapshot(outcome.value.snapshot, true)
        state.sendOutcomeUnknown = false
        state.statusMessage = outcome.value.generationIdPresent
          ? 'Draft sent once and normal response generation started.'
          : 'Draft sent once. Lumiverse did not return a generation identifier.'
      } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
        if (outcome.value.snapshot) applySnapshot(outcome.value.snapshot, true)
        state.sendOutcomeUnknown = false
        state.statusMessage = outcome.value.message
      } else {
        state.sendOutcomeUnknown = true
        state.statusMessage =
          'Send confirmation timed out. Checking the persisted draft before allowing retry…'
        render()
        await loadDraft(snapshot.chatId)
      }
    } finally {
      state.sending = false
      sendFlowActive = false
      render()
    }
  }

  const removeBackendListener = ctx.onBackendMessage((payload: unknown) => {
    if (!alive || !isBackendResponse(payload)) return
    if (!registry.resolve(payload.requestId, payload))
      sendRegistry.resolve(payload.requestId, payload)
  })
  disposers.push(removeBackendListener)

  const refreshFromHost = () => void refreshHostState()
  disposers.push(ctx.events.on('PERMISSION_CHANGED', refreshFromHost))
  disposers.push(ctx.events.on('CHAT_SWITCHED', refreshFromHost))
  disposers.push(tab.onActivate(refreshFromHost))
  disposers.push(inputAction.onClick(() => tab.activate()))

  const handleVisibility = () => {
    if (document.visibilityState === 'visible') void refreshHostState()
  }
  const handleFocus = () => void refreshHostState()
  const handleRetry = () => void checkBackend()
  const handleSwitchDraft = () => {
    if (state.activeChatId) void loadDraft(state.activeChatId)
  }
  const handleHistoryToggle = () => {
    state.historyExpanded = !state.historyExpanded
    render()
  }
  const handleUndoClick = () => void handleUndo()
  const handleSendClick = () => void handleSend()
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('focus', handleFocus)
  retryButton.addEventListener('click', handleRetry)
  switchDraftButton.addEventListener('click', handleSwitchDraft)
  editor.addEventListener('input', handleEditorInput)
  undoButton.addEventListener('click', handleUndoClick)
  historyButton.addEventListener('click', handleHistoryToggle)
  sendButton.addEventListener('click', handleSendClick)

  render()
  void checkBackend()
  ctx.ready()

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    alive = false
    if (editGroupTimer) clearTimeout(editGroupTimer)
    registry.cancelAll()
    sendRegistry.cancelAll()
    for (const dispose of disposers.splice(0)) dispose()
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('focus', handleFocus)
    retryButton.removeEventListener('click', handleRetry)
    switchDraftButton.removeEventListener('click', handleSwitchDraft)
    editor.removeEventListener('input', handleEditorInput)
    undoButton.removeEventListener('click', handleUndoClick)
    historyButton.removeEventListener('click', handleHistoryToggle)
    sendButton.removeEventListener('click', handleSendClick)
    inputAction.destroy()
    tab.destroy()
  }
  const removeTeardownListener = ctx.onTeardown?.(cleanup)
  if (removeTeardownListener) disposers.push(removeTeardownListener)
  return cleanup
}

function renderParagraphs(container: HTMLElement, cleanText: string): void {
  container.replaceChildren()
  if (cleanText.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'jt-empty'
    empty.textContent = 'Paragraph numbers appear here as you type.'
    container.append(empty)
    return
  }

  let ordinal = 0
  for (const line of cleanText.split('\n')) {
    const row = document.createElement('div')
    row.className = 'jt-paragraph-row'
    if (line.trim().length === 0) {
      row.classList.add('jt-paragraph-row--separator')
      row.setAttribute('aria-label', 'Blank paragraph separator')
      container.append(row)
      continue
    }
    ordinal += 1
    const number = document.createElement('span')
    number.className = 'jt-paragraph-number'
    number.textContent = String(ordinal)
    number.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.className = 'jt-paragraph-text'
    text.textContent = line
    row.append(number, text)
    container.append(row)
  }
}

function renderDiff(
  snapshot: DraftSnapshot | null,
  panel: HTMLElement,
  paragraphs: HTMLElement,
  removed: HTMLElement,
  added: HTMLElement,
): void {
  const diff = snapshot?.latestDiff
  panel.hidden = !diff
  if (!diff) return
  paragraphs.textContent = diff.affectedParagraphOrdinals.length
    ? `Affected paragraph${diff.affectedParagraphOrdinals.length === 1 ? '' : 's'}: ${diff.affectedParagraphOrdinals.join(', ')}`
    : 'Draft-level change'
  removed.textContent = diff.removed || '∅'
  added.textContent = diff.added || '∅'
}

function renderHistory(list: HTMLOListElement, snapshot: DraftSnapshot | null): void {
  list.replaceChildren()
  for (const entry of snapshot?.history ?? []) {
    const item = document.createElement('li')
    const kind = entry.kind === 'undo' ? 'Undo' : 'Manual edit'
    const affected = entry.diff.affectedParagraphOrdinals.length
      ? ` · paragraph ${entry.diff.affectedParagraphOrdinals.join(', ')}`
      : ''
    item.textContent = `${kind} · v${entry.beforeVersion} → v${entry.afterVersion}${affected}`
    list.append(item)
  }
}

function grantLabel(granted: readonly string[], permission: string): string {
  return granted.includes(permission) ? 'granted' : 'not granted'
}

function draftBackupKey(chatId: string): string {
  return `__jarvistypeDraftBackup:${chatId}`
}

function saveDraftBackup(chatId: string, text: string): void {
  try {
    window.sessionStorage.setItem(draftBackupKey(chatId), text)
  } catch {
    // The backend remains canonical when browser storage is unavailable.
  }
}

function loadDraftBackup(chatId: string): string | null {
  try {
    const text = window.sessionStorage.getItem(draftBackupKey(chatId))
    return text !== null && text.length <= MAX_DRAFT_CHARACTERS ? text : null
  } catch {
    return null
  }
}

function clearDraftBackup(chatId: string): void {
  try {
    window.sessionStorage.removeItem(draftBackupKey(chatId))
  } catch {
    // A blocked sessionStorage must not affect the canonical backend draft.
  }
}

function shellMarkup(): string {
  return `
    <style>
      .jt-shell { box-sizing: border-box; display: grid; gap: 1rem; padding: 1rem; min-width: 0; }
      .jt-shell *, .jt-shell *::before, .jt-shell *::after { box-sizing: border-box; }
      .jt-shell h2, .jt-shell h3, .jt-shell h4, .jt-shell p { margin: 0; }
      .jt-shell__header, .jt-shell__card { display: grid; gap: .7rem; min-width: 0; }
      .jt-shell__eyebrow { font-size: .78rem; opacity: .72; text-transform: uppercase; letter-spacing: .08em; }
      .jt-shell__card { padding: .85rem; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: .75rem; }
      .jt-shell__status-grid { display: grid; gap: .4rem; font-size: .88rem; overflow-wrap: anywhere; }
      .jt-shell__notice { padding: .7rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 8%, transparent); }
      .jt-shell__warning { padding: .7rem; border: 1px solid #d69e2e; border-radius: .5rem; }
      .jt-draft-editor { width: 100%; min-height: 11rem; resize: vertical; border-radius: .55rem; padding: .75rem; font: inherit; line-height: 1.5; }
      .jt-draft-meta { font-size: .78rem; opacity: .75; overflow-wrap: anywhere; }
      .jt-paragraphs { display: grid; gap: .25rem; padding: .6rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 6%, transparent); }
      .jt-paragraph-row { display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: .5rem; min-height: 1.5rem; }
      .jt-paragraph-row--separator { min-height: .8rem; }
      .jt-paragraph-number { text-align: right; opacity: .6; user-select: none; }
      .jt-paragraph-text { white-space: pre-wrap; overflow-wrap: anywhere; }
      .jt-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
      .jt-shell button { min-height: 2.35rem; }
      .jt-shell button:disabled { cursor: not-allowed; opacity: .55; }
      .jt-diff { display: grid; gap: .4rem; padding: .65rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 6%, transparent); }
      .jt-diff__line { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: .5rem; }
      .jt-diff del, .jt-diff ins { white-space: pre-wrap; overflow-wrap: anywhere; }
      .jt-history { max-height: 12rem; overflow: auto; padding-inline-start: 1.4rem; }
      .jt-empty { opacity: .65; font-style: italic; }
      [data-state="ready"] { color: #38a169; }
      [data-state="unavailable"] { color: #e53e3e; }
    </style>
    <main class="jt-shell" aria-labelledby="jt-title">
      <header class="jt-shell__header">
        <p class="jt-shell__eyebrow">Phase 2 draft foundation · v${APP_VERSION}</p>
        <h2 id="jt-title">JarvisType</h2>
        <p>Compose privately, review every change, and send only when you confirm.</p>
      </header>

      <section class="jt-shell__card" aria-labelledby="jt-connection-title">
        <h3 id="jt-connection-title">Connection and ownership</h3>
        <div class="jt-shell__status-grid">
          <p>Backend: <strong data-backend-status data-state="connecting">Connecting…</strong></p>
          <p data-host-versions>Host versions pending</p>
          <p data-active-chat>Active chat: none</p>
          <p data-owner-chat>Draft owner: not loaded</p>
          <p data-permission-status>Permissions: checking…</p>
        </div>
        <p class="jt-shell__notice" role="status" aria-live="polite" data-shell-status>Connecting to the JarvisType backend…</p>
        <div class="jt-shell__warning" data-chat-mismatch hidden>
          <p><strong>Different active chat.</strong> This draft stays attached to its original chat and cannot be sent here.</p>
        </div>
        <div class="jt-actions">
          <button type="button" data-retry-backend hidden>Retry backend connection</button>
          <button type="button" data-switch-draft hidden>Open active chat’s draft</button>
        </div>
      </section>

      <section class="jt-shell__card" aria-labelledby="jt-draft-title">
        <h3 id="jt-draft-title">Working draft</h3>
        <textarea class="jt-draft-editor" data-draft-editor maxlength="${MAX_DRAFT_CHARACTERS}" aria-describedby="jt-draft-help" aria-label="JarvisType private working draft" disabled></textarea>
        <p id="jt-draft-help">Paragraph numbers are shown separately and are never copied or sent.</p>
        <p class="jt-draft-meta" data-draft-meta>Draft not loaded</p>

        <h4>Numbered paragraphs</h4>
        <div class="jt-paragraphs" data-paragraph-list aria-live="polite"></div>

        <div class="jt-actions" aria-label="Voice composition controls">
          <button type="button" disabled>Record Message · Phase 3</button>
          <button type="button" disabled>Record Edit · Phase 5</button>
        </div>
        <div class="jt-actions">
          <button type="button" data-undo disabled>Undo</button>
          <button type="button" data-history-toggle disabled>Show History</button>
        </div>

        <section class="jt-diff" data-diff-panel hidden aria-labelledby="jt-diff-title">
          <h4 id="jt-diff-title">Latest change</h4>
          <p data-diff-paragraphs></p>
          <div class="jt-diff__line"><strong>Removed</strong><del data-diff-removed></del></div>
          <div class="jt-diff__line"><strong>Added</strong><ins data-diff-added></ins></div>
        </section>

        <section data-history-panel hidden aria-labelledby="jt-history-title">
          <h4 id="jt-history-title">Draft history</h4>
          <ol class="jt-history" data-history-list></ol>
        </section>

        <div class="jt-actions">
          <button type="button" data-send disabled>Confirm &amp; Send</button>
        </div>
      </section>
    </main>
  `
}

function requireElement<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`JarvisType shell is missing ${selector}`)
  return element
}
