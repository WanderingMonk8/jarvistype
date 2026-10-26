import type {
  SpindleFrontendContext,
  SpindleSTTSession,
  SpindleSTTTranscript,
} from 'lumiverse-spindle-types'

import { MAX_DRAFT_CHARACTERS, type DraftSnapshot } from './domain/draft-session'
import type { EditTarget } from './domain/edit-pipeline'
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
const NARROW_COMPOSER_BREAKPOINT_PX = 760

function getViewportSize(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  }
}

function getFloatingWidgetSize(): { width: number; height: number } {
  const viewport = getViewportSize()
  if (viewport.width < NARROW_COMPOSER_BREAKPOINT_PX) {
    return {
      width: Math.max(1, Math.min(430, viewport.width - 24)),
      height: Math.max(1, Math.min(714, viewport.height - 24)),
    }
  }
  return {
    width: Math.max(1, Math.min(960, viewport.width - 48)),
    height: Math.max(1, Math.min(624, viewport.height - 48)),
  }
}

export const JARVISTYPE_ICON_SVG = `
  <svg class="jt-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M18 4v10.25A5.75 5.75 0 0 1 12.25 20H10a4 4 0 0 1-4-4"/>
    <path d="M4 9h2.1l1.3-3.25 2.15 6.5 1.7-4.25 1.35 2H18"/>
  </svg>`

export const COMMAND_GROUPS = [
  {
    title: 'Dictation',
    examples: [
      ['Record Message', 'Record Message, then dictate a new segment.'],
      ['Record Edit', 'Record Edit, then describe a change to the existing draft.'],
    ],
  },
  {
    title: 'Punctuation and layout',
    examples: [
      [
        'Spoken punctuation',
        'Say “period,” “comma,” “colon,” “semicolon,” “question mark,” “exclamation mark,” “ellipsis,” “apostrophe,” “hyphen,” “dash,” “en dash,” “em dash,” “open parenthesis” or “open paren,” “close parenthesis” or “close paren,” “open bracket,” “close bracket,” “begin bracket” and “end bracket” for angle brackets, “new line,” or “new paragraph.”',
      ],
      [
        'Quotations',
        'Say “quote” or “quotation” at both ends of a quotation; use “begin speech” and “end speech,” or “beginning speech” and “ending speech.” For single quotations, say “single quote” or “single quotation” at both ends, or “begin single” and “end single.”',
      ],
      ['Explicit punctuation', 'Say “insert period,” “punctuation colon,” or “command new line.”'],
      [
        'Literal punctuation word',
        'Say “the word period,” “literal dash,” “the phrase new paragraph,” or “the words open parenthesis” to dictate the words themselves.',
      ],
    ],
  },
  {
    title: 'Replace and insert',
    examples: [
      [
        'Replace',
        'Replace, change, swap, or substitute a target—for example, “Change ‘pending’ to ‘approved’ in paragraph 2.”',
      ],
      ['Insert before', 'Insert, add, place, or put “Urgent:” before the first sentence.'],
      [
        'Insert after',
        'Insert, add, place, or put a new paragraph after paragraph 2 that says “The route is approved.”',
      ],
      [
        'Append',
        'Append, add to the end, place at the end, put at the end, or tack onto the end of paragraph 1.',
      ],
      [
        'Prepend',
        'Prepend, add to the beginning, place at the start, or put at the beginning of paragraph 1.',
      ],
    ],
  },
  {
    title: 'Delete and move',
    examples: [
      [
        'Delete',
        'Say “delete,” “remove,” “take off,” “take out,” “erase,” or “cut,” followed by the target—for example, “Take off the second sentence in paragraph 1.”',
      ],
      ['Move', 'Move, relocate, or shift “approved” before “pending” in paragraph 1.'],
      ['Move before', 'Move paragraph 3 before paragraph 1.'],
      ['Move after', 'Move paragraph 1 after paragraph 2.'],
    ],
  },
  {
    title: 'Paragraphs',
    examples: [
      ['Split', 'Split, break, or divide paragraph 1 after “The launch checklist is ready.”'],
      ['Join', 'Join, merge, or combine paragraph 1 with the following paragraph.'],
    ],
  },
  {
    title: 'Capitalization and spelling',
    examples: [
      ['Uppercase', 'Uppercase the draft, or make the entire draft all caps.'],
      ['Lowercase', 'Lowercase paragraph 2, or make paragraph 2 lowercase.'],
      ['Capitalize', 'Capitalize “the hawk” to make every word title-cased: “The Hawk.”'],
      ['Spelled form', 'Replace Kalora with capitalized C-A-E-L-O-R-A.'],
      [
        'As in reference',
        'Use a qualified “as in” reference anywhere you dictate new edit text: replace, insert before or after, prepend, or append. For example, “Prepend ‘I nod,’ as in nodding one’s head, to the first sentence.” The intended word must occur immediately before “as in” and repeat afterward exactly or as a clear inflection; otherwise the wording remains literal.',
      ],
    ],
  },
  {
    title: 'Targets and multiple changes',
    examples: [
      [
        'Fuzzy target fallback',
        'If a spoken target has no exact match, JarvisType can use one uniquely similar written or sound-alike phrase, including a compounded transcript such as “mouthlet” for “Mao let.”',
      ],
      [
        'Punctuation targets',
        'Say “the second quote in paragraph 1”, “the last period in paragraph 1”, or “the quote after the phrase ‘this is very good’” with move, replace, insert, or delete.',
      ],
      [
        'Multiple changes',
        'In paragraph 1 replace pending with approved, and in paragraph 2 replace incomplete with complete.',
      ],
    ],
  },
] as const

function describeEditDestination(destination: EditTarget | undefined): string {
  if (!destination) return ''
  if (destination.punctuation) {
    const occurrence = destination.occurrence ? `${destination.occurrence} ` : ''
    const relative = destination.relativeToText
      ? ` ${destination.relativePosition} “${destination.relativeToText}”`
      : ''
    const paragraph = destination.paragraphOrdinal
      ? ` in paragraph ${destination.paragraphOrdinal}`
      : ''
    return ` → ${occurrence}${destination.punctuation.replaceAll('_', ' ')}${relative}${paragraph}`
  }
  const anchor = destination.exactText ?? destination.approximateText
  if (anchor) {
    const paragraph = destination.paragraphOrdinal
      ? ` in paragraph ${destination.paragraphOrdinal}`
      : ''
    return ` → “${anchor}”${paragraph}`
  }
  return destination.paragraphOrdinal ? ` → paragraph ${destination.paragraphOrdinal}` : ''
}

interface ActiveRecording {
  chatId: string
  runId: string
  operationId: string
  session: SpindleSTTSession
  finalSegments: string[]
  interimText: string
  quotationBoundaryHint: 'double' | 'single' | null
  mode: 'message' | 'edit'
}

