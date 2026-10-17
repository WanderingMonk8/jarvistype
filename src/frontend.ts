import type {
  SpindleFrontendContext,
  SpindleSTTSession,
  SpindleSTTTranscript,
} from 'lumiverse-spindle-types'

import { MAX_DRAFT_CHARACTERS, type DraftSnapshot } from './domain/draft-session'
import type { GlossaryEntry } from './domain/glossary'
import { RequestRegistry, type RequestOutcome } from './domain/request-registry'
import {
  APP_VERSION,
  NORMALIZATION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  SEND_TIMEOUT_MS,
  createRequestId,
  type BackendResponse,
  type EditProposal,
  type EditCandidateSet,
  type FrontendRequest,
  type NormalizationConnectionOption,
  type NormalizationProposal,
  type PhaseFourSettings,
  type PermissionSnapshot,
} from './protocol/messages'
import { isBackendResponse, sanitizeGrantedPermissions } from './protocol/validation'

type BackendState = 'connecting' | 'ready' | 'unavailable'
type VoicePhase =
  'idle' | 'starting' | 'recording' | 'processing' | 'committing' | 'review' | 'error'

const MAX_RECORDING_DURATION_MS = 5 * 60 * 1_000

const DRAWER_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/>
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/>
    <path d="m18.5 3 .45 1.05L20 4.5l-1.05.45L18.5 6l-.45-1.05L17 4.5l1.05-.45L18.5 3Z"/>
  </svg>`

export const COMMAND_GROUPS = [
  {
    title: 'Compose',
    examples: [
      ['Record Message', 'Record Message, then dictate a new segment.'],
      ['Record Edit', 'Record Edit, then describe a change to the existing draft.'],
      [
        'Spoken punctuation',
        'Say “comma,” “period,” “question mark,” or “new paragraph” while dictating.',
      ],
    ],
  },
  {
    title: 'Change text',
    examples: [
      ['Replace', 'Replace “pending” with “approved” in paragraph 2.'],
      ['Delete', 'Delete the second sentence in paragraph 1.'],
      ['Insert before', 'Insert “Urgent:” before the first sentence.'],
      [
        'Insert after',
        'Insert a new paragraph after paragraph 2 that says “The route is approved.”',
      ],
      ['Append', 'Append “Please confirm attendance.” to paragraph 1.'],
      ['Prepend', 'Prepend “Urgent:” to paragraph 1.'],
    ],
  },
  {
    title: 'Structure and order',
    examples: [
      ['Split', 'Split paragraph 1 after “The launch checklist is ready.”'],
      ['Join', 'Join paragraph 1 with the following paragraph.'],
      ['Move before', 'Move paragraph 3 before paragraph 1.'],
      ['Move after', 'Move paragraph 1 after paragraph 2.'],
    ],
  },
  {
    title: 'Capitalization and spelling',
    examples: [
      ['Uppercase', 'Change the entire draft to uppercase.'],
      ['Lowercase', 'Change paragraph 2 to lowercase.'],
      ['Capitalize', 'Capitalize “Project Atlas” in paragraph 1.'],
      ['Spelled form', 'Replace Kalora with capitalized C-A-E-L-O-R-A.'],
      ['As in', 'Replace “can the worker” with “Ken the worker,” as in Barbie and Ken.'],
      [
        'Multiple changes',
        'In paragraph 1 replace pending with approved, and in paragraph 2 replace incomplete with complete.',
      ],
    ],
  },
] as const

interface ActiveRecording {
  runId: string
  operationId: string
  session: SpindleSTTSession
  finalSegments: string[]
  interimText: string
  mode: 'message' | 'edit'
}

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
  voicePhase: VoicePhase
  voiceElapsedMs: number
  voiceProvider: string | null
  voiceProvisionalText: string
  voiceFinalText: string
  voiceMessage: string
  pendingProposal: NormalizationProposal | null
  pendingEditProposal: EditProposal | null
  pendingEditCandidates: EditCandidateSet | null
  settings: PhaseFourSettings
  normalizationConnections: NormalizationConnectionOption[]
  glossary: GlossaryEntry[]
  canUndoGlossary: boolean
  phaseFourMessage: string
}

export function setup(ctx: SpindleFrontendContext): () => void {
  ctx.deferReady()

  const tab = ctx.ui.registerDrawerTab({
    id: 'jarvistype-composer',
    title: 'JarvisType',
    shortName: 'Jarvis',
    description: 'Compose and revise a private message before sending it.',
    keywords: ['voice', 'dictation', 'draft', 'speech'],
    iconSvg: DRAWER_ICON_SVG,
  })
  const inputAction = ctx.ui.registerInputBarAction({
    id: 'jarvistype-open',
    label: 'JarvisType',
    subtitle: 'Open private composition draft',
  })

  const floatingWidget = ctx.ui.createFloatWidget({
    width: Math.min(430, Math.max(300, window.innerWidth - 24)),
    height: Math.min(720, Math.max(420, window.innerHeight - 24)),
    initialPosition: {
      x: Math.max(12, window.innerWidth - 454),
      y: Math.max(12, window.innerHeight - 744),
    },
    snapToEdge: true,
    tooltip: 'JarvisType voice composer',
    chromeless: true,
    touchScrollMode: 'native',
  })
  floatingWidget.root.innerHTML = floatingMarkup()
  floatingWidget.setVisible(false)

  tab.root.innerHTML = shellMarkup()
  const shellStyle = tab.root.querySelector('style')
  if (shellStyle) floatingWidget.root.prepend(shellStyle.cloneNode(true))
  const composerSurface = requireElement<HTMLElement>(tab.root, '[data-composer-surface]')
  const drawerComposerMount = requireElement<HTMLElement>(tab.root, '[data-drawer-composer-mount]')
  const drawerOpenButton = requireElement<HTMLButtonElement>(tab.root, '[data-open-floating]')
  const floatingComposerMount = requireElement<HTMLElement>(
    floatingWidget.root,
    '[data-floating-composer-mount]',
  )
  const floatingCloseButton = requireElement<HTMLButtonElement>(
    floatingWidget.root,
    '[data-close-floating]',
  )
  const floatingCommandButton = requireElement<HTMLButtonElement>(
    floatingWidget.root,
    '[data-command-toggle]',
  )
  const floatingCommandPanel = requireElement<HTMLElement>(
    floatingWidget.root,
    '[data-command-panel]',
  )
  const floatingCommandSearch = requireElement<HTMLInputElement>(
    floatingWidget.root,
    '[data-command-search]',
  )
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
  const recordButton = requireElement<HTMLButtonElement>(tab.root, '[data-record-message]')
  const recordEditButton = requireElement<HTMLButtonElement>(tab.root, '[data-record-edit]')
  const cancelEditRecordingButton = requireElement<HTMLButtonElement>(
    tab.root,
    '[data-cancel-edit-recording]',
  )
  const cancelRecordingButton = requireElement<HTMLButtonElement>(
    tab.root,
    '[data-cancel-recording]',
  )
  const undoRecordingButton = requireElement<HTMLButtonElement>(tab.root, '[data-undo-recording]')
  const voiceStatus = requireElement<HTMLElement>(tab.root, '[data-voice-status]')
  const voiceElapsed = requireElement<HTMLElement>(tab.root, '[data-voice-elapsed]')
  const voiceProvider = requireElement<HTMLElement>(tab.root, '[data-voice-provider]')
  const voiceProvisional = requireElement<HTMLElement>(tab.root, '[data-voice-provisional]')
  const voiceFinal = requireElement<HTMLElement>(tab.root, '[data-voice-final]')
  const voiceSegmentCount = requireElement<HTMLElement>(tab.root, '[data-voice-segment-count]')
  const diffPanel = requireElement<HTMLElement>(tab.root, '[data-diff-panel]')
  const diffParagraphs = requireElement<HTMLElement>(tab.root, '[data-diff-paragraphs]')
  const diffRemoved = requireElement<HTMLElement>(tab.root, '[data-diff-removed]')
  const diffAdded = requireElement<HTMLElement>(tab.root, '[data-diff-added]')
  const undoButton = requireElement<HTMLButtonElement>(tab.root, '[data-undo]')
  const historyButton = requireElement<HTMLButtonElement>(tab.root, '[data-history-toggle]')
  const historyPanel = requireElement<HTMLElement>(tab.root, '[data-history-panel]')
  const historyList = requireElement<HTMLOListElement>(tab.root, '[data-history-list]')
  const sendButton = requireElement<HTMLButtonElement>(tab.root, '[data-send]')
  const proposalPanel = requireElement<HTMLElement>(tab.root, '[data-normalization-proposal]')
  const proposalRaw = requireElement<HTMLElement>(tab.root, '[data-proposal-raw]')
  const proposalCandidate = requireElement<HTMLElement>(tab.root, '[data-proposal-candidate]')
  const proposalMeta = requireElement<HTMLElement>(tab.root, '[data-proposal-meta]')
  const acceptProposalButton = requireElement<HTMLButtonElement>(tab.root, '[data-proposal-accept]')
  const rejectProposalButton = requireElement<HTMLButtonElement>(tab.root, '[data-proposal-reject]')
  const editProposalPanel = requireElement<HTMLElement>(tab.root, '[data-edit-proposal]')
  const editCandidatesPanel = requireElement<HTMLElement>(tab.root, '[data-edit-candidates]')
  const editCandidatesInstruction = requireElement<HTMLElement>(
    tab.root,
    '[data-edit-candidates-instruction]',
  )
  const editCandidatesList = requireElement<HTMLElement>(tab.root, '[data-edit-candidates-list]')
  const cancelEditCandidatesButton = requireElement<HTMLButtonElement>(
    tab.root,
    '[data-edit-candidates-cancel]',
  )
  const editProposalInstruction = requireElement<HTMLElement>(tab.root, '[data-edit-instruction]')
  const editProposalOperations = requireElement<HTMLElement>(tab.root, '[data-edit-operations]')
  const editProposalBefore = requireElement<HTMLElement>(tab.root, '[data-edit-before]')
  const editProposalAfter = requireElement<HTMLElement>(tab.root, '[data-edit-after]')
  const acceptEditButton = requireElement<HTMLButtonElement>(tab.root, '[data-edit-accept]')
  const rejectEditButton = requireElement<HTMLButtonElement>(tab.root, '[data-edit-reject]')
  const contextCountInput = requireElement<HTMLInputElement>(tab.root, '[data-context-count]')
  const contextualToggle = requireElement<HTMLInputElement>(tab.root, '[data-context-enabled]')
  const saveSettingsButton = requireElement<HTMLButtonElement>(tab.root, '[data-settings-save]')
  const normalizationConnectionSelect = requireElement<HTMLSelectElement>(
    tab.root,
    '[data-normalization-connection]',
  )
  const normalizationModelSlot = requireElement<HTMLElement>(tab.root, '[data-normalization-model]')
  const glossaryCanonicalInput = requireElement<HTMLInputElement>(
    tab.root,
    '[data-glossary-canonical]',
  )
  const glossaryVariantsInput = requireElement<HTMLInputElement>(
    tab.root,
    '[data-glossary-variants]',
  )
  const glossaryHintInput = requireElement<HTMLInputElement>(tab.root, '[data-glossary-hint]')
  const glossarySaveButton = requireElement<HTMLButtonElement>(tab.root, '[data-glossary-save]')
  const glossaryCancelButton = requireElement<HTMLButtonElement>(tab.root, '[data-glossary-cancel]')
  const glossaryUndoButton = requireElement<HTMLButtonElement>(tab.root, '[data-glossary-undo]')
  const glossaryList = requireElement<HTMLElement>(tab.root, '[data-glossary-list]')
  const glossarySearchInput = requireElement<HTMLInputElement>(tab.root, '[data-glossary-search]')
  const floatingGlossarySearchInput = requireElement<HTMLInputElement>(
    floatingWidget.root,
    '[data-floating-glossary-search]',
  )
  const floatingGlossaryList = requireElement<HTMLElement>(
    floatingWidget.root,
    '[data-floating-glossary-list]',
  )
  const floatingGlossaryCanonicalInput = requireElement<HTMLInputElement>(
    floatingWidget.root,
    '[data-floating-glossary-canonical]',
  )
  const floatingGlossaryVariantsInput = requireElement<HTMLInputElement>(
    floatingWidget.root,
    '[data-floating-glossary-variants]',
  )
  const floatingGlossaryHintInput = requireElement<HTMLInputElement>(
    floatingWidget.root,
    '[data-floating-glossary-hint]',
  )
  const floatingGlossarySaveButton = requireElement<HTMLButtonElement>(
    floatingWidget.root,
    '[data-floating-glossary-save]',
  )
  const floatingGlossaryCancelButton = requireElement<HTMLButtonElement>(
    floatingWidget.root,
    '[data-floating-glossary-cancel]',
  )
  const floatingGlossaryUndoButton = requireElement<HTMLButtonElement>(
    floatingWidget.root,
    '[data-floating-glossary-undo]',
  )
  const phaseFourStatus = requireElement<HTMLElement>(tab.root, '[data-phase4-status]')

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
    voicePhase: 'idle',
    voiceElapsedMs: 0,
    voiceProvider: null,
    voiceProvisionalText: '',
    voiceFinalText: '',
    voiceMessage: 'Ready to record a message segment.',
    pendingProposal: null,
    pendingEditProposal: null,
    pendingEditCandidates: null,
    settings: {
      contextMessageCount: 5,
      contextualNormalizationEnabled: true,
      normalizationConnectionId: null,
      normalizationModelOverride: '',
    },
    normalizationConnections: [],
    glossary: [],
    canUndoGlossary: false,
    phaseFourMessage: 'Loading context and glossary settings…',
  }

  const normalizationModelPicker = ctx.components.mountModelCombobox(normalizationModelSlot, {
    value: state.settings.normalizationModelOverride,
    connection: { kind: 'llm' },
    appearance: 'standard',
    placeholder: 'Use the connection model or search available models',
    emptyMessage: 'No models were returned for this connection.',
    loadingMessage: 'Loading available models…',
    browseHint: 'Search models available through the selected Lumiverse connection.',
    onChange: (model) => {
      state.settings.normalizationModelOverride = model
    },
  })
  let modelPickerConnectionId: string | null = null

  let alive = true
  let currentHealthRequestId: string | null = null
  let desiredText = ''
  let mutationInFlight = false
  let editGroupId: string | null = null
  let editGroupTimer: ReturnType<typeof setTimeout> | null = null
  let sendFlowActive = false
  let activeRecording: ActiveRecording | null = null
  let recordingTimer: ReturnType<typeof setInterval> | null = null
  let recordingDeadline: ReturnType<typeof setTimeout> | null = null
  let recordingStartedAt = 0
  let editingGlossaryEntryId: string | undefined
  let drawerGlossaryQuery = ''
  let floatingGlossaryQuery = ''
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
  const normalizationRegistry = new RequestRegistry<BackendResponse>(
    NORMALIZATION_TIMEOUT_MS,
    sendCancellation,
  )
  const sendRegistry = new RequestRegistry<BackendResponse>(SEND_TIMEOUT_MS, sendCancellation)

  const hasChatMismatch = () =>
    Boolean(
      state.snapshot?.dirty &&
      state.snapshot.chatId &&
      state.activeChatId !== state.snapshot.chatId,
    )

  const hasNativeStt = () =>
    Boolean((ctx.host.capabilities['speech-to-text-v1'] ?? 0) >= 1 && ctx.stt)

  const voiceBusy = () =>
    state.voicePhase === 'starting' ||
    state.voicePhase === 'recording' ||
    state.voicePhase === 'processing' ||
    state.voicePhase === 'committing' ||
    state.voicePhase === 'review'

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
      !state.sending &&
      !voiceBusy()
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
    const recordingOwnerReady =
      state.backendState === 'ready' &&
      state.snapshot !== null &&
      !state.loading &&
      !state.saving &&
      !state.automatedBusy &&
      !state.sending &&
      !mismatch &&
      state.activeChatId === state.snapshot.chatId &&
      desiredText === state.snapshot.cleanText
    recordButton.textContent =
      state.voicePhase === 'starting' || state.voicePhase === 'recording'
        ? 'Stop Recording'
        : state.voicePhase === 'processing'
          ? 'Transcribing…'
          : state.voicePhase === 'committing'
            ? 'Normalizing…'
            : state.voicePhase === 'review'
              ? 'Review required'
              : 'Record Message'
    recordButton.disabled =
      !hasNativeStt() ||
      !recordingOwnerReady ||
      (voiceBusy() && activeRecording?.mode !== 'message') ||
      state.voicePhase === 'processing' ||
      state.voicePhase === 'committing' ||
      state.voicePhase === 'review'
    recordEditButton.textContent =
      (state.voicePhase === 'starting' || state.voicePhase === 'recording') &&
      activeRecording?.mode === 'edit'
        ? 'Stop Edit Recording'
        : state.voicePhase === 'review' && state.pendingEditProposal
          ? 'Review required'
          : 'Record Edit'
    recordEditButton.disabled =
      !hasNativeStt() ||
      !recordingOwnerReady ||
      !desiredText.trim() ||
      (voiceBusy() && activeRecording?.mode !== 'edit') ||
      state.voicePhase === 'processing' ||
      state.voicePhase === 'committing' ||
      state.voicePhase === 'review'
    const recordingCanBeCancelled =
      state.voicePhase === 'starting' ||
      state.voicePhase === 'recording' ||
      state.voicePhase === 'processing'
    cancelRecordingButton.hidden = !recordingCanBeCancelled || activeRecording?.mode !== 'message'
    cancelRecordingButton.disabled = !activeRecording || activeRecording.mode !== 'message'
    cancelEditRecordingButton.hidden = !recordingCanBeCancelled || activeRecording?.mode !== 'edit'
    cancelEditRecordingButton.disabled = !activeRecording || activeRecording.mode !== 'edit'
    undoRecordingButton.disabled =
      !recordingOwnerReady || voiceBusy() || !state.snapshot?.canUndoRecording
    voiceStatus.textContent = state.voiceMessage
    voiceStatus.dataset.phase = state.voicePhase
    voiceElapsed.textContent = `Elapsed: ${formatDuration(state.voiceElapsedMs)}`
    voiceProvider.textContent = state.voiceProvider
      ? `Provider: ${state.voiceProvider}`
      : hasNativeStt()
        ? 'Provider: Lumiverse selection'
        : 'Speech-to-text unavailable on this host'
    voiceProvisional.textContent = state.voiceProvisionalText || 'No interim transcript received.'
    voiceProvisional.hidden = state.voiceProvisionalText.length === 0
    voiceFinal.textContent = state.voiceFinalText || 'No completed recording yet.'
    voiceSegmentCount.textContent = `Committed recording segments: ${state.snapshot?.recordingSegments.length ?? 0}`
    const proposal = state.pendingProposal
    proposalPanel.hidden = !proposal
    proposalRaw.textContent = proposal?.rawTranscript ?? ''
    proposalCandidate.textContent = proposal?.candidateText ?? ''
    proposalMeta.textContent = proposal
      ? `${proposal.contextMessageCount} context message(s), ${proposal.contextCharacterCount} characters${proposal.contextTruncated ? ', truncated to the privacy limit' : ''}. ${proposal.reasons.length ? `Changes: ${proposal.reasons.join(', ')}.` : ''}${proposal.ambiguities.length ? ` Review: ${proposal.ambiguities.join(' ')}` : ''}`
      : ''
    acceptProposalButton.disabled = !proposal || state.automatedBusy
    rejectProposalButton.disabled = !proposal || state.automatedBusy
    const editProposal = state.pendingEditProposal
    editProposalPanel.hidden = !editProposal
    editProposalInstruction.textContent = editProposal?.instructionTranscript ?? ''
    editProposalOperations.textContent = editProposal
      ? editProposal.operations
          .map(
            (operation) =>
              `${operation.type} · paragraph ${operation.paragraphOrdinal}${operation.destination?.paragraphOrdinal ? ` → paragraph ${operation.destination.paragraphOrdinal}` : ''} · ${operation.beforeText || '∅'} → ${operation.afterText || '∅'}`,
          )
          .join('\n')
      : ''
    editProposalBefore.textContent = editProposal?.beforeText ?? ''
    editProposalAfter.textContent = editProposal?.afterText ?? ''
    acceptEditButton.disabled = !editProposal || state.automatedBusy
    rejectEditButton.disabled = !editProposal || state.automatedBusy
    const editCandidates = state.pendingEditCandidates
    editCandidatesPanel.hidden = !editCandidates
    editCandidatesInstruction.textContent = editCandidates?.instructionTranscript ?? ''
    editCandidatesList.replaceChildren()
    for (const candidate of editCandidates?.candidates ?? []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.editCandidateId = candidate.id
      button.textContent = `Paragraph ${candidate.paragraphOrdinal}: ${candidate.preview}`
      button.disabled = state.automatedBusy
      editCandidatesList.append(button)
    }
    cancelEditCandidatesButton.disabled = !editCandidates || state.automatedBusy
    contextCountInput.value = String(state.settings.contextMessageCount)
    contextualToggle.checked = state.settings.contextualNormalizationEnabled
    renderConnectionOptions(
      normalizationConnectionSelect,
      state.normalizationConnections,
      state.settings.normalizationConnectionId,
    )
    if (modelPickerConnectionId !== state.settings.normalizationConnectionId) {
      modelPickerConnectionId = state.settings.normalizationConnectionId
      normalizationModelPicker.update({
        connection: modelPickerConnectionId
          ? { kind: 'llm', id: modelPickerConnectionId }
          : { kind: 'llm' },
      })
    }
    if (normalizationModelPicker.getValue() !== state.settings.normalizationModelOverride) {
      normalizationModelPicker.update({ value: state.settings.normalizationModelOverride })
    }
    phaseFourStatus.textContent = state.phaseFourMessage
    glossaryUndoButton.disabled = !state.canUndoGlossary || state.automatedBusy
    floatingGlossaryUndoButton.disabled = !state.canUndoGlossary || state.automatedBusy
    glossarySaveButton.textContent = editingGlossaryEntryId ? 'Update entry' : 'Add entry'
    floatingGlossarySaveButton.textContent = editingGlossaryEntryId ? 'Update entry' : 'Add entry'
    glossaryCancelButton.hidden = !editingGlossaryEntryId
    floatingGlossaryCancelButton.hidden = !editingGlossaryEntryId
    renderGlossary(glossaryList, state.glossary, drawerGlossaryQuery)
    renderGlossary(floatingGlossaryList, state.glossary, floatingGlossaryQuery)
    sendButton.disabled =
      !editorEnabled ||
      state.saving ||
      mismatch ||
      desiredText.trim().length === 0 ||
      desiredText !== state.snapshot?.cleanText ||
      state.sendOutcomeUnknown ||
      sendFlowActive ||
      voiceBusy()
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

  const performNormalizationRequest = async (
    request: FrontendRequest,
  ): Promise<RequestOutcome<BackendResponse>> => {
    const outcome = normalizationRegistry.wait(request.requestId)
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
    state.pendingProposal = null
    state.pendingEditProposal = null
    state.pendingEditCandidates = null
    if (state.voicePhase === 'review') state.voicePhase = 'idle'
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

  const loadPhaseFourState = async () => {
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.load.request',
      requestId: createRequestId('phase4-load'),
    })
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'phase4.state.response') {
      state.settings = outcome.value.settings
      state.normalizationConnections = outcome.value.connections
      state.glossary = outcome.value.glossary
      state.canUndoGlossary = outcome.value.canUndoGlossary
      state.phaseFourMessage = outcome.value.notice ?? 'Context and glossary settings ready.'
    } else {
      state.phaseFourMessage =
        'Context and glossary settings could not be loaded. Retry the backend connection.'
    }
    render()
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
      await loadPhaseFourState()
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

  const clearRecordingTimers = () => {
    if (recordingTimer) clearInterval(recordingTimer)
    if (recordingDeadline) clearTimeout(recordingDeadline)
    recordingTimer = null
    recordingDeadline = null
  }

  const cancelActiveRecording = (message: string) => {
    const recording = activeRecording
    if (!recording) return
    activeRecording = null
    clearRecordingTimers()
    recording.session.cancel()
    state.voicePhase = 'idle'
    state.voiceProvisionalText = ''
    state.voiceMessage = message
    render()
  }

  const commitRecordingTranscript = async (
    rawTranscript: string,
    operationId: string,
  ): Promise<void> => {
    const snapshot = state.snapshot
    if (!snapshot || ctx.getActiveChat().chatId !== snapshot.chatId) {
      state.voicePhase = 'error'
      state.voiceMessage =
        'The active chat changed before the transcript could be appended. No text was committed.'
      render()
      return
    }

    const outcome = await performNormalizationRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.normalize.request',
      requestId: createRequestId('transcript-normalize'),
      operationId,
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion,
      rawTranscript,
    })
    if (!alive) return
    if (
      outcome.status === 'resolved' &&
      outcome.value.type === 'transcript.normalization.response'
    ) {
      if (outcome.value.outcome === 'review') {
        state.pendingProposal = outcome.value.proposal
        state.voicePhase = 'review'
        state.voiceMessage =
          'Review the raw and normalized transcript before committing this segment.'
        render()
        return
      }
      if (!outcome.value.snapshot) return
      applySnapshot(outcome.value.snapshot, true)
      const committed = outcome.value.snapshot.recordingSegments.some(
        (segment) => segment.id === operationId,
      )
      state.voicePhase = committed ? 'idle' : 'error'
      state.voiceMessage = committed
        ? 'Normalized transcript appended; the original remains in the segment audit record.'
        : 'The final transcript was not appended. The existing draft was preserved.'
      if (outcome.value.glossaryLearned?.length) void loadPhaseFourState()
    } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
      if (outcome.value.snapshot) applySnapshot(outcome.value.snapshot, true)
      state.voicePhase = 'error'
      state.voiceMessage = outcome.value.message
    } else {
      state.voicePhase = 'error'
      state.voiceMessage =
        'Transcript commit timed out. Reload this chat’s draft before recording again.'
    }
    render()
  }

  const interpretEditTranscript = async (
    instructionTranscript: string,
    operationId: string,
  ): Promise<void> => {
    const snapshot = state.snapshot
    if (!snapshot || ctx.getActiveChat().chatId !== snapshot.chatId) {
      state.voicePhase = 'error'
      state.voiceMessage = 'The active chat changed. The edit instruction was discarded.'
      render()
      return
    }
    const outcome = await performNormalizationRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.interpret.request',
      requestId: createRequestId('edit-interpret'),
      operationId,
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion,
      instructionTranscript,
    })
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'edit.proposal.response') {
      state.pendingEditProposal = outcome.value.proposal
      state.voicePhase = 'review'
      state.voiceMessage = 'Review the interpreted operations and complete proposed draft.'
    } else if (outcome.status === 'resolved' && outcome.value.type === 'edit.candidates.response') {
      state.pendingEditCandidates = outcome.value.candidateSet
      state.voicePhase = 'review'
      state.voiceMessage = 'More than one target matches. Choose the intended paragraph.'
    } else {
      state.voicePhase = 'error'
      state.voiceMessage =
        outcome.status === 'resolved' && outcome.value.type === 'app.error'
          ? outcome.value.message
          : 'Edit interpretation timed out. The draft was not changed.'
    }
    render()
  }

  const acceptEditProposal = async () => {
    const proposal = state.pendingEditProposal
    if (!proposal || state.automatedBusy) return
    state.automatedBusy = true
    state.voiceMessage = 'Applying the approved edit atomically…'
    render()
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.confirm.request',
      requestId: createRequestId('edit-confirm'),
      operationId: proposal.operationId,
      chatId: proposal.chatId,
      expectedVersion: proposal.expectedVersion,
    })
    state.automatedBusy = false
    if (!alive) return
    if (
      outcome.status === 'resolved' &&
      outcome.value.type === 'edit.proposal.response' &&
      outcome.value.snapshot
    ) {
      applySnapshot(outcome.value.snapshot, true)
      state.pendingEditProposal = null
      state.voicePhase = 'idle'
      state.voiceMessage = 'Approved edit applied. You can undo it as one change.'
      if (outcome.value.glossaryLearned?.length) {
        const learnedNames = outcome.value.glossaryLearned
          .map((entry) => entry.canonical)
          .join(', ')
        await loadPhaseFourState()
        state.phaseFourMessage = `Learned ${learnedNames} from the approved edit spelling. The glossary change is undoable.`
      }
    } else {
      state.voicePhase = 'error'
      state.voiceMessage =
        outcome.status === 'resolved' && outcome.value.type === 'app.error'
          ? outcome.value.message
          : 'Edit confirmation timed out. The draft was not changed.'
    }
    render()
  }

  const rejectEditProposal = () => {
    state.pendingEditProposal = null
    state.voicePhase = 'idle'
    state.voiceMessage = 'Edit proposal rejected. The draft was not changed.'
    render()
  }

  const selectEditCandidate = async (candidateId: string) => {
    const candidateSet = state.pendingEditCandidates
    if (!candidateSet || state.automatedBusy) return
    state.automatedBusy = true
    state.voiceMessage = 'Resolving the selected target…'
    render()
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidate.select.request',
      requestId: createRequestId('edit-candidate-select'),
      operationId: candidateSet.operationId,
      chatId: candidateSet.chatId,
      expectedVersion: candidateSet.expectedVersion,
      candidateId,
    })
    state.automatedBusy = false
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'edit.proposal.response') {
      state.pendingEditCandidates = null
      state.pendingEditProposal = outcome.value.proposal
      state.voicePhase = 'review'
      state.voiceMessage = 'Target selected. Review the complete proposed edit before approval.'
    } else {
      state.voicePhase = 'error'
      state.voiceMessage =
        outcome.status === 'resolved' && outcome.value.type === 'app.error'
          ? outcome.value.message
          : 'Target selection timed out. The draft was not changed.'
    }
    render()
  }

  const cancelEditCandidateSelection = () => {
    state.pendingEditCandidates = null
    state.voicePhase = 'idle'
    state.voiceMessage = 'Target selection cancelled. The draft was not changed.'
    render()
  }

  const acceptNormalizationProposal = async () => {
    const proposal = state.pendingProposal
    if (!proposal || state.automatedBusy) return
    state.automatedBusy = true
    state.voiceMessage = 'Committing the reviewed transcript…'
    render()
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'transcript.confirm.request',
      requestId: createRequestId('transcript-confirm'),
      operationId: proposal.operationId,
      chatId: proposal.chatId,
      expectedVersion: proposal.expectedVersion,
    })
    state.automatedBusy = false
    if (!alive) return
    if (
      outcome.status === 'resolved' &&
      outcome.value.type === 'transcript.normalization.response' &&
      outcome.value.snapshot
    ) {
      applySnapshot(outcome.value.snapshot, true)
      state.pendingProposal = null
      state.voicePhase = 'idle'
      state.voiceMessage = 'Reviewed transcript appended to the draft.'
      if (outcome.value.glossaryLearned?.length) {
        const learnedNames = outcome.value.glossaryLearned
          .map((entry) => entry.canonical)
          .join(', ')
        await loadPhaseFourState()
        state.phaseFourMessage = `Learned ${learnedNames} from confirmed spelling. The glossary change is undoable.`
      }
    } else {
      state.voicePhase = 'error'
      state.voiceMessage =
        outcome.status === 'resolved' && outcome.value.type === 'app.error'
          ? outcome.value.message
          : 'Transcript confirmation timed out. Nothing was appended.'
    }
    render()
  }

  const rejectNormalizationProposal = () => {
    state.pendingProposal = null
    state.voicePhase = 'idle'
    state.voiceMessage = 'Normalized transcript rejected. Nothing was appended or learned.'
    render()
  }

  const applyPhaseFourResponse = (
    response: Extract<BackendResponse, { type: 'phase4.state.response' }>,
  ) => {
    state.settings = response.settings
    state.normalizationConnections = response.connections
    state.glossary = response.glossary
    state.canUndoGlossary = response.canUndoGlossary
    state.phaseFourMessage = response.notice ?? 'Context and glossary settings ready.'
  }

  const saveSettings = async () => {
    const contextMessageCount = Math.min(
      20,
      Math.max(0, Number.parseInt(contextCountInput.value, 10) || 0),
    )
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: createRequestId('settings-update'),
      settings: {
        contextMessageCount,
        contextualNormalizationEnabled: contextualToggle.checked,
        normalizationConnectionId: state.settings.normalizationConnectionId,
        normalizationModelOverride: normalizationModelPicker.getValue().trim(),
      },
    })
    if (outcome.status === 'resolved' && outcome.value.type === 'phase4.state.response')
      applyPhaseFourResponse(outcome.value)
    else state.phaseFourMessage = 'Settings were not saved. Try again.'
    render()
  }

  const saveGlossaryEntry = async (surface: 'drawer' | 'floating' = 'drawer') => {
    const canonicalInput =
      surface === 'floating' ? floatingGlossaryCanonicalInput : glossaryCanonicalInput
    const variantsInput =
      surface === 'floating' ? floatingGlossaryVariantsInput : glossaryVariantsInput
    const hintInput = surface === 'floating' ? floatingGlossaryHintInput : glossaryHintInput
    const canonical = canonicalInput.value.trim()
    if (!canonical) {
      state.phaseFourMessage = 'Enter a canonical spelling before saving.'
      render()
      return
    }
    const variants = variantsInput.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 20)
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'glossary.upsert.request',
      requestId: createRequestId('glossary-upsert'),
      ...(editingGlossaryEntryId ? { entryId: editingGlossaryEntryId } : {}),
      canonical,
      variants,
      hint: hintInput.value.trim(),
    })
    if (outcome.status === 'resolved' && outcome.value.type === 'phase4.state.response') {
      applyPhaseFourResponse(outcome.value)
      clearGlossaryForm()
    } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error')
      state.phaseFourMessage = outcome.value.message
    else state.phaseFourMessage = 'Glossary entry was not saved. Try again.'
    render()
  }

  const clearGlossaryForm = () => {
    editingGlossaryEntryId = undefined
    glossaryCanonicalInput.value = ''
    glossaryVariantsInput.value = ''
    glossaryHintInput.value = ''
    floatingGlossaryCanonicalInput.value = ''
    floatingGlossaryVariantsInput.value = ''
    floatingGlossaryHintInput.value = ''
  }

  const handleGlossaryListClick = async (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      'button[data-glossary-action]',
    )
    if (!button) return
    const entry = state.glossary.find((item) => item.id === button.dataset.entryId)
    if (!entry) return
    if (button.dataset.glossaryAction === 'edit') {
      editingGlossaryEntryId = entry.id
      glossaryCanonicalInput.value = entry.canonical
      glossaryVariantsInput.value = entry.variants.join(', ')
      glossaryHintInput.value = entry.hint
      floatingGlossaryCanonicalInput.value = entry.canonical
      floatingGlossaryVariantsInput.value = entry.variants.join(', ')
      floatingGlossaryHintInput.value = entry.hint
      render()
      return
    }
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'glossary.delete.request',
      requestId: createRequestId('glossary-delete'),
      entryId: entry.id,
    })
    if (outcome.status === 'resolved' && outcome.value.type === 'phase4.state.response')
      applyPhaseFourResponse(outcome.value)
    render()
  }

  const undoGlossary = async () => {
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'glossary.undo.request',
      requestId: createRequestId('glossary-undo'),
    })
    if (outcome.status === 'resolved' && outcome.value.type === 'phase4.state.response')
      applyPhaseFourResponse(outcome.value)
    render()
  }

  const finishRecording = async (runId: string, transcript: SpindleSTTTranscript) => {
    const recording = activeRecording
    if (!recording || recording.runId !== runId) return
    activeRecording = null
    clearRecordingTimers()
    state.voiceElapsedMs = Math.max(0, Date.now() - recordingStartedAt)
    state.voiceProvisionalText = ''
    state.voiceFinalText = transcript.text
    state.voiceProvider = transcript.provider
    if (transcript.text.trim().length === 0) {
      state.voicePhase = 'error'
      state.voiceMessage = 'No usable speech was recognized. Nothing was appended.'
      render()
      return
    }
    state.voicePhase = 'committing'
    state.voiceMessage =
      recording.mode === 'edit'
        ? 'Transcription complete. Interpreting the edit as structured operations…'
        : 'Transcription complete. Applying bounded context, punctuation, spelling, and glossary rules…'
    render()
    if (recording.mode === 'edit')
      await interpretEditTranscript(transcript.text, recording.operationId)
    else await commitRecordingTranscript(transcript.text, recording.operationId)
  }

  const failRecording = (runId: string, error: unknown) => {
    if (activeRecording?.runId !== runId) return
    activeRecording = null
    clearRecordingTimers()
    state.voiceProvisionalText = ''
    state.voicePhase = 'error'
    state.voiceMessage = describeRecordingError(error)
    render()
  }

  const stopActiveRecording = () => {
    const recording = activeRecording
    if (!recording || state.voicePhase === 'processing') return
    state.voicePhase = 'processing'
    state.voiceMessage = 'Recording stopped. Waiting for the authoritative transcript…'
    render()
    void recording.session.stop().catch(() => {
      // session.result is the single authoritative completion/error path.
    })
  }

  const startRecording = (mode: 'message' | 'edit') => {
    const stt = ctx.stt
    const snapshot = state.snapshot
    if (!stt || !hasNativeStt() || !snapshot) return
    const runId = createRequestId('recording-run')
    const operationId = createRequestId('recording-segment')
    const finalSegments: string[] = []
    try {
      const session = stt.start({
        continuous: true,
        interimResults: true,
        onStatus: (status) => {
          if (activeRecording?.runId !== runId) return
          if (status.phase === 'listening') {
            state.voicePhase = 'recording'
            state.voiceMessage = 'Recording… Speak naturally, then select Stop Recording.'
          } else if (status.phase === 'processing') {
            state.voicePhase = 'processing'
            state.voiceMessage = 'Transcribing the completed recording…'
          } else {
            state.voiceMessage = 'Preparing the configured speech-to-text provider…'
          }
          render()
        },
        onResult: (result) => {
          const current = activeRecording
          if (!current || current.runId !== runId) return
          if (result.isFinal) {
            if (result.text) finalSegments.push(result.text)
            current.interimText = ''
          } else {
            current.interimText = result.text
          }
          state.voiceProvisionalText = joinTranscriptUpdates(finalSegments, current.interimText)
          render()
        },
      })
      activeRecording = {
        runId,
        operationId,
        session,
        finalSegments,
        interimText: '',
        mode,
      }
      recordingStartedAt = Date.now()
      state.voicePhase = 'starting'
      state.voiceElapsedMs = 0
      state.voiceProvider = session.provider
      state.voiceProvisionalText = ''
      state.voiceMessage =
        mode === 'edit' ? 'Starting edit-instruction capture…' : 'Starting microphone capture…'
      recordingTimer = setInterval(() => {
        if (!activeRecording || activeRecording.runId !== runId) return
        state.voiceElapsedMs = Date.now() - recordingStartedAt
        render()
      }, 250)
      recordingDeadline = setTimeout(() => {
        if (activeRecording?.runId !== runId) return
        state.voiceMessage = 'Five-minute recording limit reached. Finalizing…'
        stopActiveRecording()
      }, MAX_RECORDING_DURATION_MS)
      void session.ready
        .then(() => {
          if (activeRecording?.runId !== runId || state.voicePhase === 'processing') return
          state.voicePhase = 'recording'
          state.voiceMessage = 'Recording… Speak naturally, then select Stop Recording.'
          render()
        })
        .catch((error: unknown) => failRecording(runId, error))
      void session.result
        .then((transcript) => finishRecording(runId, transcript))
        .catch((error: unknown) => failRecording(runId, error))
      render()
    } catch (error) {
      failRecording(runId, error)
      if (!activeRecording) {
        state.voicePhase = 'error'
        state.voiceMessage = describeRecordingError(error)
        render()
      }
    }
  }

  const requestRecordingPermissions = async (): Promise<boolean> => {
    const required = ['media', 'chats', 'generation'] as const
    const missing = required.filter((permission) => !state.permissions.granted.includes(permission))
    if (!missing.length) return true
    try {
      const granted = await ctx.permissions.request(missing, {
        reason:
          'Record through Lumiverse speech-to-text, read bounded chat context, and normalize the transcript through your configured Lumiverse generation connection.',
      })
      state.permissions = sanitizeGrantedPermissions(granted)
      const ready = required.every((permission) => granted.includes(permission))
      state.voiceMessage = ready
        ? 'Recording and normalization permissions are ready. Select Record Message again to begin.'
        : 'Required recording or normalization permission was not granted. No recording started.'
      render()
      return ready
    } catch {
      state.voiceMessage =
        'Required recording or normalization permission was not granted. No recording started.'
      render()
      return false
    }
  }

  const handleRecording = async (mode: 'message' | 'edit') => {
    if (state.voicePhase === 'starting' || state.voicePhase === 'recording') {
      if (activeRecording?.mode === mode) stopActiveRecording()
      return
    }
    if (
      voiceBusy() ||
      !state.snapshot ||
      state.saving ||
      state.activeChatId !== state.snapshot.chatId
    )
      return
    const missingPermission = ['media', 'chats', 'generation'].some(
      (permission) =>
        !state.permissions.granted.includes(permission as 'media' | 'chats' | 'generation'),
    )
    if (missingPermission) {
      await requestRecordingPermissions()
      return
    }
    startRecording(mode)
  }

  const handleUndoRecording = async () => {
    const snapshot = state.snapshot
    if (!snapshot?.canUndoRecording || voiceBusy() || state.saving) return
    state.automatedBusy = true
    state.voiceMessage = 'Removing the most recently appended recording segment…'
    render()
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.recording.undo.request',
      requestId: createRequestId('recording-undo'),
      operationId: createRequestId('recording-undo-operation'),
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion,
    })
    state.automatedBusy = false
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'draft.snapshot.response') {
      applySnapshot(outcome.value.snapshot, true)
      state.voiceMessage =
        outcome.value.outcome === 'applied'
          ? 'Last recording segment removed; older content was preserved.'
          : 'The last recording can no longer be removed as one unchanged segment.'
    } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
      state.voiceMessage = outcome.value.message
    } else {
      state.voiceMessage = 'Recording undo timed out. The existing draft was preserved.'
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
    if (
      !registry.resolve(payload.requestId, payload) &&
      !normalizationRegistry.resolve(payload.requestId, payload)
    ) {
      sendRegistry.resolve(payload.requestId, payload)
    }
  })
  disposers.push(removeBackendListener)

  const refreshFromHost = () => void refreshHostState()
  const handlePermissionChange = () => {
    if (activeRecording) {
      cancelActiveRecording('Recording cancelled because permissions changed.')
    }
    void refreshHostState()
  }
  const handleChatSwitch = () => {
    cancelActiveRecording('Recording cancelled because the active chat changed.')
    if (state.pendingProposal) rejectNormalizationProposal()
    void refreshHostState()
  }
  const openFloatingComposer = () => {
    floatingComposerMount.append(composerSurface)
    floatingWidget.setVisible(true)
    void refreshHostState()
    window.setTimeout(() => editor.focus(), 0)
  }
  const closeFloatingComposer = () => {
    if (activeRecording) {
      cancelActiveRecording('Recording cancelled because the floating composer was closed.')
    }
    drawerComposerMount.append(composerSurface)
    floatingWidget.setVisible(false)
  }
  disposers.push(ctx.events.on('PERMISSION_CHANGED', handlePermissionChange))
  disposers.push(ctx.events.on('CHAT_SWITCHED', handleChatSwitch))
  disposers.push(
    ctx.ui.events.onDrawerChange((drawer) => {
      if (
        activeRecording &&
        !floatingWidget.isVisible() &&
        (!drawer.open || drawer.tabId !== tab.tabId)
      ) {
        cancelActiveRecording('Recording cancelled because JarvisType was closed.')
      }
    }),
  )
  disposers.push(tab.onActivate(refreshFromHost))
  disposers.push(inputAction.onClick(openFloatingComposer))

  const handleVisibility = () => {
    if (document.visibilityState === 'visible') void refreshHostState()
  }
  const handlePageHide = () =>
    cancelActiveRecording('Recording cancelled because the page is closing.')
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
  const handleRecordClick = () => void handleRecording('message')
  const handleRecordEditClick = () => void handleRecording('edit')
  const handleCancelRecordingClick = () =>
    cancelActiveRecording('Recording cancelled. No transcript was appended.')
  const handleCancelEditRecordingClick = () =>
    cancelActiveRecording('Edit recording cancelled. The draft was not changed.')
  const handleUndoRecordingClick = () => void handleUndoRecording()
  const handleSendClick = () => void handleSend()
  const handleAcceptProposalClick = () => void acceptNormalizationProposal()
  const handleRejectProposalClick = () => rejectNormalizationProposal()
  const handleAcceptEditClick = () => void acceptEditProposal()
  const handleRejectEditClick = () => rejectEditProposal()
  const handleEditCandidateClick = (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      '[data-edit-candidate-id]',
    )
    if (button?.dataset.editCandidateId) void selectEditCandidate(button.dataset.editCandidateId)
  }
  const handleCancelEditCandidatesClick = () => cancelEditCandidateSelection()
  const handleSaveSettingsClick = () => void saveSettings()
  const handleNormalizationConnectionChange = () => {
    state.settings.normalizationConnectionId = normalizationConnectionSelect.value || null
    state.settings.normalizationModelOverride = ''
    render()
    normalizationModelPicker.refresh()
  }
  const handleSaveGlossaryClick = () => void saveGlossaryEntry('drawer')
  const handleFloatingSaveGlossaryClick = () => void saveGlossaryEntry('floating')
  const handleCancelGlossaryClick = () => {
    clearGlossaryForm()
    render()
  }
  const handleUndoGlossaryClick = () => void undoGlossary()
  const handleGlossarySearchInput = () => {
    drawerGlossaryQuery = glossarySearchInput.value
    render()
  }
  const handleFloatingGlossarySearchInput = () => {
    floatingGlossaryQuery = floatingGlossarySearchInput.value
    render()
  }
  const handleOpenFloating = () => openFloatingComposer()
  const handleCloseFloating = () => closeFloatingComposer()
  const handleCommandToggle = () => {
    const expanded = floatingCommandButton.getAttribute('aria-expanded') === 'true'
    floatingCommandButton.setAttribute('aria-expanded', String(!expanded))
    floatingCommandPanel.hidden = expanded
  }
  const handleCommandSearch = () => {
    const query = floatingCommandSearch.value.trim().toLocaleLowerCase()
    for (const item of floatingCommandPanel.querySelectorAll<HTMLElement>('[data-command-item]')) {
      item.hidden = !!query && !item.textContent?.toLocaleLowerCase().includes(query)
    }
    for (const group of floatingCommandPanel.querySelectorAll<HTMLElement>(
      '[data-command-group]',
    )) {
      group.hidden = !group.querySelector('[data-command-item]:not([hidden])')
    }
  }
  const handleViewportResize = () => {
    floatingWidget.setSize(
      Math.min(430, Math.max(300, window.innerWidth - 24)),
      Math.min(720, Math.max(420, window.innerHeight - 24)),
    )
  }
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('focus', handleFocus)
  window.addEventListener('resize', handleViewportResize)
  retryButton.addEventListener('click', handleRetry)
  switchDraftButton.addEventListener('click', handleSwitchDraft)
  editor.addEventListener('input', handleEditorInput)
  recordButton.addEventListener('click', handleRecordClick)
  recordEditButton.addEventListener('click', handleRecordEditClick)
  cancelEditRecordingButton.addEventListener('click', handleCancelEditRecordingClick)
  cancelRecordingButton.addEventListener('click', handleCancelRecordingClick)
  undoRecordingButton.addEventListener('click', handleUndoRecordingClick)
  undoButton.addEventListener('click', handleUndoClick)
  historyButton.addEventListener('click', handleHistoryToggle)
  sendButton.addEventListener('click', handleSendClick)
  acceptProposalButton.addEventListener('click', handleAcceptProposalClick)
  rejectProposalButton.addEventListener('click', handleRejectProposalClick)
  acceptEditButton.addEventListener('click', handleAcceptEditClick)
  rejectEditButton.addEventListener('click', handleRejectEditClick)
  editCandidatesList.addEventListener('click', handleEditCandidateClick)
  cancelEditCandidatesButton.addEventListener('click', handleCancelEditCandidatesClick)
  saveSettingsButton.addEventListener('click', handleSaveSettingsClick)
  normalizationConnectionSelect.addEventListener('change', handleNormalizationConnectionChange)
  glossarySaveButton.addEventListener('click', handleSaveGlossaryClick)
  glossaryCancelButton.addEventListener('click', handleCancelGlossaryClick)
  glossaryUndoButton.addEventListener('click', handleUndoGlossaryClick)
  glossaryList.addEventListener('click', handleGlossaryListClick)
  glossarySearchInput.addEventListener('input', handleGlossarySearchInput)
  floatingGlossarySaveButton.addEventListener('click', handleFloatingSaveGlossaryClick)
  floatingGlossaryCancelButton.addEventListener('click', handleCancelGlossaryClick)
  floatingGlossaryUndoButton.addEventListener('click', handleUndoGlossaryClick)
  floatingGlossaryList.addEventListener('click', handleGlossaryListClick)
  floatingGlossarySearchInput.addEventListener('input', handleFloatingGlossarySearchInput)
  drawerOpenButton.addEventListener('click', handleOpenFloating)
  floatingCloseButton.addEventListener('click', handleCloseFloating)
  floatingCommandButton.addEventListener('click', handleCommandToggle)
  floatingCommandSearch.addEventListener('input', handleCommandSearch)

  render()
  void checkBackend()
  ctx.ready()

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    alive = false
    cancelActiveRecording('Recording cancelled during extension cleanup.')
    clearRecordingTimers()
    if (editGroupTimer) clearTimeout(editGroupTimer)
    registry.cancelAll()
    normalizationRegistry.cancelAll()
    sendRegistry.cancelAll()
    for (const dispose of disposers.splice(0)) dispose()
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('pagehide', handlePageHide)
    window.removeEventListener('focus', handleFocus)
    window.removeEventListener('resize', handleViewportResize)
    retryButton.removeEventListener('click', handleRetry)
    switchDraftButton.removeEventListener('click', handleSwitchDraft)
    editor.removeEventListener('input', handleEditorInput)
    recordButton.removeEventListener('click', handleRecordClick)
    recordEditButton.removeEventListener('click', handleRecordEditClick)
    cancelEditRecordingButton.removeEventListener('click', handleCancelEditRecordingClick)
    cancelRecordingButton.removeEventListener('click', handleCancelRecordingClick)
    undoRecordingButton.removeEventListener('click', handleUndoRecordingClick)
    undoButton.removeEventListener('click', handleUndoClick)
    historyButton.removeEventListener('click', handleHistoryToggle)
    sendButton.removeEventListener('click', handleSendClick)
    acceptProposalButton.removeEventListener('click', handleAcceptProposalClick)
    rejectProposalButton.removeEventListener('click', handleRejectProposalClick)
    acceptEditButton.removeEventListener('click', handleAcceptEditClick)
    rejectEditButton.removeEventListener('click', handleRejectEditClick)
    editCandidatesList.removeEventListener('click', handleEditCandidateClick)
    cancelEditCandidatesButton.removeEventListener('click', handleCancelEditCandidatesClick)
    saveSettingsButton.removeEventListener('click', handleSaveSettingsClick)
    normalizationConnectionSelect.removeEventListener('change', handleNormalizationConnectionChange)
    glossarySaveButton.removeEventListener('click', handleSaveGlossaryClick)
    glossaryCancelButton.removeEventListener('click', handleCancelGlossaryClick)
    glossaryUndoButton.removeEventListener('click', handleUndoGlossaryClick)
    glossaryList.removeEventListener('click', handleGlossaryListClick)
    glossarySearchInput.removeEventListener('input', handleGlossarySearchInput)
    floatingGlossarySaveButton.removeEventListener('click', handleFloatingSaveGlossaryClick)
    floatingGlossaryCancelButton.removeEventListener('click', handleCancelGlossaryClick)
    floatingGlossaryUndoButton.removeEventListener('click', handleUndoGlossaryClick)
    floatingGlossaryList.removeEventListener('click', handleGlossaryListClick)
    floatingGlossarySearchInput.removeEventListener('input', handleFloatingGlossarySearchInput)
    drawerOpenButton.removeEventListener('click', handleOpenFloating)
    floatingCloseButton.removeEventListener('click', handleCloseFloating)
    floatingCommandButton.removeEventListener('click', handleCommandToggle)
    floatingCommandSearch.removeEventListener('input', handleCommandSearch)
    normalizationModelPicker.destroy()
    floatingWidget.destroy()
    inputAction.destroy()
    tab.destroy()
  }
  const removeTeardownListener = ctx.onTeardown?.(cleanup)
  if (removeTeardownListener) disposers.push(removeTeardownListener)
  return cleanup
}

function renderConnectionOptions(
  select: HTMLSelectElement,
  connections: readonly NormalizationConnectionOption[],
  selectedId: string | null,
): void {
  select.replaceChildren()
  const main = document.createElement('option')
  main.value = ''
  main.textContent = 'Main connection'
  select.append(main)
  for (const connection of connections) {
    const option = document.createElement('option')
    option.value = connection.id
    option.textContent = `${connection.name} — ${connection.provider}${connection.model ? ` — ${connection.model}` : ''}${connection.isDefault ? ' (default)' : ''}`
    select.append(option)
  }
  if (selectedId && !connections.some((connection) => connection.id === selectedId)) {
    const unavailable = document.createElement('option')
    unavailable.value = selectedId
    unavailable.textContent = 'Previously selected connection (unavailable)'
    select.append(unavailable)
  }
  select.value = selectedId ?? ''
}

function renderGlossary(
  container: HTMLElement,
  entries: readonly GlossaryEntry[],
  query = '',
): void {
  container.replaceChildren()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleEntries = normalizedQuery
    ? entries.filter((entry) =>
        [entry.canonical, ...entry.variants, entry.hint].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery),
        ),
      )
    : [...entries]
  container.classList.toggle('jt-glossary--scrolling', visibleEntries.length > 6)
  if (!visibleEntries.length) {
    const empty = document.createElement('p')
    empty.className = 'jt-empty'
    empty.textContent = entries.length
      ? 'No glossary entries match this search.'
      : 'No glossary entries yet. Confirmed explicit spelling can add them automatically.'
    container.append(empty)
    return
  }
  for (const entry of visibleEntries) {
    const row = document.createElement('div')
    row.className = 'jt-glossary-row'
    const text = document.createElement('p')
    text.textContent = `${entry.canonical}${entry.variants.length ? ` — heard as: ${entry.variants.join(', ')}` : ''}${entry.hint ? ` — ${entry.hint}` : ''} — source: ${entry.source === 'explicit-spelling' ? 'explicit spelling' : 'manual'} — used ${entry.useCount} ${entry.useCount === 1 ? 'time' : 'times'}`
    const actions = document.createElement('div')
    actions.className = 'jt-actions'
    for (const action of ['edit', 'delete'] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.glossaryAction = action
      button.dataset.entryId = entry.id
      button.textContent = action === 'edit' ? 'Edit' : 'Delete'
      actions.append(button)
    }
    row.append(text, actions)
    container.append(row)
  }
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
    const kind =
      entry.kind === 'undo'
        ? 'Undo'
        : entry.kind === 'recording-append'
          ? 'Recording appended'
          : entry.kind === 'automated-edit'
            ? 'Approved voice edit'
            : entry.kind === 'recording-undo'
              ? 'Recording removed'
              : 'Manual edit'
    const affected = entry.diff.affectedParagraphOrdinals.length
      ? ` · paragraph ${entry.diff.affectedParagraphOrdinals.join(', ')}`
      : ''
    item.textContent = `${kind} · v${entry.beforeVersion} → v${entry.afterVersion}${affected}`
    list.append(item)
  }
}

function joinTranscriptUpdates(finalSegments: string[], interimText: string): string {
  return [...finalSegments, interimText].filter(Boolean).join(' ').trim()
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function describeRecordingError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError') {
    return 'Microphone access was denied. No transcript was appended.'
  }
  if (name === 'NotFoundError') {
    return 'No microphone is available. No transcript was appended.'
  }
  if (name === 'NotReadableError') {
    return 'The microphone is unavailable or already in use. No transcript was appended.'
  }
  if (name === 'AbortError') return 'Recording cancelled. No transcript was appended.'
  return 'Speech transcription failed. No transcript was appended; you may record again.'
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

function floatingMarkup(): string {
  const commands = COMMAND_GROUPS.map(
    (group) => `
      <section data-command-group>
        <h4>${group.title}</h4>
        <ul>
          ${group.examples
            .map(
              ([activation, example]) =>
                `<li data-command-item><strong>${activation}</strong>: ${example}</li>`,
            )
            .join('')}
        </ul>
      </section>`,
  ).join('')
  return `
    <aside class="jt-shell jt-floating" aria-label="JarvisType floating composer">
      <header class="jt-floating__bar">
        <h2>JarvisType</h2>
        <button type="button" data-close-floating aria-label="Close JarvisType">Close</button>
      </header>
      <div class="jt-floating__body">
        <div data-floating-composer-mount></div>
        <div class="jt-floating__tools">
          <button type="button" data-command-toggle aria-expanded="false" aria-controls="jt-command-panel">Command list</button>
          <section id="jt-command-panel" data-command-panel hidden aria-label="Available voice edit commands">
            <label class="jt-form-grid">Search commands<input type="search" placeholder="Search commands or examples" data-command-search></label>
            <div class="jt-command-list">${commands}</div>
          </section>
          <details>
            <summary>Glossary</summary>
            <div class="jt-form-grid">
              <label>Search glossary<input type="search" placeholder="Search spellings, variants, or hints" data-floating-glossary-search></label>
              <label>Canonical spelling<input type="text" maxlength="200" placeholder="Pip-Boy" data-floating-glossary-canonical></label>
              <label>Heard-as variants<input type="text" maxlength="1000" placeholder="pip boy, Pipboy" data-floating-glossary-variants></label>
              <label>Optional hint<input type="text" maxlength="500" placeholder="Fallout wrist device" data-floating-glossary-hint></label>
            </div>
            <div class="jt-actions">
              <button type="button" data-floating-glossary-save>Add entry</button>
              <button type="button" data-floating-glossary-cancel hidden>Cancel edit</button>
              <button type="button" data-floating-glossary-undo disabled>Undo change</button>
            </div>
            <div class="jt-glossary" data-floating-glossary-list></div>
          </details>
        </div>
      </div>
    </aside>`
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
      .jt-voice { display: grid; gap: .55rem; padding: .7rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 6%, transparent); }
      .jt-voice__meta { display: flex; flex-wrap: wrap; gap: .35rem 1rem; font-size: .8rem; opacity: .78; }
      .jt-voice__transcript { min-height: 2.5rem; padding: .55rem; border-left: .2rem solid color-mix(in srgb, currentColor 35%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; }
      .jt-voice__transcript--provisional { font-style: italic; opacity: .72; }
      .jt-voice [data-phase="recording"] { color: #e53e3e; font-weight: 700; }
      .jt-diff { display: grid; gap: .4rem; padding: .65rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 6%, transparent); }
      .jt-diff__line { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: .5rem; }
      .jt-diff del, .jt-diff ins { white-space: pre-wrap; overflow-wrap: anywhere; }
      .jt-history { max-height: 12rem; overflow: auto; padding-inline-start: 1.4rem; }
      .jt-form-grid { display: grid; gap: .5rem; }
      .jt-form-grid label { display: grid; gap: .25rem; font-size: .85rem; }
      .jt-form-grid input, .jt-form-grid select { width: 100%; min-width: 0; min-height: 2.3rem; padding: .4rem .55rem; }
      .jt-proposal { display: grid; gap: .55rem; padding: .7rem; border: 1px solid #d69e2e; border-radius: .5rem; }
      .jt-proposal pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; padding: .55rem; background: color-mix(in srgb, currentColor 6%, transparent); }
      .jt-candidate-list { display: grid; gap: .5rem; }
      .jt-candidate-list button { text-align: start; white-space: normal; }
      .jt-glossary { display: grid; gap: .55rem; }
      .jt-glossary--scrolling { max-height: 22rem; overflow-y: auto; overscroll-behavior: contain; padding-right: .25rem; }
      .jt-glossary-row { display: grid; gap: .35rem; padding: .55rem; border-radius: .45rem; background: color-mix(in srgb, currentColor 6%, transparent); overflow-wrap: anywhere; }
      .jt-launch { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: center; padding: .8rem; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: .75rem; }
      .jt-launch button { font-weight: 700; }
      .jt-floating { box-sizing: border-box; display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; overflow: hidden; border: 1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius: .9rem; background: var(--background, #171717); color: var(--foreground, inherit); box-shadow: 0 18px 55px rgb(0 0 0 / .38); }
      .jt-floating__bar { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .55rem .7rem; border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); cursor: move; }
      .jt-floating__bar h2 { font-size: 1rem; }
      .jt-floating__body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
      .jt-floating__body > .jt-shell__card { margin: .75rem; }
      .jt-floating__tools { display: grid; gap: .65rem; padding: 0 .75rem .75rem; }
      .jt-floating details { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: .6rem; padding: .6rem; }
      .jt-floating summary { cursor: pointer; font-weight: 700; }
      .jt-command-list { display: grid; gap: .75rem; margin-top: .65rem; }
      .jt-command-list ul { display: grid; gap: .4rem; margin: .35rem 0 0; padding-left: 1.2rem; }
      .jt-empty { opacity: .65; font-style: italic; }
      .jt-shell [hidden] { display: none !important; }
      [data-state="ready"] { color: #38a169; }
      [data-state="unavailable"] { color: #e53e3e; }
    </style>
    <main class="jt-shell" aria-labelledby="jt-title">
      <header class="jt-shell__header">
        <p class="jt-shell__eyebrow">Phase 6.5 floating composer · v${APP_VERSION}</p>
        <h2 id="jt-title">JarvisType</h2>
        <p>Compose privately, review every change, and send only when you confirm.</p>
      </header>

      <section class="jt-launch" aria-label="Floating composer launcher">
        <div>
          <h3>Voice composer</h3>
          <p class="jt-draft-meta">Opens near the message input and keeps this drawer available for glossary and settings.</p>
        </div>
        <button type="button" data-open-floating aria-label="Open JarvisType floating composer">Open JarvisType</button>
      </section>

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

      <div data-drawer-composer-mount>
      <section class="jt-shell__card" data-composer-surface aria-labelledby="jt-draft-title">
        <h3 id="jt-draft-title">Working draft</h3>
        <textarea class="jt-draft-editor" data-draft-editor maxlength="${MAX_DRAFT_CHARACTERS}" aria-describedby="jt-draft-help" aria-label="JarvisType private working draft" disabled></textarea>
        <p id="jt-draft-help">Paragraph numbers are shown separately and are never copied or sent.</p>
        <p class="jt-draft-meta" data-draft-meta>Draft not loaded</p>

        <h4>Numbered paragraphs</h4>
        <div class="jt-paragraphs" data-paragraph-list aria-live="polite"></div>

        <section class="jt-voice" aria-labelledby="jt-voice-title">
          <h4 id="jt-voice-title">Voice message segment</h4>
          <p role="status" aria-live="polite" data-voice-status>Ready to record a message segment.</p>
          <div class="jt-voice__meta">
            <span data-voice-elapsed>Elapsed: 0:00</span>
            <span data-voice-provider>Provider: Lumiverse selection</span>
            <span data-voice-segment-count>Committed recording segments: 0</span>
          </div>
          <p class="jt-voice__transcript jt-voice__transcript--provisional" data-voice-provisional hidden></p>
          <p class="jt-voice__transcript" data-voice-final>No completed recording yet.</p>
          <section class="jt-proposal" data-normalization-proposal hidden aria-labelledby="jt-proposal-title">
            <h4 id="jt-proposal-title">Review normalized transcript</h4>
            <p><strong>Raw provider transcript</strong></p>
            <pre data-proposal-raw></pre>
            <p><strong>Proposed text</strong></p>
            <pre data-proposal-candidate></pre>
            <p class="jt-draft-meta" data-proposal-meta></p>
            <div class="jt-actions">
              <button type="button" data-proposal-accept>Accept &amp; append</button>
              <button type="button" data-proposal-reject>Reject</button>
            </div>
          </section>
          <div class="jt-actions" aria-label="Voice composition controls">
            <button type="button" data-record-message disabled>Record Message</button>
            <button type="button" data-cancel-recording hidden>Cancel Recording</button>
            <button type="button" data-undo-recording disabled>Undo Last Recording</button>
          </div>
        </section>

        <section class="jt-proposal" data-edit-candidates hidden aria-labelledby="jt-edit-candidates-title">
          <h4 id="jt-edit-candidates-title">Choose the intended edit target</h4>
          <p><strong>Spoken instruction</strong></p>
          <pre data-edit-candidates-instruction></pre>
          <div class="jt-candidate-list" data-edit-candidates-list></div>
          <div class="jt-actions">
            <button type="button" data-edit-candidates-cancel>Cancel selection</button>
          </div>
        </section>
        <section class="jt-proposal" data-edit-proposal hidden aria-labelledby="jt-edit-proposal-title">
          <h4 id="jt-edit-proposal-title">Review interpreted edit</h4>
          <p><strong>Spoken instruction</strong></p>
          <pre data-edit-instruction></pre>
          <p><strong>Structured operations</strong></p>
          <pre data-edit-operations></pre>
          <p><strong>Before</strong></p>
          <pre data-edit-before></pre>
          <p><strong>Proposed draft</strong></p>
          <pre data-edit-after></pre>
          <div class="jt-actions">
            <button type="button" data-edit-accept>Accept edit</button>
            <button type="button" data-edit-reject>Reject</button>
          </div>
        </section>
        <div class="jt-actions" aria-label="Editing voice controls">
          <button type="button" data-record-edit disabled>Record Edit</button>
          <button type="button" data-cancel-edit-recording hidden>Cancel Edit Recording</button>
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
      </div>

      <section class="jt-shell__card" aria-labelledby="jt-context-title">
        <h3 id="jt-context-title">Context and glossary</h3>
        <p class="jt-shell__notice">JarvisType sends the selected recent chat text, current draft tail, and glossary to the normalization connection selected below only after speech-to-text finishes. The normalization model receives text, never audio. Lumiverse STT remains independently managed by the host and receives no added context. Set recent messages to 0 to exclude chat history.</p>
        <div class="jt-form-grid">
          <label>Recent messages (0–20, default 5)<input type="number" min="0" max="20" step="1" value="5" data-context-count></label>
          <label><span><input type="checkbox" checked data-context-enabled> Use bounded context normalization</span></label>
          <label>Normalization connection<select data-normalization-connection><option value="">Main connection</option></select></label>
          <label><span>Normalization model (optional override)</span><div data-normalization-model></div></label>
        </div>
        <div class="jt-actions"><button type="button" data-settings-save>Save context settings</button></div>
        <p role="status" aria-live="polite" data-phase4-status>Loading context and glossary settings…</p>

        <h4>Personal glossary</h4>
        <label class="jt-form-grid">Search glossary<input type="search" placeholder="Search spellings, variants, or hints" data-glossary-search></label>
        <div class="jt-form-grid">
          <label>Canonical spelling<input type="text" maxlength="200" placeholder="Pip-Boy" data-glossary-canonical></label>
          <label>Heard-as variants, comma separated<input type="text" maxlength="1000" placeholder="pip boy, Pipboy" data-glossary-variants></label>
          <label>Optional reference or hint<input type="text" maxlength="500" placeholder="Fallout wrist device" data-glossary-hint></label>
        </div>
        <div class="jt-actions">
          <button type="button" data-glossary-save>Add entry</button>
          <button type="button" data-glossary-cancel hidden>Cancel edit</button>
          <button type="button" data-glossary-undo disabled>Undo glossary change</button>
        </div>
        <div class="jt-glossary" data-glossary-list></div>
      </section>
    </main>
  `
}

function requireElement<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`JarvisType shell is missing ${selector}`)
  return element
}