interface ComposerState {
  activeChatId: string | null
  voiceChatId: string | null
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
  decisionModelAvailable: boolean | null
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
    iconSvg: JARVISTYPE_ICON_SVG,
  })
  const inputAction = ctx.ui.registerInputBarAction({
    id: 'jarvistype-open',
    label: 'JarvisType',
    subtitle: 'Open private composition draft',
    iconSvg: JARVISTYPE_ICON_SVG,
  })
  const composerToolsMount = ctx.ui.mount('chat_input_tools_left')
  const composerLauncherStyle = document.createElement('style')
  composerLauncherStyle.textContent = `
    .jt-composer-launcher { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 2.25rem; height: 2.25rem; padding: .45rem; border: 0; border-radius: .5rem; background: transparent; color: inherit; line-height: 1; cursor: pointer; opacity: .78; }
    .jt-composer-launcher .jt-brand-icon { width: 1.35rem; height: 1.35rem; flex: 0 0 auto; }
    .jt-composer-launcher:hover { background: color-mix(in srgb, currentColor 9%, transparent); opacity: 1; }
    .jt-composer-launcher:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; opacity: 1; }`
  const composerLauncher = document.createElement('button')
  composerLauncher.type = 'button'
  composerLauncher.className = 'jt-composer-launcher'
  composerLauncher.setAttribute('aria-label', 'Open JarvisType voice composer')
  composerLauncher.title = 'Open JarvisType voice composer'
  composerLauncher.innerHTML = JARVISTYPE_ICON_SVG
  composerToolsMount.append(composerLauncherStyle, composerLauncher)

  const initialFloatingSize = getFloatingWidgetSize()
  const initialViewport = getViewportSize()
  const floatingWidget = ctx.ui.createFloatWidget({
    width: initialFloatingSize.width,
    height: initialFloatingSize.height,
    initialPosition: {
      x: Math.max(12, initialViewport.width - initialFloatingSize.width - 24),
      y: Math.max(12, initialViewport.height - initialFloatingSize.height - 24),
    },
    snapToEdge: true,
    tooltip: 'JarvisType voice composer',
    chromeless: true,
    touchScrollMode: 'native',
  })
  floatingWidget.root.classList.add('jt-floating-host')
  floatingWidget.root.tabIndex = 0
  floatingWidget.root.setAttribute('aria-label', 'Scrollable JarvisType workspace')
  floatingWidget.root.style.boxSizing = 'border-box'
  floatingWidget.root.style.width = '100%'
  floatingWidget.root.style.height = '100%'
  floatingWidget.root.style.minHeight = '0'
  floatingWidget.root.style.overflowX = 'hidden'
  floatingWidget.root.style.setProperty('overflow-y', 'auto', 'important')
  floatingWidget.root.style.overscrollBehavior = 'contain'
  floatingWidget.root.style.touchAction = 'pan-y'
  floatingWidget.root.style.scrollbarGutter = 'stable'
  floatingWidget.root.style.setProperty('-webkit-overflow-scrolling', 'touch')
  floatingWidget.root.innerHTML = floatingMarkup()
  floatingWidget.setVisible(false)

  tab.root.innerHTML = shellMarkup()
  const shellStyle = tab.root.querySelector('style')
  if (shellStyle) floatingWidget.root.prepend(shellStyle.cloneNode(true))
  const composerSurface = requireElement<HTMLElement>(tab.root, '[data-composer-surface]')
  const composerBootstrap = requireElement<HTMLElement>(tab.root, '[data-composer-bootstrap]')
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
  const redoButton = requireElement<HTMLButtonElement>(tab.root, '[data-redo]')
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
  const decisionBar = requireElement<HTMLElement>(tab.root, '[data-decision-bar]')
  const decisionSummary = requireElement<HTMLElement>(tab.root, '[data-decision-summary]')
  const contextCountInput = requireElement<HTMLInputElement>(tab.root, '[data-context-count]')
  const referenceCacheLimitInput = requireElement<HTMLInputElement>(
    tab.root,
    '[data-reference-cache-limit]',
  )
  const contextualToggle = requireElement<HTMLInputElement>(tab.root, '[data-context-enabled]')
  const grammarRepairWarning = requireElement<HTMLElement>(
    tab.root,
    '[data-grammar-repair-warning]',
  )
  const grammarRepairSelect = requireElement<HTMLSelectElement>(
    tab.root,
    '[data-grammar-repair-mode]',
  )
  const debugEnabledToggle = requireElement<HTMLInputElement>(tab.root, '[data-debug-enabled]')
  const debugOutput = requireElement<HTMLTextAreaElement>(tab.root, '[data-debug-output]')
  const debugRefreshButton = requireElement<HTMLButtonElement>(tab.root, '[data-debug-refresh]')
  const debugCopyButton = requireElement<HTMLButtonElement>(tab.root, '[data-debug-copy]')
  const debugClearButton = requireElement<HTMLButtonElement>(tab.root, '[data-debug-clear]')
  const debugStatus = requireElement<HTMLElement>(tab.root, '[data-debug-status]')
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

  // Resolve every composer control while the bootstrap surface is still under the drawer root.
  // The floating widget owns it permanently after setup; moving it earlier makes later queries fail.
  floatingComposerMount.append(composerSurface)
  composerBootstrap.remove()

  const state: ComposerState = {
    activeChatId: ctx.getActiveChat().chatId,
    voiceChatId: null,
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
      referenceCacheLimit: 30,
      contextualNormalizationEnabled: true,
      grammarRepairMode: 'off',
      normalizationConnectionId: null,
      normalizationModelOverride: '',
      debugLoggingEnabled: false,
    },
    normalizationConnections: [],
    glossary: [],
    canUndoGlossary: false,
    decisionModelAvailable: null,
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
      scheduleSettingsSave(0)
    },
  })
  let modelPickerConnectionId: string | null = null

  let alive = true
  let currentHealthRequestId: string | null = null
  let latestDraftLoadId = 0
  let chatTransitionId = 0
  let desiredText = ''
  let mutationDrainPromise: Promise<void> | null = null
  let editGroupId: string | null = null
  let editGroupTimer: ReturnType<typeof setTimeout> | null = null
  let paragraphRenderTimer: ReturnType<typeof setTimeout> | null = null
  let paragraphRenderDeadline: ReturnType<typeof setTimeout> | null = null
  let renderedParagraphText: string | null = null
  let sendFlowActive = false
  let activeRecording: ActiveRecording | null = null
  let recordingTimer: ReturnType<typeof setInterval> | null = null
  let recordingDeadline: ReturnType<typeof setTimeout> | null = null
  let recordingStartedAt = 0
  let editingGlossaryEntryId: string | undefined
  const lastRecordingByChat = new Map<
    string,
    { text: string; provider: string | null; elapsedMs: number }
  >()
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

  const flushParagraphPreview = () => {
    if (paragraphRenderTimer) clearTimeout(paragraphRenderTimer)
    if (paragraphRenderDeadline) clearTimeout(paragraphRenderDeadline)
    paragraphRenderTimer = null
    paragraphRenderDeadline = null
    if (!alive || renderedParagraphText === desiredText) return
    renderParagraphs(paragraphList, desiredText, applyParagraphEdit)
    renderedParagraphText = desiredText
  }

  const scheduleParagraphPreview = () => {
    if (renderedParagraphText === desiredText) return
    if (paragraphRenderTimer) clearTimeout(paragraphRenderTimer)
    paragraphRenderTimer = setTimeout(flushParagraphPreview, 200)
    paragraphRenderDeadline ??= setTimeout(flushParagraphPreview, 750)
  }

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
    scheduleParagraphPreview()
    renderDiff(state.snapshot, diffPanel, diffParagraphs, diffRemoved, diffAdded)
    renderHistory(historyList, state.snapshot)
    historyPanel.hidden = !state.historyExpanded
    historyButton.textContent = state.historyExpanded ? 'Hide' : 'History'
    historyButton.disabled = !state.snapshot || state.snapshot.history.length === 0
    redoButton.disabled =
      !editorEnabled ||
      state.saving ||
      !state.snapshot?.canRedo ||
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
    const undoIsRecording = Boolean(state.snapshot?.canUndoRecording)
    undoButton.disabled =
      !editorEnabled ||
      state.saving ||
      (undoIsRecording ? !recordingOwnerReady || voiceBusy() : !state.snapshot?.canUndo) ||
      desiredText !== state.snapshot?.cleanText
    const messageLive = activeRecording?.mode !== 'edit'
    recordButton.dataset.recordingState =
      messageLive && state.voicePhase === 'starting'
        ? 'starting'
        : messageLive && state.voicePhase === 'recording'
          ? 'recording'
          : ''
    const messageIsLive = state.voicePhase === 'recording' && activeRecording?.mode === 'message'
    const editIsLive = state.voicePhase === 'recording' && activeRecording?.mode === 'edit'
    recordButton.textContent =
      state.voicePhase === 'starting' && activeRecording?.mode !== 'edit'
        ? 'Preparing'
        : messageIsLive
          ? '■'
          : state.voicePhase === 'processing'
            ? 'Transcribing…'
            : state.voicePhase === 'committing'
              ? 'Normalizing…'
              : state.voicePhase === 'review'
                ? 'Review required'
                : 'Record'
    const recordingInProgress =
      activeRecording !== null &&
      (state.voicePhase === 'starting' || state.voicePhase === 'recording')
    recordButton.disabled = recordingInProgress
      ? activeRecording?.mode !== 'message'
      : !hasNativeStt() ||
        !recordingOwnerReady ||
        voiceBusy() ||
        state.voicePhase === 'processing' ||
        state.voicePhase === 'committing' ||
        state.voicePhase === 'review'
    const editLive = activeRecording?.mode === 'edit'
    recordEditButton.dataset.recordingState =
      editLive && state.voicePhase === 'starting'
        ? 'starting'
        : editLive && state.voicePhase === 'recording'
          ? 'recording'
          : ''
    recordButton.setAttribute('aria-label', messageIsLive ? 'Stop recording' : 'Record')
    recordButton.title = messageIsLive ? 'Stop recording' : ''
    recordButton.parentElement?.setAttribute('data-live', String(messageIsLive))
    recordEditButton.setAttribute('aria-label', editIsLive ? 'Stop edit recording' : 'Edit')
    recordEditButton.title = editIsLive ? 'Stop edit recording' : ''
    recordEditButton.parentElement?.setAttribute('data-live', String(editIsLive))
    recordEditButton.textContent =
      state.voicePhase === 'starting' && activeRecording?.mode === 'edit'
        ? 'Preparing'
        : editIsLive
          ? '■'
          : state.voicePhase === 'review' && state.pendingEditProposal
            ? 'Review required'
            : 'Edit'
    recordEditButton.disabled = recordingInProgress
      ? activeRecording?.mode !== 'edit'
      : !hasNativeStt() ||
        !recordingOwnerReady ||
        !desiredText.trim() ||
        voiceBusy() ||
        state.voicePhase === 'processing' ||
        state.voicePhase === 'committing' ||
        state.voicePhase === 'review'
    cancelRecordingButton.style.visibility = messageIsLive ? 'visible' : 'hidden'
    cancelRecordingButton.disabled = !messageIsLive
    cancelEditRecordingButton.style.visibility = editIsLive ? 'visible' : 'hidden'
    cancelEditRecordingButton.disabled = !activeRecording || activeRecording.mode !== 'edit'
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
      ? [
          ...editProposal.operations.map(
            (operation) =>
              `${operation.type} · paragraph ${operation.paragraphOrdinal}${describeEditDestination(operation.destination)} · ${operation.beforeText || '∅'} → ${operation.afterText || '∅'}`,
          ),
          ...(editProposal.grammarRepairChanges ?? []).map(
            (change) => `grammar repair · ${change}`,
          ),
        ].join('\n')
      : ''
    editProposalBefore.textContent = editProposal?.beforeText ?? ''
    editProposalAfter.textContent = editProposal?.afterText ?? ''
    acceptEditButton.disabled =
      !editProposal ||
      state.automatedBusy ||
      state.saving ||
      desiredText !== state.snapshot?.cleanText ||
      editProposal.expectedVersion !== state.snapshot?.draftVersion
    rejectEditButton.disabled = !editProposal || state.automatedBusy
    acceptEditButton.hidden = !editProposal
    rejectEditButton.hidden = !editProposal
    acceptProposalButton.hidden = !proposal
    rejectProposalButton.hidden = !proposal
    const activeReview = proposal ? proposalPanel : editProposal ? editProposalPanel : null
    decisionBar.hidden = !activeReview
    if (activeReview && decisionBar.previousElementSibling !== activeReview)
      activeReview.after(decisionBar)
    decisionSummary.textContent = editProposal
      ? `Review the edit: ${editProposal.explanation}`
      : proposal
        ? 'Review the normalized transcript before it is appended.'
        : ''
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
    referenceCacheLimitInput.value = String(state.settings.referenceCacheLimit ?? 30)
    contextualToggle.checked = state.settings.contextualNormalizationEnabled
    grammarRepairSelect.value = state.settings.grammarRepairMode
    grammarRepairWarning.hidden =
      state.settings.grammarRepairMode !== 'when_needed' || state.decisionModelAvailable !== false
    debugEnabledToggle.checked = state.settings.debugLoggingEnabled === true
    debugRefreshButton.disabled = state.settings.debugLoggingEnabled !== true
    debugCopyButton.disabled = false
    debugClearButton.disabled = state.settings.debugLoggingEnabled !== true
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
    scheduleFloatingContentFit()
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
    if (state.voiceChatId !== snapshot.chatId) {
      const cachedRecording = lastRecordingByChat.get(snapshot.chatId)
      const committedTranscript = snapshot.recordingSegments.at(-1)?.rawTranscript ?? ''
      state.voiceChatId = snapshot.chatId
      state.voicePhase = 'idle'
      state.voiceElapsedMs = cachedRecording?.elapsedMs ?? 0
      state.voiceProvider = cachedRecording?.provider ?? null
      state.voiceProvisionalText = ''
      state.voiceFinalText = cachedRecording?.text ?? committedTranscript
      state.voiceMessage = state.voiceFinalText
        ? 'Showing the last completed recording for this chat.'
        : 'Ready to record a message segment.'
    }
    if (syncEditor) {
      desiredText = snapshot.cleanText
      editor.value = snapshot.cleanText
    }
    if (desiredText === snapshot.cleanText) clearDraftBackup(snapshot.chatId)
  }

  const loadDraft = async (chatId: string) => {
    if (!alive) return
    const loadId = ++latestDraftLoadId
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
    if (!alive || loadId !== latestDraftLoadId || state.activeChatId !== chatId) return
    state.loading = false
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
    if (changed) {
      state.voiceChatId = null
      state.voicePhase = 'idle'
      state.voiceElapsedMs = 0
      state.voiceProvider = null
      state.voiceProvisionalText = ''
      state.voiceFinalText = ''
      state.voiceMessage = nextChatId
        ? 'Loading the last recording for this chat…'
        : 'Ready to record a message segment.'
    }
    const transitionId = changed ? ++chatTransitionId : chatTransitionId
    await refreshPermissions()
    if (!alive) return

    if (!changed) {
      if (
        !nextChatId ||
        state.automatedBusy ||
        state.sending ||
        voiceBusy() ||
        state.pendingProposal ||
        state.pendingEditProposal ||
        state.pendingEditCandidates
      )
        return
      await drainMutations()
      if (
        !alive ||
        ctx.getActiveChat().chatId !== nextChatId ||
        state.saving ||
        (state.snapshot !== null && desiredText !== state.snapshot.cleanText)
      )
        return
      await loadDraft(nextChatId)
      return
    }

    await drainMutations()
    if (!alive || transitionId !== chatTransitionId || ctx.getActiveChat().chatId !== nextChatId)
      return
    if (!nextChatId) {
      latestDraftLoadId += 1
      state.snapshot = null
      state.voiceChatId = null
      state.voicePhase = 'idle'
      state.voiceElapsedMs = 0
      state.voiceProvider = null
      state.voiceProvisionalText = ''
      state.voiceFinalText = ''
      state.voiceMessage = 'Ready to record a message segment.'
      state.loading = false
      state.pendingProposal = null
      state.pendingEditProposal = null
      state.pendingEditCandidates = null
      desiredText = ''
      editor.value = ''
      state.statusMessage = 'Select a chat to begin a private draft.'
      render()
      return
    }
    await loadDraft(nextChatId)
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

  const drainMutations = (): Promise<void> => {
    if (mutationDrainPromise) return mutationDrainPromise
    if (!state.snapshot || !alive) return Promise.resolve()
    const run = (async () => {
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
        state.saving = desiredText !== state.snapshot?.cleanText
        render()
      }
    })()
    mutationDrainPromise = run
    const clearRun = () => {
      if (mutationDrainPromise === run) mutationDrainPromise = null
    }
    void run.then(clearRun, clearRun)
    return run
  }

  const handleEditorInput = () => {
    desiredText = editor.value
    if (state.pendingEditProposal || state.pendingEditCandidates) {
      state.pendingEditProposal = null
      state.pendingEditCandidates = null
      state.voicePhase = 'error'
      state.voiceMessage =
        'The draft was changed manually. The pending edit proposal was discarded.'
    }
    if (state.snapshot) saveDraftBackup(state.snapshot.chatId, desiredText)
    beginEditGroup()
    state.statusMessage = 'Saving the private draft…'
    state.saving = true
    render()
    void drainMutations()
  }

  function applyParagraphEdit(lineIndex: number, originalLine: string, replacement: string) {
    const trimmed = replacement.trim()
    if (
      state.pendingProposal ||
      state.pendingEditProposal ||
      state.pendingEditCandidates ||
      voiceBusy() ||
      state.automatedBusy
    ) {
      state.voiceMessage = 'Finish or reject the pending review before editing a paragraph.'
      render()
      return
    }
    const lines = desiredText.split('\n')
    if (lines[lineIndex] !== originalLine) {
      state.voiceMessage = 'That paragraph changed before your edit was saved. Nothing was changed.'
      render()
      return
    }
    if (!trimmed && !originalLine.trim()) return
    if (trimmed) {
      lines[lineIndex] = trimmed
    } else {
      // Clearing a paragraph deletes it, along with one adjacent blank separator.
      if (lines[lineIndex + 1]?.trim() === '') lines.splice(lineIndex, 2)
      else if (lineIndex > 0 && lines[lineIndex - 1]?.trim() === '') lines.splice(lineIndex - 1, 2)
      else lines.splice(lineIndex, 1)
    }
    const nextText = lines.join('\n')
    if (nextText === desiredText) return
    if (nextText.length > MAX_DRAFT_CHARACTERS) {
      state.voiceMessage = 'That edit would exceed the draft character limit. Nothing was changed.'
      render()
      return
    }
    editor.value = nextText
    handleEditorInput()
  }

  const handleUndo = async () => {
    if (!state.snapshot || state.automatedBusy || state.sending) return
    flushParagraphPreview()
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

  const handleRedo = async () => {
    if (!state.snapshot || state.automatedBusy || state.sending) return
    flushParagraphPreview()
    await drainMutations()
    if (!state.snapshot.canRedo || desiredText !== state.snapshot.cleanText) return
    state.automatedBusy = true
    state.statusMessage = 'Redoing the latest undone draft mutation…'
    render()
    const snapshot = state.snapshot
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'draft.redo.request',
      requestId: createRequestId('redo'),
      operationId: createRequestId('redo-operation'),
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion,
    })
    state.automatedBusy = false
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'draft.snapshot.response') {
      applySnapshot(outcome.value.snapshot, true)
      state.statusMessage =
        outcome.value.outcome === 'applied'
          ? 'Latest undone draft mutation redone.'
          : 'Nothing to redo.'
    } else if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
      state.statusMessage = outcome.value.message
    } else {
      state.statusMessage = 'Redo timed out. The existing draft was preserved.'
    }
    render()
  }

  const clearRecordingTimers = () => {
    if (recordingTimer) clearInterval(recordingTimer)
    if (recordingDeadline) clearTimeout(recordingDeadline)
    recordingTimer = null
    recordingDeadline = null
  }

  const clearRecordingDeadline = () => {
    if (recordingDeadline) clearTimeout(recordingDeadline)
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
    quotationBoundaryHint?: 'double' | 'single',
  ): Promise<void> => {
    const snapshot = state.snapshot
    const requestTransitionId = chatTransitionId
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
      ...(quotationBoundaryHint ? { quotationBoundaryHint } : {}),
    })
    if (!alive) return
    if (
      requestTransitionId !== chatTransitionId ||
      state.activeChatId !== snapshot.chatId ||
      state.snapshot?.chatId !== snapshot.chatId
    ) {
      state.voicePhase = 'error'
      state.voiceMessage =
        'The active chat changed before normalization completed. The proposal was discarded.'
      render()
      return
    }
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
    const requestTransitionId = chatTransitionId
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
    if (
      requestTransitionId !== chatTransitionId ||
      state.activeChatId !== snapshot.chatId ||
      state.snapshot?.chatId !== snapshot.chatId
    ) {
      state.voicePhase = 'error'
      state.voiceMessage = 'The active chat changed. The edit proposal was discarded.'
      render()
      return
    }
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
    flushParagraphPreview()
    await drainMutations()
    const proposal = state.pendingEditProposal
    if (!proposal || state.automatedBusy) return
    if (
      !state.snapshot ||
      ctx.getActiveChat().chatId !== proposal.chatId ||
      desiredText !== state.snapshot.cleanText ||
      proposal.chatId !== state.snapshot.chatId ||
      proposal.expectedVersion !== state.snapshot.draftVersion
    ) {
      state.pendingEditProposal = null
      state.voicePhase = 'error'
      state.voiceMessage =
        'The draft changed after this proposal was created. The stale proposal was discarded.'
      render()
      return
    }
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
      if (outcome.status === 'resolved' && outcome.value.type === 'app.error') {
        if (outcome.value.snapshot) applySnapshot(outcome.value.snapshot, true)
        state.pendingEditProposal = null
      }
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
    const buildRequest = (requestId: string) => ({
      protocolVersion: PROTOCOL_VERSION,
      type: 'edit.candidate.select.request' as const,
      requestId,
      operationId: candidateSet.operationId,
      chatId: candidateSet.chatId,
      expectedVersion: candidateSet.expectedVersion,
      candidateId,
    })
    let outcome = await performRequest(buildRequest(createRequestId('edit-candidate-select')))
    if (outcome.status === 'timed-out' && alive) {
      // The backend retains the candidate context, so one retry can recover a
      // request that was dropped before it reached the handler.
      state.voiceMessage = 'Target selection is taking longer than expected. Retrying once…'
      render()
      outcome = await performRequest(buildRequest(createRequestId('edit-candidate-select-retry')))
    }
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
    state.decisionModelAvailable = response.decisionModelAvailable
    state.phaseFourMessage = response.notice ?? 'Context and glossary settings ready.'
  }

  const saveSettings = async () => {
    const contextMessageCount = Math.min(
      20,
      Math.max(0, Number.parseInt(contextCountInput.value, 10) || 0),
    )
    const referenceCacheLimit = Math.min(
      200,
      Math.max(0, Number.parseInt(referenceCacheLimitInput.value, 10) || 0),
    )
    const grammarRepairMode =
      grammarRepairSelect.value === 'always'
        ? 'always'
        : grammarRepairSelect.value === 'when_needed'
          ? 'when_needed'
          : 'off'
    state.settings.contextMessageCount = contextMessageCount
    state.settings.referenceCacheLimit = referenceCacheLimit
    state.settings.contextualNormalizationEnabled = contextualToggle.checked
    state.settings.grammarRepairMode = grammarRepairMode
    state.settings.debugLoggingEnabled = debugEnabledToggle.checked
    state.settings.normalizationModelOverride = normalizationModelPicker.getValue().trim()
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'phase4.settings.update.request',
      requestId: createRequestId('settings-update'),
      settings: {
        contextMessageCount,
        referenceCacheLimit,
        contextualNormalizationEnabled: contextualToggle.checked,
        grammarRepairMode,
        normalizationConnectionId: state.settings.normalizationConnectionId,
        normalizationModelOverride: state.settings.normalizationModelOverride,
        debugLoggingEnabled: debugEnabledToggle.checked,
      },
    })
    if (outcome.status === 'resolved' && outcome.value.type === 'phase4.state.response') {
      applyPhaseFourResponse(outcome.value)
      state.phaseFourMessage = 'Settings saved.'
    } else state.phaseFourMessage = 'Settings were not saved. Try again.'
    render()
  }
  let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSettingsSave = (delay = 0) => {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null
      void saveSettings()
    }, delay)
  }
  const handleContextCountInput = () => scheduleSettingsSave(600)
  const handleReferenceCacheLimitInput = () => scheduleSettingsSave(600)
  const handleSettingToggleChange = () => scheduleSettingsSave(0)

  const refreshDebugLog = async (clear = false): Promise<void> => {
    if (state.settings.debugLoggingEnabled !== true) {
      debugStatus.textContent = 'Enable debug logging first.'
      return
    }
    debugStatus.textContent = clear ? 'Clearing the debug log…' : 'Loading the debug log…'
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: 'debug.log.request',
      requestId: createRequestId('debug-log'),
      ...(clear ? { clear: true } : {}),
    })
    if (!alive) return
    if (outcome.status === 'resolved' && outcome.value.type === 'debug.log.response') {
      debugOutput.value = outcome.value.entries.join('\n')
      debugStatus.textContent = clear
        ? 'Debug log cleared.'
        : `${outcome.value.entries.length} log lines loaded. Review and copy them.`
    } else {
      debugStatus.textContent = 'The debug log request failed or timed out.'
    }
  }

  const copyDebugLog = async (): Promise<void> => {
    if (!debugOutput.value) {
      await refreshDebugLog()
      if (!debugOutput.value) return
    }
    if (!alive) return
    try {
      await navigator.clipboard.writeText(debugOutput.value)
      debugStatus.textContent = 'Debug log copied to the clipboard.'
    } catch {
      debugOutput.focus()
      debugOutput.select()
      debugStatus.textContent =
        'Clipboard access is unavailable. The log is selected; copy it manually.'
    }
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
    clearRecordingDeadline()
    const elapsedMs = Math.max(0, Date.now() - recordingStartedAt)
    lastRecordingByChat.set(recording.chatId, {
      text: transcript.text,
      provider: transcript.provider,
      elapsedMs,
    })
    if (state.activeChatId !== recording.chatId) {
      clearRecordingTimers()
      if (alive) render()
      return
    }
    state.voiceElapsedMs = elapsedMs
    state.voiceProvisionalText = ''
    state.voiceFinalText = transcript.text
    state.voiceProvider = transcript.provider
    state.voiceChatId = recording.chatId
    if (transcript.text.trim().length === 0) {
      state.voicePhase = 'error'
      state.voiceMessage = 'No usable speech was recognized. Nothing was appended.'
      clearRecordingTimers()
      render()
      return
    }
    state.voicePhase = 'committing'
    state.voiceMessage =
      recording.mode === 'edit'
        ? 'Transcription complete. Interpreting the edit as structured operations…'
        : 'Transcription complete. Applying bounded context, punctuation, spelling, and glossary rules…'
    render()
    try {
      if (recording.mode === 'edit')
        await interpretEditTranscript(transcript.text, recording.operationId)
      else
        await commitRecordingTranscript(
          transcript.text,
          recording.operationId,
          recording.quotationBoundaryHint ?? undefined,
        )
    } finally {
      state.voiceElapsedMs = Math.max(0, Date.now() - recordingStartedAt)
      clearRecordingTimers()
      if (alive) render()
    }
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
            // The host's ready promise is the only signal that capture has started, so a
            // listening status never moves the UI to recording on its own.
            if (state.voicePhase === 'starting')
              state.voiceMessage = 'Preparing… wait for “Recording now”.'
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
          const streamedTranscript = joinTranscriptUpdates(finalSegments, current.interimText)
          current.quotationBoundaryHint =
            detectQuotationBoundaryHint(streamedTranscript) ?? current.quotationBoundaryHint
          state.voiceProvisionalText = streamedTranscript
          render()
        },
      })
      activeRecording = {
        chatId: snapshot.chatId,
        runId,
        operationId,
        session,
        finalSegments,
        interimText: '',
        quotationBoundaryHint: null,
        mode,
      }
      const startedAt = Date.now()
      recordingStartedAt = startedAt
      state.voicePhase = 'starting'
      state.voiceElapsedMs = 0
      state.voiceProvider = session.provider
      state.voiceProvisionalText = ''
      state.voiceMessage = mode === 'edit' ? 'Preparing the edit instruction…' : 'Preparing…'
      recordingTimer = setInterval(() => {
        if (recordingStartedAt !== startedAt) return
        state.voiceElapsedMs = Date.now() - startedAt
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
          state.voiceMessage = 'Recording now. Speak naturally, then select Stop Recording.'
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
        ? 'Recording and normalization permissions are ready. Select Record again to begin.'
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
    flushParagraphPreview()
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
          'Verify the owning chat, add the draft as one user message, and start the normal Lumiverse response.',
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
    flushParagraphPreview()
    sendFlowActive = true
    state.sending = true
    state.statusMessage = 'Preparing the draft to send…'
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

      state.statusMessage = 'Sending the clean draft…'
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
      if (!alive) return
      if (outcome.status === 'resolved' && outcome.value.type === 'draft.send.response') {
        applySnapshot(outcome.value.snapshot, true)
        state.sendOutcomeUnknown = false
        state.statusMessage = outcome.value.generationIdPresent
          ? 'Draft sent once and normal response generation started.'
          : 'Draft sent once. Lumiverse did not return a generation identifier.'
        closeFloatingComposer()
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
    flushParagraphPreview()
    cancelActiveRecording('Recording cancelled because the active chat changed.')
    if (state.pendingProposal) rejectNormalizationProposal()
    state.pendingEditProposal = null
    state.pendingEditCandidates = null
    void refreshHostState()
  }
  let floatingLaunchReturnTarget: HTMLElement | null = null
  const openFloatingComposer = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && !floatingWidget.root.contains(activeElement)) {
      floatingLaunchReturnTarget = activeElement
    }
    resizeAndClampFloatingWidget()
    floatingWidget.setVisible(true)
    scheduleFloatingContentFit()
    void refreshHostState().finally(scheduleFloatingContentFit)
    window.setTimeout(() => editor.focus(), 0)
  }
  function closeFloatingComposer(): void {
    flushParagraphPreview()
    if (activeRecording) {
      cancelActiveRecording('Recording cancelled because the floating composer was closed.')
    }
    floatingWidget.setVisible(false)
    const returnTarget = floatingLaunchReturnTarget
    floatingLaunchReturnTarget = null
    window.setTimeout(() => {
      if (returnTarget?.isConnected) returnTarget.focus()
      else composerLauncher.focus()
    }, 0)
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

  const handleUndoClick = () =>
    void (state.snapshot?.canUndoRecording ? handleUndoRecording() : handleUndo())
  const handleRedoClick = () => void handleRedo()
  const handleRecordClick = () => void handleRecording('message')
  const handleRecordEditClick = () => void handleRecording('edit')
  const handleCancelRecordingClick = () =>
    cancelActiveRecording('Recording cancelled. No transcript was appended.')
  const handleCancelEditRecordingClick = () =>
    cancelActiveRecording('Edit recording cancelled. The draft was not changed.')
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
  const handleGrammarRepairModeChange = () => {
    state.settings.grammarRepairMode =
      grammarRepairSelect.value === 'always'
        ? 'always'
        : grammarRepairSelect.value === 'when_needed'
          ? 'when_needed'
          : 'off'
    render()
    scheduleSettingsSave(0)
  }
  const handleDebugEnabledChange = () => {
    state.settings.debugLoggingEnabled = debugEnabledToggle.checked
    scheduleSettingsSave(0)
  }
  const handleDebugRefreshClick = () => void refreshDebugLog()
  const handleDebugCopyClick = () => void copyDebugLog()
  const handleDebugClearClick = () => void refreshDebugLog(true)
  const handleNormalizationConnectionChange = () => {
    state.settings.normalizationConnectionId = normalizationConnectionSelect.value || null
    state.settings.normalizationModelOverride = ''
    render()
    normalizationModelPicker.refresh()
    scheduleSettingsSave(0)
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
  const floatingFocusables = (): HTMLElement[] =>
    Array.from(
      floatingWidget.root.querySelectorAll<HTMLElement>(
        'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('disabled') && !element.closest('[hidden]'))
  const handleFloatingFocusTrap = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
    if (!floatingWidget.isVisible()) return
    const items = floatingFocusables()
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (!(active instanceof Node) || !floatingWidget.root.contains(active)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
      return
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    }
  }
  const handleFloatingScrollKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && floatingWidget.isVisible()) {
      event.preventDefault()
      event.stopPropagation()
      closeFloatingComposer()
      return
    }
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)
    ) {
      return
    }
    const eventTarget = event.target
    if (
      eventTarget instanceof HTMLTextAreaElement ||
      eventTarget instanceof HTMLSelectElement ||
      (eventTarget instanceof HTMLElement && eventTarget.isContentEditable)
    ) {
      return
    }

    const nestedPanel =
      eventTarget instanceof Element
        ? eventTarget.closest<HTMLElement>(
            '[data-paragraph-list], [data-command-panel], .jt-floating__tools details',
          )
        : null
    const scrollTarget =
      nestedPanel && nestedPanel.scrollHeight > nestedPanel.clientHeight
        ? nestedPanel
        : floatingWidget.root
    const pageDistance = Math.max(48, Math.floor(scrollTarget.clientHeight * 0.8))
    const distance =
      event.key === 'ArrowUp'
        ? -48
        : event.key === 'ArrowDown'
          ? 48
          : event.key === 'PageUp'
            ? -pageDistance
            : pageDistance
    event.preventDefault()
    event.stopPropagation()
    scrollTarget.scrollBy({ top: distance, behavior: 'auto' })
  }
  function resizeAndClampFloatingWidget(): void {
    const size = getFloatingWidgetSize()
    setAndClampFloatingWidgetSize(size.width, size.height)
  }
  function setAndClampFloatingWidgetSize(width: number, height: number): void {
    const viewport = getViewportSize()
    floatingWidget.setSize(width, height)
    const position = floatingWidget.getPosition()
    const marginX = viewport.width >= width + 24 ? 12 : 0
    const marginY = viewport.height >= height + 24 ? 12 : 0
    const maxX = Math.max(marginX, viewport.width - width - marginX)
    const maxY = Math.max(marginY, viewport.height - height - marginY)
    floatingWidget.moveTo(
      Math.min(maxX, Math.max(marginX, position.x)),
      Math.min(maxY, Math.max(marginY, position.y)),
    )
  }
  function scheduleFloatingContentFit(): void {
    window.requestAnimationFrame(() => {
      if (!floatingWidget.isVisible()) return
      const baseSize = getFloatingWidgetSize()
      const viewport = getViewportSize()
      const floatingShell = floatingWidget.root.querySelector<HTMLElement>('.jt-floating')
      const floatingTools = floatingWidget.root.querySelector<HTMLElement>('.jt-floating__tools')
      if (!floatingShell || !floatingTools) return
      const shellStyle = window.getComputedStyle(floatingShell)
      const bottomInset =
        Number.parseFloat(shellStyle.paddingBottom) +
        Number.parseFloat(shellStyle.borderBottomWidth)
      const contentBottom =
        floatingTools.getBoundingClientRect().bottom - floatingShell.getBoundingClientRect().top
      const fittedHeight = Math.min(
        Math.max(1, viewport.height - 24),
        Math.ceil(contentBottom + bottomInset),
      )
      setAndClampFloatingWidgetSize(baseSize.width, fittedHeight)
      window.requestAnimationFrame(() => {
        if (!floatingWidget.isVisible()) return
        const overflow = Math.ceil(
          floatingWidget.root.scrollHeight - floatingWidget.root.clientHeight,
        )
        if (overflow <= 1) return
        setAndClampFloatingWidgetSize(
          baseSize.width,
          Math.min(Math.max(1, viewport.height - 24), fittedHeight + overflow + 2),
        )
      })
    })
  }
  const handleViewportResize = () => {
    resizeAndClampFloatingWidget()
    scheduleFloatingContentFit()
  }
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('focus', handleFocus)
  window.addEventListener('resize', handleViewportResize)
  window.visualViewport?.addEventListener('resize', handleViewportResize)
  retryButton.addEventListener('click', handleRetry)
  switchDraftButton.addEventListener('click', handleSwitchDraft)
  editor.addEventListener('input', handleEditorInput)
  editor.addEventListener('blur', flushParagraphPreview)
  recordButton.addEventListener('click', handleRecordClick)
  recordEditButton.addEventListener('click', handleRecordEditClick)
  cancelEditRecordingButton.addEventListener('click', handleCancelEditRecordingClick)
  cancelRecordingButton.addEventListener('click', handleCancelRecordingClick)
  undoButton.addEventListener('click', handleUndoClick)
  redoButton.addEventListener('click', handleRedoClick)
  historyButton.addEventListener('click', handleHistoryToggle)
  sendButton.addEventListener('click', handleSendClick)
  acceptProposalButton.addEventListener('click', handleAcceptProposalClick)
  rejectProposalButton.addEventListener('click', handleRejectProposalClick)
  acceptEditButton.addEventListener('click', handleAcceptEditClick)
  rejectEditButton.addEventListener('click', handleRejectEditClick)
  editCandidatesList.addEventListener('click', handleEditCandidateClick)
  cancelEditCandidatesButton.addEventListener('click', handleCancelEditCandidatesClick)
  grammarRepairSelect.addEventListener('change', handleGrammarRepairModeChange)
  debugEnabledToggle.addEventListener('change', handleDebugEnabledChange)
  contextCountInput.addEventListener('input', handleContextCountInput)
  referenceCacheLimitInput.addEventListener('input', handleReferenceCacheLimitInput)
  contextualToggle.addEventListener('change', handleSettingToggleChange)
  debugRefreshButton.addEventListener('click', handleDebugRefreshClick)
  debugCopyButton.addEventListener('click', handleDebugCopyClick)
  debugClearButton.addEventListener('click', handleDebugClearClick)
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
  composerLauncher.addEventListener('click', handleOpenFloating)
  floatingCloseButton.addEventListener('click', handleCloseFloating)
  floatingCommandButton.addEventListener('click', handleCommandToggle)
  floatingCommandSearch.addEventListener('input', handleCommandSearch)
  floatingWidget.root.addEventListener('keydown', handleFloatingScrollKey)
  document.addEventListener('keydown', handleFloatingFocusTrap, true)

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
    if (paragraphRenderTimer) clearTimeout(paragraphRenderTimer)
    if (paragraphRenderDeadline) clearTimeout(paragraphRenderDeadline)
    registry.cancelAll()
    normalizationRegistry.cancelAll()
    sendRegistry.cancelAll()
    for (const dispose of disposers.splice(0)) dispose()
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('pagehide', handlePageHide)
    window.removeEventListener('focus', handleFocus)
    window.removeEventListener('resize', handleViewportResize)
    window.visualViewport?.removeEventListener('resize', handleViewportResize)
    retryButton.removeEventListener('click', handleRetry)
    switchDraftButton.removeEventListener('click', handleSwitchDraft)
    editor.removeEventListener('input', handleEditorInput)
    editor.removeEventListener('blur', flushParagraphPreview)
    recordButton.removeEventListener('click', handleRecordClick)
    recordEditButton.removeEventListener('click', handleRecordEditClick)
    cancelEditRecordingButton.removeEventListener('click', handleCancelEditRecordingClick)
    cancelRecordingButton.removeEventListener('click', handleCancelRecordingClick)
    undoButton.removeEventListener('click', handleUndoClick)
    redoButton.removeEventListener('click', handleRedoClick)
    historyButton.removeEventListener('click', handleHistoryToggle)
    sendButton.removeEventListener('click', handleSendClick)
    acceptProposalButton.removeEventListener('click', handleAcceptProposalClick)
    rejectProposalButton.removeEventListener('click', handleRejectProposalClick)
    acceptEditButton.removeEventListener('click', handleAcceptEditClick)
    rejectEditButton.removeEventListener('click', handleRejectEditClick)
    editCandidatesList.removeEventListener('click', handleEditCandidateClick)
    cancelEditCandidatesButton.removeEventListener('click', handleCancelEditCandidatesClick)
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
    contextCountInput.removeEventListener('input', handleContextCountInput)
    referenceCacheLimitInput.removeEventListener('input', handleReferenceCacheLimitInput)
    contextualToggle.removeEventListener('change', handleSettingToggleChange)
    grammarRepairSelect.removeEventListener('change', handleGrammarRepairModeChange)
    debugEnabledToggle.removeEventListener('change', handleDebugEnabledChange)
    debugRefreshButton.removeEventListener('click', handleDebugRefreshClick)
    debugCopyButton.removeEventListener('click', handleDebugCopyClick)
    debugClearButton.removeEventListener('click', handleDebugClearClick)
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
    composerLauncher.removeEventListener('click', handleOpenFloating)
    floatingCloseButton.removeEventListener('click', handleCloseFloating)
    floatingCommandButton.removeEventListener('click', handleCommandToggle)
    floatingCommandSearch.removeEventListener('input', handleCommandSearch)
    floatingWidget.root.removeEventListener('keydown', handleFloatingScrollKey)
    document.removeEventListener('keydown', handleFloatingFocusTrap, true)
    normalizationModelPicker.destroy()
    composerLauncher.remove()
    composerLauncherStyle.remove()
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

function attachParagraphEditing(
  row: HTMLElement,
  text: HTMLElement,
  lineIndex: number,
  line: string,
  editLabel: string,
  onEdit: (lineIndex: number, originalLine: string, replacement: string) => void,
): void {
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressed = false
  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = null
  }
  const beginEdit = () => {
    cancelPress()
    if (row.querySelector('textarea')) return
    const input = document.createElement('textarea')
    input.className = 'jt-paragraph-input'
    input.value = line
    input.rows = Math.min(6, Math.max(2, Math.ceil(line.length / 60)))
    input.setAttribute('aria-label', editLabel)
    let settled = false
    const finish = (commit: boolean) => {
      if (settled) return
      settled = true
      input.remove()
      text.hidden = false
      if (commit) onEdit(lineIndex, line, input.value)
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    text.hidden = true
    row.append(input)
    input.focus()
  }
  row.tabIndex = 0
  row.addEventListener('dblclick', beginEdit)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === row) beginEdit()
  })
  row.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return
    // The host float widget also uses a touch hold for its widget menu. Keep a
    // paragraph-owned hold from starting that ancestor gesture while leaving
    // native scrolling intact (no preventDefault).
    event.stopPropagation()
    if (event.target instanceof HTMLTextAreaElement) return
    longPressed = false
    cancelPress()
    pressTimer = setTimeout(() => {
      longPressed = true
      beginEdit()
    }, 500)
  })
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const)
    row.addEventListener(type, cancelPress)
  row.addEventListener('contextmenu', (event) => {
    if (event.target instanceof HTMLTextAreaElement) {
      event.stopPropagation()
      return
    }
    if (event.pointerType === 'mouse' && !longPressed) return
    event.preventDefault()
    event.stopPropagation()
    if (!longPressed) beginEdit()
    longPressed = false
  })
}

function renderParagraphs(
  container: HTMLElement,
  cleanText: string,
  onEdit?: (lineIndex: number, originalLine: string, replacement: string) => void,
): void {
  container.replaceChildren()
  if (cleanText.length === 0) {
    const row = document.createElement('div')
    row.className = 'jt-paragraph-row jt-paragraph-row--separator'
    row.setAttribute('aria-label', 'Empty draft paragraph')
    const number = document.createElement('span')
    number.className = 'jt-paragraph-number'
    number.setAttribute('aria-hidden', 'true')
    const empty = document.createElement('span')
    empty.className = 'jt-empty jt-paragraph-text'
    empty.textContent = 'Empty draft. Double-click or long-press to type.'
    row.append(number, empty)
    if (onEdit) attachParagraphEditing(row, empty, 0, '', 'Edit empty draft paragraph', onEdit)
    container.append(row)
    return
  }

  let ordinal = 0
  for (const [lineIndex, line] of cleanText.split('\n').entries()) {
    const row = document.createElement('div')
    row.className = 'jt-paragraph-row'
    if (line.trim().length === 0) {
      row.classList.add('jt-paragraph-row--separator')
      row.setAttribute('aria-label', 'Blank paragraph separator')
      const number = document.createElement('span')
      number.className = 'jt-paragraph-number'
      number.setAttribute('aria-hidden', 'true')
      const text = document.createElement('span')
      text.className = 'jt-paragraph-text'
      row.append(number, text)
      if (onEdit)
        attachParagraphEditing(
          row,
          text,
          lineIndex,
          line,
          `Edit blank draft line ${lineIndex + 1}`,
          onEdit,
        )
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
    if (onEdit)
      attachParagraphEditing(row, text, lineIndex, line, `Edit paragraph ${ordinal}`, onEdit)
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
        : entry.kind === 'redo'
          ? 'Redo'
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

function detectQuotationBoundaryHint(input: string): 'double' | 'single' | null {
  const trimmed = input.trim()
  if (/^begin\s+single\b[\s\S]*\bend\s+single[.,;:!?]*$/iu.test(trimmed)) return 'single'
  if (
    /^begin(?:ning)?(?:\s+the)?\s+speech\b[\s\S]*\bend(?:ing)?\s+speech[.,;:!?]*$/iu.test(trimmed)
  )
    return 'double'
  const doubleOpening = /^(?:open\s+)?(?:quote|quotation)(?:\s+marks?)?\b/iu
  const doubleClosing = /\b(?:close\s+)?(?:quote|quotation)(?:\s+marks?)?[.,;:!?]*$/iu
  const singleOpening = /^(?:open\s+)?single\s+(?:quote|quotation)(?:\s+marks?)?\b/iu
  const singleClosing = /\b(?:close\s+)?single\s+(?:quote|quotation)(?:\s+marks?)?[.,;:!?]*$/iu
  const singleCount =
    trimmed.match(/\b(?:open\s+|close\s+)?single\s+(?:quote|quotation)(?:\s+marks?)?\b/giu)
      ?.length ?? 0
  const doubleCount =
    trimmed.match(/\b(?:open\s+|close\s+)?(?<!single\s)(?:quote|quotation)(?:\s+marks?)?\b/giu)
      ?.length ?? 0
  if (singleCount >= 2 && singleOpening.test(trimmed) && singleClosing.test(trimmed))
    return 'single'
  if (doubleCount >= 2 && doubleOpening.test(trimmed) && doubleClosing.test(trimmed))
    return 'double'
  return null
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
        <h2 class="jt-brand">${JARVISTYPE_ICON_SVG}<span>JarvisType</span></h2>
        <button type="button" data-close-floating aria-label="Close JarvisType">Close</button>
      </header>
      <div class="jt-floating__body">
        <div data-floating-composer-mount></div>
        <div class="jt-floating__tools">
          <div class="jt-tools-row">
            <button type="button" data-command-toggle aria-expanded="false" aria-controls="jt-command-panel">Command list</button>
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
          <section id="jt-command-panel" data-command-panel hidden aria-label="Available voice edit commands">
            <label class="jt-form-grid">Search commands<input type="search" placeholder="Search commands or examples" data-command-search></label>
            <div class="jt-command-list">${commands}</div>
          </section>
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
      .jt-brand { display: inline-flex; align-items: center; gap: .5rem; }
      .jt-brand-icon { width: 1.35em; height: 1.35em; flex: 0 0 auto; }
      .jt-shell__header, .jt-shell__card { display: grid; gap: .7rem; min-width: 0; }
      .jt-shell__eyebrow { font-size: .78rem; opacity: .72; text-transform: uppercase; letter-spacing: .08em; }
      .jt-shell__card { padding: .85rem; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: .75rem; }
      .jt-shell__status-grid { display: grid; gap: .4rem; font-size: .88rem; overflow-wrap: anywhere; }
      .jt-shell__notice { padding: .7rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 8%, transparent); }
      .jt-shell__warning { padding: .7rem; border: 1px solid #d69e2e; border-radius: .5rem; }
      .jt-draft-editor { width: 100%; min-height: 11rem; resize: vertical; border-radius: .55rem; padding: .75rem; font: inherit; line-height: 1.5; }
      .jt-draft-meta { font-size: .78rem; opacity: .75; overflow-wrap: anywhere; }
      .jt-paragraphs { display: block; max-height: min(18rem, 34vh); padding: .6rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 6%, transparent); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
      .jt-paragraphs:focus-visible { outline: 2px solid #d69e2e; outline-offset: 2px; }
      .jt-paragraph-row { display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: .5rem; min-width: 0; min-height: 1.5rem; align-items: start; line-height: 1.5; }
      .jt-paragraph-row + .jt-paragraph-row { margin-top: .25rem; }
      .jt-paragraph-row--separator { min-height: 1.5rem; }
      .jt-paragraph-row { -webkit-touch-callout: none; touch-action: manipulation; cursor: text; border-radius: .35rem; }
      .jt-paragraph-row:focus-visible { outline: 2px solid #d69e2e; outline-offset: 2px; }
      .jt-paragraph-input { width: 100%; min-width: 0; box-sizing: border-box; font: inherit; line-height: 1.5; padding: .35rem .5rem; border-radius: .4rem; resize: vertical; }
      .jt-paragraph-number { text-align: right; opacity: .6; user-select: none; }
      .jt-paragraph-text { white-space: pre-wrap; overflow-wrap: anywhere; }
      .jt-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
      .jt-shell button { min-height: 2.35rem; padding: .48rem .75rem; border: 1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius: .5rem; background: color-mix(in srgb, currentColor 9%, transparent); color: inherit; font: inherit; font-weight: 600; line-height: 1.2; cursor: pointer; }
      .jt-shell button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 15%, transparent); border-color: color-mix(in srgb, currentColor 45%, transparent); }
      .jt-shell button:focus-visible { outline: 2px solid #d69e2e; outline-offset: 2px; }
      .jt-shell button:disabled { cursor: not-allowed; opacity: .55; }
      .jt-shell [data-record-message], .jt-shell [data-record-edit], .jt-shell [data-send], .jt-shell [data-proposal-accept], .jt-shell [data-edit-accept] { border-color: #d69e2e; background: color-mix(in srgb, #d69e2e 18%, transparent); }
      .jt-history-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; width: 100%; }
      .jt-history-row > button { width: 100%; min-width: 0; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .jt-record-row { display: flex; gap: .5rem; width: 100%; }
      .jt-record-slot { flex: 1 1 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; min-width: 0; }
      .jt-record-slot > button { grid-row: 1; width: 100%; min-width: 0; margin: 0; padding-inline: .4rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; transition: background-color .3s ease, border-color .3s ease, color .3s ease; }
      .jt-record-slot > [data-record-message], .jt-record-slot > [data-record-edit] { grid-column: 1 / -1; }
      .jt-record-slot[data-live="true"] > [data-record-message], .jt-record-slot[data-live="true"] > [data-record-edit] { grid-column: 1; }
      .jt-record-slot > [data-cancel-recording], .jt-record-slot > [data-cancel-edit-recording] { grid-column: 2; }
      .jt-actions > [data-send] { flex: 1 1 100%; }
      .jt-shell [data-recording-state="starting"] { border-color: #ecc94b; background: #ecc94b; color: #1a1a1a; font-weight: 700; }
      .jt-shell [data-recording-state="recording"] { border-color: #e53e3e; background: #e53e3e; color: #ffffff; font-weight: 700; }
      .jt-shell [data-record-message]:hover:not(:disabled), .jt-shell [data-record-edit]:hover:not(:disabled), .jt-shell [data-send]:hover:not(:disabled), .jt-shell [data-proposal-accept]:hover:not(:disabled), .jt-shell [data-edit-accept]:hover:not(:disabled) { background: color-mix(in srgb, #d69e2e 28%, transparent); }
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
      .jt-setting-warning { color: #e53e3e; font-weight: 600; }
      .jt-form-grid input, .jt-form-grid select { width: 100%; min-width: 0; min-height: 2.3rem; padding: .4rem .55rem; }
      .jt-proposal { display: grid; gap: .55rem; padding: .7rem; border: 1px solid #d69e2e; border-radius: .5rem; }
      .jt-proposal pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; padding: .55rem; background: color-mix(in srgb, currentColor 6%, transparent); }
      .jt-proposal__details { display: grid; gap: .55rem; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: .45rem; padding: .55rem; }
      .jt-proposal__details summary { cursor: pointer; font-weight: 700; }
      .jt-proposal__details[open] summary { margin-bottom: .55rem; }
      .jt-debug-output { width: 100%; min-height: 12rem; resize: vertical; padding: .55rem; border-radius: .45rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .78rem; white-space: pre; overflow: auto; }
      .jt-candidate-list { display: grid; gap: .5rem; }
      .jt-candidate-list button { text-align: start; white-space: normal; }
      .jt-glossary { display: grid; gap: .55rem; }
      .jt-glossary--scrolling { max-height: 22rem; overflow-y: auto; overscroll-behavior: contain; padding-right: .25rem; }
      .jt-glossary-row { display: grid; gap: .35rem; padding: .55rem; border-radius: .45rem; background: color-mix(in srgb, currentColor 6%, transparent); overflow-wrap: anywhere; }
      .jt-launch { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: center; padding: .8rem; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: .75rem; }
      .jt-launch button { font-weight: 700; }
      .jt-floating-host { scrollbar-gutter: stable; -webkit-overflow-scrolling: touch; }
      .jt-floating { box-sizing: border-box; display: grid; grid-template-rows: auto auto; align-content: start; width: 100%; min-width: 0; min-height: 100%; overflow: visible; border: 1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius: .9rem; background: var(--background, #171717); color: var(--foreground, inherit); box-shadow: 0 18px 55px rgb(0 0 0 / .38); }
      .jt-floating__bar { position: sticky; z-index: 10; top: 0; display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .55rem .7rem; border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); background: var(--background, #171717); cursor: move; }
      .jt-floating__bar h2 { font-size: 1rem; }
      .jt-floating__body { min-height: 0; overflow: visible; }
      .jt-floating__body > .jt-shell__card { margin: .75rem; }
      .jt-floating__tools { display: grid; gap: .65rem; margin-top: 1rem; padding: .55rem .7rem; border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
      .jt-tools-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; width: 100%; align-items: start; }
      .jt-tools-row > button, .jt-tools-row > details { width: 100%; min-width: 0; min-height: 2.35rem; margin: 0; }
      .jt-tools-row > button { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: start; border-color: color-mix(in srgb, currentColor 15%, transparent); border-radius: .6rem; background: transparent; }
      .jt-tools-row > button::before { content: '▸ '; }
      .jt-tools-row > button[aria-expanded="true"]::before { content: '▾ '; }
      .jt-tools-row > details:not([open]):hover { background: color-mix(in srgb, currentColor 15%, transparent); border-color: color-mix(in srgb, currentColor 45%, transparent); }
      .jt-tools-row > details > summary:focus-visible { outline: 2px solid #d69e2e; outline-offset: 2px; }
      .jt-composer__pane { display: grid; align-content: start; gap: .7rem; min-width: 0; }
      .jt-floating details { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: .6rem; padding: .6rem; }
      .jt-floating .jt-tools-row > details { padding: .48rem .75rem; }
      .jt-floating summary { cursor: pointer; font-weight: 700; }
      .jt-floating .jt-proposal pre { max-height: none; overflow: visible; }
      .jt-decision { position: sticky; bottom: 0; z-index: 5; display: grid; gap: .4rem; margin: .4rem 0; padding: .5rem .6rem; border: 1px solid #d69e2e; border-radius: .6rem; background: var(--background, #171717); box-shadow: 0 -6px 16px rgb(0 0 0 / .3); }
      .jt-decision__summary { margin: 0; font-size: .85rem; overflow-wrap: anywhere; }
      .jt-decision__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; }
      .jt-decision__actions [data-proposal-accept], .jt-decision__actions [data-edit-accept] { border-color: #d69e2e; background: color-mix(in srgb, #d69e2e 18%, transparent); }
      .jt-command-list { display: grid; gap: .75rem; margin-top: .65rem; }
      .jt-command-list ul { display: grid; gap: .4rem; margin: .35rem 0 0; padding-left: 1.2rem; }
      .jt-empty { opacity: .65; font-style: italic; }
      .jt-shell [hidden] { display: none !important; }
      [data-state="ready"] { color: #38a169; }
      [data-state="unavailable"] { color: #e53e3e; }
      @media (min-width: ${NARROW_COMPOSER_BREAKPOINT_PX}px) {
        .jt-floating__body { display: block; }
        .jt-floating [data-floating-composer-mount] { min-height: 0; }
        .jt-floating [data-composer-surface] { grid-template-columns: minmax(0, 1.15fr) minmax(20rem, .85fr); align-items: stretch; height: auto; overflow: visible; }
        .jt-floating .jt-composer__pane { min-height: 0; overflow: visible; padding-right: .25rem; }
        .jt-floating .jt-draft-editor { min-height: 10rem; }
        .jt-floating__tools > section, .jt-tools-row > details { max-height: 24rem; overflow-y: auto; overscroll-behavior: contain; }
      }
    </style>
    <main class="jt-shell" aria-labelledby="jt-title">
      <header class="jt-shell__header">
        <p class="jt-shell__eyebrow">Phase 7 release-candidate hardening · v${APP_VERSION}</p>
        <h2 id="jt-title" class="jt-brand">${JARVISTYPE_ICON_SVG}<span>JarvisType</span></h2>
        <p>Compose privately, review every change, and send only when you confirm.</p>
      </header>

      <section class="jt-launch" aria-label="Floating composer launcher">
        <div>
          <h3>Voice composer</h3>
          <p class="jt-draft-meta">Opens near the message input and keeps this drawer available for glossary and settings.</p>
        </div>
        <button type="button" class="jt-brand" data-open-floating aria-label="Open JarvisType floating composer">${JARVISTYPE_ICON_SVG}<span>Open JarvisType</span></button>
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

      <div data-composer-bootstrap hidden>
      <section class="jt-shell__card" data-composer-surface aria-labelledby="jt-draft-title">
        <div class="jt-composer__pane jt-composer__draft-pane">
        <h3 id="jt-draft-title">Numbered draft</h3>
        <p id="jt-draft-help">Double-click or long-press a paragraph to edit it. Numbers are never copied or sent.</p>
        <p class="jt-draft-meta" data-draft-meta>Draft not loaded</p>

        <div class="jt-paragraphs" data-paragraph-list role="region" aria-label="Numbered draft paragraphs" aria-live="polite"></div>
        <div class="jt-draft-full" data-draft-full hidden aria-hidden="true">
          <textarea class="jt-draft-editor" data-draft-editor maxlength="${MAX_DRAFT_CHARACTERS}" aria-describedby="jt-draft-help" aria-label="JarvisType private working draft" disabled></textarea>
        </div>
        </div>

        <div class="jt-composer__pane jt-composer__action-pane">
        <section class="jt-proposal" data-normalization-proposal hidden aria-labelledby="jt-proposal-title">
          <h4 id="jt-proposal-title">Review normalized transcript</h4>
          <p><strong>Proposed text</strong></p>
          <pre data-proposal-candidate></pre>
          <details class="jt-proposal__details">
            <summary>Raw transcript and normalization details</summary>
            <p><strong>Raw provider transcript</strong></p>
            <pre data-proposal-raw></pre>
            <p class="jt-draft-meta" data-proposal-meta></p>
          </details>
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
          <p><strong>Proposed draft</strong></p>
          <pre data-edit-after></pre>
          <details class="jt-proposal__details">
            <summary>Instruction and technical details</summary>
            <p><strong>Spoken instruction</strong></p>
            <pre data-edit-instruction></pre>
            <p><strong>Structured operations</strong></p>
            <pre data-edit-operations></pre>
            <p><strong>Before</strong></p>
            <pre data-edit-before></pre>
          </details>
        </section>
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
          <div class="jt-record-row" aria-label="Voice composition controls">
            <div class="jt-record-slot" data-record-slot="message">
              <button type="button" data-record-message disabled>Record</button>
              <button type="button" data-cancel-recording aria-label="Cancel recording" title="Cancel recording" style="visibility: hidden" disabled>✕</button>
            </div>
            <div class="jt-record-slot" data-record-slot="edit">
              <button type="button" data-record-edit disabled>Edit</button>
              <button type="button" data-cancel-edit-recording aria-label="Cancel edit recording" title="Cancel edit recording" style="visibility: hidden" disabled>✕</button>
            </div>
          </div>
        </section>
        <div class="jt-actions">
          <button type="button" data-send disabled>Confirm &amp; Send</button>
        </div>
        <div class="jt-history-row">
          <button type="button" data-undo disabled>Undo</button>
          <button type="button" data-redo disabled>Redo</button>
          <button type="button" data-history-toggle disabled>History</button>
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
        </div>
        <div class="jt-decision" data-decision-bar hidden>
          <p class="jt-decision__summary" data-decision-summary></p>
          <div class="jt-decision__actions">
            <button type="button" data-proposal-reject hidden>Reject</button>
            <button type="button" data-proposal-accept hidden>Accept &amp; append</button>
            <button type="button" data-edit-reject hidden>Reject</button>
            <button type="button" data-edit-accept hidden>Accept edit</button>
          </div>
        </div>
      </section>
      </div>

      <section class="jt-shell__card" aria-labelledby="jt-context-title">
        <h3 id="jt-context-title">Context and glossary</h3>
        <p class="jt-shell__notice">The message count controls the recent window scanned for names and proper nouns. New deduplicated chat candidates must pass the Lumiverse decision model before they can be used or enter the per-chat rolling cache; accepted and rejected verdicts are reused to avoid repeated checks. Card names are always included without consuming cache slots, while active-draft references remain temporary. After speech-to-text finishes, the normalization connection receives the current recording, glossary, and approved reference lists—not chat messages, the draft, card text, or audio. Set the message count to 0 to stop scanning new history; set the cache limit to 0 to disable retained references.</p>
        <div class="jt-form-grid">
          <label>Messages scanned for references (0–20, default 5)<input type="number" min="0" max="20" step="1" value="5" data-context-count></label>
          <label>Rolling name cache (0–200, default 30)<input type="number" min="0" max="200" step="1" value="30" data-reference-cache-limit></label>
          <label><span><input type="checkbox" checked data-context-enabled> Use bounded context normalization</span></label>
          <label>Post-edit grammar repair<select data-grammar-repair-mode><option value="off">Off</option><option value="when_needed">When needed</option><option value="always">Always</option></select><small>Always applies local spacing, casing, and punctuation cleanup to the edited sentence. This setting adds an optional provider grammar check through the selected normalization connection; Off keeps all cleanup local, and every correction remains part of the proposal.</small><small class="jt-setting-warning" data-grammar-repair-warning hidden>No decision model connection is available. “When needed” needs one to decide whether an edit broke grammar, so until one is set up only the local cleanup runs. Set up a decision model in Lumiverse, or choose “Always” to use the normalization connection instead.</small></label>
          <label>Normalization connection<select data-normalization-connection><option value="">Main connection</option></select></label>
          <label><span>Normalization model (optional override)</span><div data-normalization-model></div></label>
        </div>
        <details class="jt-proposal__details">
          <summary>Debug timing log</summary>
          <label><span><input type="checkbox" data-debug-enabled> Enable debug timing log</span></label>
          <p class="jt-shell__notice">Records backend timings and request metadata only. It never records draft text, transcripts, prompts, or provider output. The log starts fresh for each new recording, edit, send, recording undo, undo, or redo, and follow-up steps append to the same action. Drawer loads, settings changes, and glossary edits are not logged. Enable it, save settings, reproduce the action, then Refresh and Copy.</p>
          <div class="jt-actions">
            <button type="button" data-debug-refresh>Refresh log</button>
            <button type="button" data-debug-copy>Copy log</button>
            <button type="button" data-debug-clear>Clear log</button>
          </div>
          <textarea class="jt-debug-output" readonly data-debug-output rows="14" spellcheck="false" aria-label="JarvisType debug timing log"></textarea>
          <p role="status" aria-live="polite" data-debug-status></p>
        </details>
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
