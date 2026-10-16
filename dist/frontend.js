// src/domain/draft-session.ts
var MAX_DRAFT_CHARACTERS = 1e5;
var MAX_HISTORY_ENTRIES = 200;
var MAX_RECORDING_SEGMENTS = 200;

// src/domain/request-registry.ts
var RequestRegistry = class {
  constructor(timeoutMs, onTimeout) {
    this.timeoutMs = timeoutMs;
    this.onTimeout = onTimeout;
  }
  pending = /* @__PURE__ */ new Map();
  wait(requestId) {
    this.cancel(requestId);
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.onTimeout?.(requestId);
        settle({ status: "timed-out" });
      }, this.timeoutMs);
      this.pending.set(requestId, { timer, settle });
    });
  }
  resolve(requestId, value) {
    const request = this.pending.get(requestId);
    if (!request) return false;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    request.settle({ status: "resolved", value });
    return true;
  }
  cancel(requestId) {
    const request = this.pending.get(requestId);
    if (!request) return false;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    request.settle({ status: "cancelled" });
    return true;
  }
  cancelAll() {
    for (const requestId of [...this.pending.keys()]) this.cancel(requestId);
  }
  get size() {
    return this.pending.size;
  }
};

// src/protocol/messages.ts
var PROTOCOL_VERSION = 4;
var APP_VERSION = "1.0.0";
var REQUEST_TIMEOUT_MS = 15e3;
var SEND_TIMEOUT_MS = 12e4;
var PHASE_FOUR_PERMISSIONS = ["media", "chats", "chat_mutation", "generation"];
function createRequestId(prefix = "request") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

// src/protocol/validation.ts
var ERROR_CODES = [
  "MALFORMED_REQUEST",
  "BACKEND_UNAVAILABLE",
  "REQUEST_CANCELLED",
  "INTERNAL_ERROR",
  "DRAFT_TOO_LARGE",
  "DRAFT_EMPTY",
  "DRAFT_PERSIST_FAILED",
  "TRANSCRIPT_EMPTY",
  "NORMALIZATION_FAILED",
  "NORMALIZATION_EXPIRED",
  "GLOSSARY_CONFLICT",
  "RECORDING_UNDO_CONFLICT",
  "CHAT_MISMATCH",
  "PERMISSION_DENIED",
  "SEND_FAILED"
];
function isBackendResponse(value) {
  if (!hasEnvelope(value) || typeof value.ok !== "boolean") return false;
  if (value.type === "app.health.response") {
    return value.ok === true && isBoundedString(value.backendVersion, 1, 128) && isBoundedString(value.frontendVersion, 1, 128) && isBoundedString(value.serverTimestamp, 1, 128) && isPermissionSnapshot(value.permissions);
  }
  if (value.type === "app.operation.cancelled") {
    return value.ok === true && isIdentifier(value.targetRequestId) && typeof value.cancellationAccepted === "boolean";
  }
  if (value.type === "draft.snapshot.response") {
    return value.ok === true && (value.outcome === "loaded" || value.outcome === "applied" || value.outcome === "unchanged" || value.outcome === "stale-version") && (value.operationId === void 0 || isIdentifier(value.operationId)) && isDraftSnapshot(value.snapshot);
  }
  if (value.type === "draft.send.response") {
    return value.ok === true && isIdentifier(value.operationId) && value.messageIdPresent === true && typeof value.generationIdPresent === "boolean" && isDraftSnapshot(value.snapshot);
  }
  if (value.type === "transcript.normalization.response") {
    return value.ok === true && (value.outcome === "committed" || value.outcome === "review") && isNormalizationProposal(value.proposal) && (value.snapshot === void 0 || isDraftSnapshot(value.snapshot)) && (value.glossaryLearned === void 0 || Array.isArray(value.glossaryLearned) && value.glossaryLearned.every(isGlossaryEntry));
  }
  if (value.type === "phase4.state.response") {
    return value.ok === true && isPhaseFourSettings(value.settings) && Array.isArray(value.glossary) && value.glossary.every(isGlossaryEntry) && typeof value.canUndoGlossary === "boolean" && (value.notice === void 0 || isBoundedString(value.notice, 1, 1e3));
  }
  if (value.type === "app.error") {
    return value.ok === false && typeof value.code === "string" && ERROR_CODES.includes(value.code) && isBoundedString(value.message, 1, 2e3) && typeof value.retryable === "boolean" && (value.operationId === void 0 || isIdentifier(value.operationId)) && (value.snapshot === void 0 || isDraftSnapshot(value.snapshot));
  }
  return false;
}
function sanitizeGrantedPermissions(granted) {
  return {
    declared: [...PHASE_FOUR_PERMISSIONS],
    granted: PHASE_FOUR_PERMISSIONS.filter((permission) => granted.includes(permission))
  };
}
function isDraftSnapshot(value) {
  if (!isRecord(value)) return false;
  return isIdentifier(value.chatId) && isNonNegativeInteger(value.draftVersion) && typeof value.cleanText === "string" && value.cleanText.length <= MAX_DRAFT_CHARACTERS && Array.isArray(value.paragraphs) && value.paragraphs.every(
    (paragraph) => isRecord(paragraph) && isIdentifier(paragraph.id) && isPositiveInteger(paragraph.ordinal) && isNonNegativeInteger(paragraph.lineIndex) && typeof paragraph.text === "string" && paragraph.text.trim().length > 0
  ) && Array.isArray(value.history) && value.history.length <= MAX_HISTORY_ENTRIES && value.history.every(isHistoryEntry) && (value.latestDiff === null || isDiff(value.latestDiff)) && typeof value.canUndo === "boolean" && Array.isArray(value.recordingSegments) && value.recordingSegments.length <= MAX_RECORDING_SEGMENTS && value.recordingSegments.every(isRecordingSegment) && typeof value.canUndoRecording === "boolean" && typeof value.dirty === "boolean" && isBoundedString(value.updatedAt, 1, 128);
}
function isHistoryEntry(value) {
  return isRecord(value) && isIdentifier(value.id) && (value.kind === "manual-edit" || value.kind === "undo" || value.kind === "recording-append" || value.kind === "recording-undo") && (value.editGroupId === void 0 || isIdentifier(value.editGroupId)) && isNonNegativeInteger(value.beforeVersion) && isPositiveInteger(value.afterVersion) && isBoundedString(value.timestamp, 1, 128) && isDiff(value.diff);
}
function isRecordingSegment(value) {
  return isRecord(value) && isIdentifier(value.id) && isBoundedString(value.rawTranscript, 1, MAX_DRAFT_CHARACTERS) && isBoundedString(value.normalizedTranscript, 1, MAX_DRAFT_CHARACTERS) && isRecordingNormalization(value.normalization) && isBoundedString(value.committedText, 1, MAX_DRAFT_CHARACTERS) && isNonNegativeInteger(value.startOffset) && isNonNegativeInteger(value.beforeVersion) && isPositiveInteger(value.resultingVersion) && value.resultingVersion === value.beforeVersion + 1 && isBoundedString(value.committedAt, 1, 128);
}
function isRecordingNormalization(value) {
  return isRecord(value) && Array.isArray(value.reasons) && value.reasons.every((reason) => isBoundedString(reason, 1, 200)) && isNonNegativeInteger(value.contextMessageCount) && isNonNegativeInteger(value.contextCharacterCount) && typeof value.contextTruncated === "boolean" && typeof value.contextualModelUsed === "boolean";
}
function isDiff(value) {
  return isRecord(value) && typeof value.removed === "string" && typeof value.added === "string" && value.removed.length <= MAX_DRAFT_CHARACTERS && value.added.length <= MAX_DRAFT_CHARACTERS && isNonNegativeInteger(value.startOffset) && Array.isArray(value.affectedParagraphOrdinals) && value.affectedParagraphOrdinals.every(isPositiveInteger);
}
function isPermissionSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.declared) || !Array.isArray(value.granted)) {
    return false;
  }
  return value.declared.length === PHASE_FOUR_PERMISSIONS.length && value.declared.every((permission, index) => permission === PHASE_FOUR_PERMISSIONS[index]) && value.granted.length <= PHASE_FOUR_PERMISSIONS.length && value.granted.every((permission) => PHASE_FOUR_PERMISSIONS.includes(permission)) && new Set(value.granted).size === value.granted.length;
}
function isPhaseFourSettings(value) {
  return isRecord(value) && isNonNegativeInteger(value.contextMessageCount) && value.contextMessageCount <= 20 && typeof value.contextualNormalizationEnabled === "boolean";
}
function isNormalizationProposal(value) {
  return isRecord(value) && isIdentifier(value.operationId) && isIdentifier(value.chatId) && isNonNegativeInteger(value.expectedVersion) && isBoundedString(value.rawTranscript, 1, MAX_DRAFT_CHARACTERS) && isBoundedString(value.candidateText, 1, MAX_DRAFT_CHARACTERS) && Array.isArray(value.reasons) && value.reasons.every((reason) => isBoundedString(reason, 1, 200)) && Array.isArray(value.ambiguities) && value.ambiguities.every((reason) => isBoundedString(reason, 1, 500)) && Array.isArray(value.learningCandidates) && value.learningCandidates.every(
    (candidate) => isRecord(candidate) && isBoundedString(candidate.canonical, 1, 200) && typeof candidate.spokenVariant === "string" && candidate.spokenVariant.length <= 500
  ) && isNonNegativeInteger(value.contextMessageCount) && isNonNegativeInteger(value.contextCharacterCount) && typeof value.contextTruncated === "boolean" && typeof value.contextualModelUsed === "boolean";
}
function isGlossaryEntry(value) {
  return isRecord(value) && isIdentifier(value.id) && isBoundedString(value.canonical, 1, 200) && Array.isArray(value.variants) && value.variants.every((variant) => isBoundedString(variant, 1, 200)) && typeof value.hint === "string" && value.hint.length <= 500 && (value.source === "explicit-spelling" || value.source === "manual") && isNonNegativeInteger(value.useCount) && isBoundedString(value.createdAt, 1, 128) && isBoundedString(value.updatedAt, 1, 128);
}
function hasEnvelope(value) {
  return isRecord(value) && value.protocolVersion === PROTOCOL_VERSION && isBoundedString(value.type, 1, 128) && isIdentifier(value.requestId);
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isIdentifier(value) {
  return isBoundedString(value, 1, 256);
}
function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// src/frontend.ts
var MAX_RECORDING_DURATION_MS = 5 * 60 * 1e3;
function setup(ctx) {
  ctx.deferReady();
  const tab = ctx.ui.registerDrawerTab({
    id: "jarvistype-composer",
    title: "JarvisType",
    shortName: "Jarvis",
    description: "Compose and revise a private message before sending it.",
    keywords: ["voice", "dictation", "draft", "speech"]
  });
  const inputAction = ctx.ui.registerInputBarAction({
    id: "jarvistype-open",
    label: "JarvisType",
    subtitle: "Open private composition draft"
  });
  tab.root.innerHTML = shellMarkup();
  const backendStatus = requireElement(tab.root, "[data-backend-status]");
  const hostVersions = requireElement(tab.root, "[data-host-versions]");
  const activeChatStatus = requireElement(tab.root, "[data-active-chat]");
  const ownerChatStatus = requireElement(tab.root, "[data-owner-chat]");
  const permissionStatus = requireElement(tab.root, "[data-permission-status]");
  const shellStatus = requireElement(tab.root, "[data-shell-status]");
  const mismatchNotice = requireElement(tab.root, "[data-chat-mismatch]");
  const retryButton = requireElement(tab.root, "[data-retry-backend]");
  const switchDraftButton = requireElement(tab.root, "[data-switch-draft]");
  const editor = requireElement(tab.root, "[data-draft-editor]");
  const draftMeta = requireElement(tab.root, "[data-draft-meta]");
  const paragraphList = requireElement(tab.root, "[data-paragraph-list]");
  const recordButton = requireElement(tab.root, "[data-record-message]");
  const cancelRecordingButton = requireElement(
    tab.root,
    "[data-cancel-recording]"
  );
  const undoRecordingButton = requireElement(tab.root, "[data-undo-recording]");
  const voiceStatus = requireElement(tab.root, "[data-voice-status]");
  const voiceElapsed = requireElement(tab.root, "[data-voice-elapsed]");
  const voiceProvider = requireElement(tab.root, "[data-voice-provider]");
  const voiceProvisional = requireElement(tab.root, "[data-voice-provisional]");
  const voiceFinal = requireElement(tab.root, "[data-voice-final]");
  const voiceSegmentCount = requireElement(tab.root, "[data-voice-segment-count]");
  const diffPanel = requireElement(tab.root, "[data-diff-panel]");
  const diffParagraphs = requireElement(tab.root, "[data-diff-paragraphs]");
  const diffRemoved = requireElement(tab.root, "[data-diff-removed]");
  const diffAdded = requireElement(tab.root, "[data-diff-added]");
  const undoButton = requireElement(tab.root, "[data-undo]");
  const historyButton = requireElement(tab.root, "[data-history-toggle]");
  const historyPanel = requireElement(tab.root, "[data-history-panel]");
  const historyList = requireElement(tab.root, "[data-history-list]");
  const sendButton = requireElement(tab.root, "[data-send]");
  const proposalPanel = requireElement(tab.root, "[data-normalization-proposal]");
  const proposalRaw = requireElement(tab.root, "[data-proposal-raw]");
  const proposalCandidate = requireElement(tab.root, "[data-proposal-candidate]");
  const proposalMeta = requireElement(tab.root, "[data-proposal-meta]");
  const acceptProposalButton = requireElement(tab.root, "[data-proposal-accept]");
  const rejectProposalButton = requireElement(tab.root, "[data-proposal-reject]");
  const contextCountInput = requireElement(tab.root, "[data-context-count]");
  const contextualToggle = requireElement(tab.root, "[data-context-enabled]");
  const saveSettingsButton = requireElement(tab.root, "[data-settings-save]");
  const glossaryCanonicalInput = requireElement(
    tab.root,
    "[data-glossary-canonical]"
  );
  const glossaryVariantsInput = requireElement(
    tab.root,
    "[data-glossary-variants]"
  );
  const glossaryHintInput = requireElement(tab.root, "[data-glossary-hint]");
  const glossarySaveButton = requireElement(tab.root, "[data-glossary-save]");
  const glossaryCancelButton = requireElement(tab.root, "[data-glossary-cancel]");
  const glossaryUndoButton = requireElement(tab.root, "[data-glossary-undo]");
  const glossaryList = requireElement(tab.root, "[data-glossary-list]");
  const phaseFourStatus = requireElement(tab.root, "[data-phase4-status]");
  const state = {
    activeChatId: ctx.getActiveChat().chatId,
    snapshot: null,
    backendState: "connecting",
    backendVersion: null,
    frontendVersion: null,
    permissions: {
      declared: ["media", "chats", "chat_mutation", "generation"],
      granted: []
    },
    statusMessage: "Connecting to the JarvisType backend\u2026",
    loading: false,
    saving: false,
    automatedBusy: false,
    sending: false,
    sendOutcomeUnknown: false,
    historyExpanded: false,
    voicePhase: "idle",
    voiceElapsedMs: 0,
    voiceProvider: null,
    voiceProvisionalText: "",
    voiceFinalText: "",
    voiceMessage: "Ready to record a message segment.",
    pendingProposal: null,
    settings: { contextMessageCount: 5, contextualNormalizationEnabled: true },
    glossary: [],
    canUndoGlossary: false,
    phaseFourMessage: "Loading context and glossary settings\u2026"
  };
  let alive = true;
  let currentHealthRequestId = null;
  let desiredText = "";
  let mutationInFlight = false;
  let editGroupId = null;
  let editGroupTimer = null;
  let sendFlowActive = false;
  let activeRecording = null;
  let recordingTimer = null;
  let recordingDeadline = null;
  let recordingStartedAt = 0;
  let editingGlossaryEntryId;
  const disposers = [];
  const sendCancellation = (requestId) => {
    if (!alive) return;
    send({
      protocolVersion: PROTOCOL_VERSION,
      type: "app.operation.cancel",
      requestId: createRequestId("cancel"),
      targetRequestId: requestId
    });
  };
  const registry = new RequestRegistry(REQUEST_TIMEOUT_MS, sendCancellation);
  const sendRegistry = new RequestRegistry(SEND_TIMEOUT_MS, sendCancellation);
  const hasChatMismatch = () => Boolean(
    state.snapshot?.dirty && state.snapshot.chatId && state.activeChatId !== state.snapshot.chatId
  );
  const hasNativeStt = () => Boolean((ctx.host.capabilities["speech-to-text-v1"] ?? 0) >= 1 && ctx.stt);
  const voiceBusy = () => state.voicePhase === "starting" || state.voicePhase === "recording" || state.voicePhase === "processing" || state.voicePhase === "committing" || state.voicePhase === "review";
  const render = () => {
    backendStatus.textContent = state.backendState === "ready" ? "Ready" : state.backendState === "connecting" ? "Connecting\u2026" : "Unavailable";
    backendStatus.dataset.state = state.backendState;
    hostVersions.textContent = state.backendVersion && state.frontendVersion ? `Lumiverse backend ${state.backendVersion} \xB7 frontend ${state.frontendVersion}` : "Host versions pending";
    activeChatStatus.textContent = state.activeChatId ? `Active chat: ${state.activeChatId}` : "Active chat: none";
    ownerChatStatus.textContent = state.snapshot ? `Draft owner: ${state.snapshot.chatId}` : "Draft owner: not loaded";
    const granted = state.permissions.granted;
    permissionStatus.textContent = `Permissions: media ${grantLabel(granted, "media")} \xB7 chats ${grantLabel(granted, "chats")} \xB7 send ${grantLabel(granted, "chat_mutation")} \xB7 generation ${grantLabel(granted, "generation")}`;
    shellStatus.textContent = state.statusMessage;
    retryButton.hidden = state.backendState !== "unavailable";
    const mismatch = hasChatMismatch();
    mismatchNotice.hidden = !mismatch;
    switchDraftButton.hidden = !state.activeChatId || state.activeChatId === state.snapshot?.chatId;
    const editorEnabled = state.backendState === "ready" && state.snapshot !== null && !state.loading && !state.automatedBusy && !state.sending && !voiceBusy();
    editor.disabled = !editorEnabled;
    draftMeta.textContent = state.snapshot ? `Version ${state.snapshot.draftVersion} \xB7 ${desiredText.length.toLocaleString()} / ${MAX_DRAFT_CHARACTERS.toLocaleString()} characters${state.saving ? " \xB7 Saving\u2026" : " \xB7 Saved"}` : "Draft not loaded";
    renderParagraphs(paragraphList, desiredText);
    renderDiff(state.snapshot, diffPanel, diffParagraphs, diffRemoved, diffAdded);
    renderHistory(historyList, state.snapshot);
    historyPanel.hidden = !state.historyExpanded;
    historyButton.textContent = state.historyExpanded ? "Hide History" : "Show History";
    historyButton.disabled = !state.snapshot || state.snapshot.history.length === 0;
    undoButton.disabled = !editorEnabled || state.saving || !state.snapshot?.canUndo || desiredText !== state.snapshot.cleanText;
    const recordingOwnerReady = state.backendState === "ready" && state.snapshot !== null && !state.loading && !state.saving && !state.automatedBusy && !state.sending && !mismatch && state.activeChatId === state.snapshot.chatId && desiredText === state.snapshot.cleanText;
    recordButton.textContent = state.voicePhase === "starting" || state.voicePhase === "recording" ? "Stop Recording" : state.voicePhase === "processing" ? "Transcribing\u2026" : state.voicePhase === "committing" ? "Normalizing\u2026" : state.voicePhase === "review" ? "Review required" : "Record Message";
    recordButton.disabled = !hasNativeStt() || !recordingOwnerReady || state.voicePhase === "processing" || state.voicePhase === "committing" || state.voicePhase === "review";
    cancelRecordingButton.hidden = !(state.voicePhase === "starting" || state.voicePhase === "recording" || state.voicePhase === "processing");
    cancelRecordingButton.disabled = !activeRecording;
    undoRecordingButton.disabled = !recordingOwnerReady || voiceBusy() || !state.snapshot?.canUndoRecording;
    voiceStatus.textContent = state.voiceMessage;
    voiceStatus.dataset.phase = state.voicePhase;
    voiceElapsed.textContent = `Elapsed: ${formatDuration(state.voiceElapsedMs)}`;
    voiceProvider.textContent = state.voiceProvider ? `Provider: ${state.voiceProvider}` : hasNativeStt() ? "Provider: Lumiverse selection" : "Speech-to-text unavailable on this host";
    voiceProvisional.textContent = state.voiceProvisionalText || "No interim transcript received.";
    voiceProvisional.hidden = state.voiceProvisionalText.length === 0;
    voiceFinal.textContent = state.voiceFinalText || "No completed recording yet.";
    voiceSegmentCount.textContent = `Committed recording segments: ${state.snapshot?.recordingSegments.length ?? 0}`;
    const proposal = state.pendingProposal;
    proposalPanel.hidden = !proposal;
    proposalRaw.textContent = proposal?.rawTranscript ?? "";
    proposalCandidate.textContent = proposal?.candidateText ?? "";
    proposalMeta.textContent = proposal ? `${proposal.contextMessageCount} context message(s), ${proposal.contextCharacterCount} characters${proposal.contextTruncated ? ", truncated to the privacy limit" : ""}. ${proposal.reasons.length ? `Changes: ${proposal.reasons.join(", ")}.` : ""}${proposal.ambiguities.length ? ` Review: ${proposal.ambiguities.join(" ")}` : ""}` : "";
    acceptProposalButton.disabled = !proposal || state.automatedBusy;
    rejectProposalButton.disabled = !proposal || state.automatedBusy;
    contextCountInput.value = String(state.settings.contextMessageCount);
    contextualToggle.checked = state.settings.contextualNormalizationEnabled;
    phaseFourStatus.textContent = state.phaseFourMessage;
    glossaryUndoButton.disabled = !state.canUndoGlossary || state.automatedBusy;
    glossarySaveButton.textContent = editingGlossaryEntryId ? "Update entry" : "Add entry";
    glossaryCancelButton.hidden = !editingGlossaryEntryId;
    renderGlossary(glossaryList, state.glossary);
    sendButton.disabled = !editorEnabled || state.saving || mismatch || desiredText.trim().length === 0 || desiredText !== state.snapshot?.cleanText || state.sendOutcomeUnknown || sendFlowActive || voiceBusy();
  };
  const send = (request) => {
    if (alive) ctx.sendToBackend(request);
  };
  const performRequest = async (request, isSend = false) => {
    const targetRegistry = isSend ? sendRegistry : registry;
    const outcome = targetRegistry.wait(request.requestId);
    send(request);
    return outcome;
  };
  const applySnapshot = (snapshot, syncEditor) => {
    state.snapshot = snapshot;
    if (syncEditor) {
      desiredText = snapshot.cleanText;
      editor.value = snapshot.cleanText;
    }
    if (desiredText === snapshot.cleanText) clearDraftBackup(snapshot.chatId);
  };
  const loadDraft = async (chatId) => {
    if (!alive || state.loading) return;
    state.loading = true;
    state.statusMessage = "Loading the chat-owned draft\u2026";
    render();
    const requestId = createRequestId("load");
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "draft.load.request",
      requestId,
      chatId
    });
    state.loading = false;
    if (!alive) return;
    if (outcome.status === "resolved" && outcome.value.type === "draft.snapshot.response") {
      applySnapshot(outcome.value.snapshot, true);
      state.sendOutcomeUnknown = false;
      const backup = loadDraftBackup(chatId);
      if (backup !== null && backup !== outcome.value.snapshot.cleanText) {
        desiredText = backup;
        editor.value = backup;
        state.statusMessage = "Recovering locally buffered text into the private draft\u2026";
        void drainMutations();
      } else {
        state.statusMessage = outcome.value.snapshot.dirty ? "Restored the private draft for this chat." : "Draft ready. Nothing is sent until you confirm.";
      }
    } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
      state.statusMessage = outcome.value.message;
    } else if (outcome.status === "timed-out") {
      state.statusMessage = "Draft loading timed out. Retry the backend connection.";
    }
    render();
  };
  const refreshPermissions = async () => {
    try {
      state.permissions = sanitizeGrantedPermissions(await ctx.permissions.getGranted());
    } catch {
      state.statusMessage = "Permission status is temporarily unavailable.";
    }
    if (alive) render();
  };
  const loadPhaseFourState = async () => {
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "phase4.load.request",
      requestId: createRequestId("phase4-load")
    });
    if (!alive) return;
    if (outcome.status === "resolved" && outcome.value.type === "phase4.state.response") {
      state.settings = outcome.value.settings;
      state.glossary = outcome.value.glossary;
      state.canUndoGlossary = outcome.value.canUndoGlossary;
      state.phaseFourMessage = outcome.value.notice ?? "Context and glossary settings ready.";
    } else {
      state.phaseFourMessage = "Context and glossary settings could not be loaded. Retry the backend connection.";
    }
    render();
  };
  const refreshHostState = async () => {
    const nextChatId = ctx.getActiveChat().chatId;
    const changed = nextChatId !== state.activeChatId;
    state.activeChatId = nextChatId;
    await refreshPermissions();
    if (!alive || !changed || !nextChatId || state.loading) return;
    if (!state.snapshot || !state.snapshot.dirty && desiredText.length === 0) {
      await loadDraft(nextChatId);
    } else if (state.snapshot.chatId !== nextChatId) {
      state.statusMessage = "Active chat changed. This draft remains attached to its original chat and cannot be sent here.";
      render();
    }
  };
  const checkBackend = async () => {
    if (!alive) return;
    if (currentHealthRequestId) registry.cancel(currentHealthRequestId);
    const requestId = createRequestId("health");
    currentHealthRequestId = requestId;
    state.backendState = "connecting";
    state.statusMessage = "Connecting to the JarvisType backend\u2026";
    render();
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "app.health.request",
      requestId,
      clientTimestamp: (/* @__PURE__ */ new Date()).toISOString(),
      activeChatId: state.activeChatId
    });
    if (!alive || currentHealthRequestId !== requestId) return;
    currentHealthRequestId = null;
    if (outcome.status === "resolved" && outcome.value.type === "app.health.response") {
      state.backendState = "ready";
      state.backendVersion = outcome.value.backendVersion;
      state.frontendVersion = outcome.value.frontendVersion;
      state.permissions = outcome.value.permissions;
      state.statusMessage = "Backend ready. Loading the active chat draft\u2026";
      render();
      await loadPhaseFourState();
      if (state.activeChatId) await loadDraft(state.activeChatId);
      else {
        state.statusMessage = "Select a chat to begin a private draft.";
        render();
      }
    } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
      state.backendState = "unavailable";
      state.statusMessage = outcome.value.message;
      render();
    } else if (outcome.status === "timed-out") {
      state.backendState = "unavailable";
      state.statusMessage = "The backend did not respond. No draft content was sent.";
      render();
    }
  };
  const beginEditGroup = () => {
    editGroupId ??= createRequestId("edit-group");
    if (editGroupTimer) clearTimeout(editGroupTimer);
    editGroupTimer = setTimeout(() => {
      editGroupId = null;
      editGroupTimer = null;
    }, 1200);
    return editGroupId;
  };
  const drainMutations = async () => {
    if (mutationInFlight || !state.snapshot || !alive) return;
    mutationInFlight = true;
    state.saving = true;
    render();
    try {
      while (alive && state.snapshot && desiredText !== state.snapshot.cleanText && !state.automatedBusy && !state.sending) {
        const snapshot = state.snapshot;
        const requestId = createRequestId("mutate");
        const operationId = createRequestId("manual-edit");
        const textForRequest = desiredText;
        const outcome = await performRequest({
          protocolVersion: PROTOCOL_VERSION,
          type: "draft.mutate.request",
          requestId,
          operationId,
          chatId: snapshot.chatId,
          expectedVersion: snapshot.draftVersion,
          editGroupId: beginEditGroup(),
          cleanText: textForRequest
        });
        if (!alive) return;
        if (outcome.status === "resolved" && outcome.value.type === "draft.snapshot.response") {
          applySnapshot(outcome.value.snapshot, false);
          state.statusMessage = outcome.value.outcome === "stale-version" ? "Draft changed elsewhere; reconciling your latest text safely\u2026" : "Draft saved privately.";
          if (desiredText === outcome.value.snapshot.cleanText) {
            clearDraftBackup(outcome.value.snapshot.chatId);
          }
        } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
          if (outcome.value.snapshot) applySnapshot(outcome.value.snapshot, false);
          state.statusMessage = outcome.value.message;
          break;
        } else {
          state.statusMessage = "Draft save timed out. Your text remains visible; retry before leaving.";
          break;
        }
      }
    } finally {
      mutationInFlight = false;
      state.saving = desiredText !== state.snapshot?.cleanText;
      render();
    }
  };
  const handleEditorInput = () => {
    desiredText = editor.value;
    if (state.snapshot) saveDraftBackup(state.snapshot.chatId, desiredText);
    beginEditGroup();
    state.statusMessage = "Saving the private draft\u2026";
    state.saving = true;
    render();
    void drainMutations();
  };
  const handleUndo = async () => {
    if (!state.snapshot || state.automatedBusy || state.sending) return;
    await drainMutations();
    if (!state.snapshot.canUndo || desiredText !== state.snapshot.cleanText) return;
    state.automatedBusy = true;
    state.statusMessage = "Undoing the latest draft mutation\u2026";
    render();
    const snapshot = state.snapshot;
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "draft.undo.request",
      requestId: createRequestId("undo"),
      operationId: createRequestId("undo-operation"),
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion
    });
    state.automatedBusy = false;
    if (!alive) return;
    if (outcome.status === "resolved" && outcome.value.type === "draft.snapshot.response") {
      applySnapshot(outcome.value.snapshot, true);
      state.statusMessage = outcome.value.outcome === "applied" ? "Latest draft mutation undone." : "Nothing to undo.";
    } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
      state.statusMessage = outcome.value.message;
    } else {
      state.statusMessage = "Undo timed out. The existing draft was preserved.";
    }
    render();
  };
  const clearRecordingTimers = () => {
    if (recordingTimer) clearInterval(recordingTimer);
    if (recordingDeadline) clearTimeout(recordingDeadline);
    recordingTimer = null;
    recordingDeadline = null;
  };
  const cancelActiveRecording = (message) => {
    const recording = activeRecording;
    if (!recording) return;
    activeRecording = null;
    clearRecordingTimers();
    recording.session.cancel();
    state.voicePhase = "idle";
    state.voiceProvisionalText = "";
    state.voiceMessage = message;
    render();
  };
  const commitRecordingTranscript = async (rawTranscript, operationId) => {
    const snapshot = state.snapshot;
    if (!snapshot || ctx.getActiveChat().chatId !== snapshot.chatId) {
      state.voicePhase = "error";
      state.voiceMessage = "The active chat changed before the transcript could be appended. No text was committed.";
      render();
      return;
    }
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "transcript.normalize.request",
      requestId: createRequestId("transcript-normalize"),
      operationId,
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion,
      rawTranscript
    });
    if (!alive) return;
    if (outcome.status === "resolved" && outcome.value.type === "transcript.normalization.response") {
      if (outcome.value.outcome === "review") {
        state.pendingProposal = outcome.value.proposal;
        state.voicePhase = "review";
        state.voiceMessage = "Review the raw and normalized transcript before committing this segment.";
        render();
        return;
      }
      if (!outcome.value.snapshot) return;
      applySnapshot(outcome.value.snapshot, true);
      const committed = outcome.value.snapshot.recordingSegments.some(
        (segment) => segment.id === operationId
      );
      state.voicePhase = committed ? "idle" : "error";
      state.voiceMessage = committed ? "Normalized transcript appended; the original remains in the segment audit record." : "The final transcript was not appended. The existing draft was preserved.";
      if (outcome.value.glossaryLearned?.length) void loadPhaseFourState();
    } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
      if (outcome.value.snapshot) applySnapshot(outcome.value.snapshot, true);
      state.voicePhase = "error";
      state.voiceMessage = outcome.value.message;
    } else {
      state.voicePhase = "error";
      state.voiceMessage = "Transcript commit timed out. Reload this chat\u2019s draft before recording again.";
    }
    render();
  };
  const acceptNormalizationProposal = async () => {
    const proposal = state.pendingProposal;
    if (!proposal || state.automatedBusy) return;
    state.automatedBusy = true;
    state.voiceMessage = "Committing the reviewed transcript\u2026";
    render();
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "transcript.confirm.request",
      requestId: createRequestId("transcript-confirm"),
      operationId: proposal.operationId,
      chatId: proposal.chatId,
      expectedVersion: proposal.expectedVersion
    });
    state.automatedBusy = false;
    if (!alive) return;
    if (outcome.status === "resolved" && outcome.value.type === "transcript.normalization.response" && outcome.value.snapshot) {
      applySnapshot(outcome.value.snapshot, true);
      state.pendingProposal = null;
      state.voicePhase = "idle";
      state.voiceMessage = "Reviewed transcript appended to the draft.";
      if (outcome.value.glossaryLearned?.length) {
        state.phaseFourMessage = `Learned ${outcome.value.glossaryLearned.map((entry) => entry.canonical).join(", ")} from confirmed spelling. The glossary change is undoable.`;
        await loadPhaseFourState();
      }
    } else {
      state.voicePhase = "error";
      state.voiceMessage = outcome.status === "resolved" && outcome.value.type === "app.error" ? outcome.value.message : "Transcript confirmation timed out. Nothing was appended.";
    }
    render();
  };
  const rejectNormalizationProposal = () => {
    state.pendingProposal = null;
    state.voicePhase = "idle";
    state.voiceMessage = "Normalized transcript rejected. Nothing was appended or learned.";
    render();
  };
  const applyPhaseFourResponse = (response) => {
    state.settings = response.settings;
    state.glossary = response.glossary;
    state.canUndoGlossary = response.canUndoGlossary;
    state.phaseFourMessage = response.notice ?? "Context and glossary settings ready.";
  };
  const saveSettings = async () => {
    const contextMessageCount = Math.min(
      20,
      Math.max(0, Number.parseInt(contextCountInput.value, 10) || 0)
    );
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "phase4.settings.update.request",
      requestId: createRequestId("settings-update"),
      settings: { contextMessageCount, contextualNormalizationEnabled: contextualToggle.checked }
    });
    if (outcome.status === "resolved" && outcome.value.type === "phase4.state.response")
      applyPhaseFourResponse(outcome.value);
    else state.phaseFourMessage = "Settings were not saved. Try again.";
    render();
  };
  const saveGlossaryEntry = async () => {
    const canonical = glossaryCanonicalInput.value.trim();
    if (!canonical) {
      state.phaseFourMessage = "Enter a canonical spelling before saving.";
      render();
      return;
    }
    const variants = glossaryVariantsInput.value.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 20);
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "glossary.upsert.request",
      requestId: createRequestId("glossary-upsert"),
      ...editingGlossaryEntryId ? { entryId: editingGlossaryEntryId } : {},
      canonical,
      variants,
      hint: glossaryHintInput.value.trim()
    });
    if (outcome.status === "resolved" && outcome.value.type === "phase4.state.response") {
      applyPhaseFourResponse(outcome.value);
      clearGlossaryForm();
    } else if (outcome.status === "resolved" && outcome.value.type === "app.error")
      state.phaseFourMessage = outcome.value.message;
    else state.phaseFourMessage = "Glossary entry was not saved. Try again.";
    render();
  };
  const clearGlossaryForm = () => {
    editingGlossaryEntryId = void 0;
    glossaryCanonicalInput.value = "";
    glossaryVariantsInput.value = "";
    glossaryHintInput.value = "";
  };
  const handleGlossaryListClick = async (event) => {
    const button = event.target?.closest(
      "button[data-glossary-action]"
    );
    if (!button) return;
    const entry = state.glossary.find((item) => item.id === button.dataset.entryId);
    if (!entry) return;
    if (button.dataset.glossaryAction === "edit") {
      editingGlossaryEntryId = entry.id;
      glossaryCanonicalInput.value = entry.canonical;
      glossaryVariantsInput.value = entry.variants.join(", ");
      glossaryHintInput.value = entry.hint;
      render();
      return;
    }
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "glossary.delete.request",
      requestId: createRequestId("glossary-delete"),
      entryId: entry.id
    });
    if (outcome.status === "resolved" && outcome.value.type === "phase4.state.response")
      applyPhaseFourResponse(outcome.value);
    render();
  };
  const undoGlossary = async () => {
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "glossary.undo.request",
      requestId: createRequestId("glossary-undo")
    });
    if (outcome.status === "resolved" && outcome.value.type === "phase4.state.response")
      applyPhaseFourResponse(outcome.value);
    render();
  };
  const finishRecording = async (runId, transcript) => {
    const recording = activeRecording;
    if (!recording || recording.runId !== runId) return;
    activeRecording = null;
    clearRecordingTimers();
    state.voiceElapsedMs = Math.max(0, Date.now() - recordingStartedAt);
    state.voiceProvisionalText = "";
    state.voiceFinalText = transcript.text;
    state.voiceProvider = transcript.provider;
    if (transcript.text.trim().length === 0) {
      state.voicePhase = "error";
      state.voiceMessage = "No usable speech was recognized. Nothing was appended.";
      render();
      return;
    }
    state.voicePhase = "committing";
    state.voiceMessage = "Transcription complete. Applying bounded context, punctuation, spelling, and glossary rules\u2026";
    render();
    await commitRecordingTranscript(transcript.text, recording.operationId);
  };
  const failRecording = (runId, error) => {
    if (activeRecording?.runId !== runId) return;
    activeRecording = null;
    clearRecordingTimers();
    state.voiceProvisionalText = "";
    state.voicePhase = "error";
    state.voiceMessage = describeRecordingError(error);
    render();
  };
  const stopActiveRecording = () => {
    const recording = activeRecording;
    if (!recording || state.voicePhase === "processing") return;
    state.voicePhase = "processing";
    state.voiceMessage = "Recording stopped. Waiting for the authoritative transcript\u2026";
    render();
    void recording.session.stop().catch(() => {
    });
  };
  const startRecording = () => {
    const stt = ctx.stt;
    const snapshot = state.snapshot;
    if (!stt || !hasNativeStt() || !snapshot) return;
    const runId = createRequestId("recording-run");
    const operationId = createRequestId("recording-segment");
    const finalSegments = [];
    try {
      const session = stt.start({
        continuous: true,
        interimResults: true,
        onStatus: (status) => {
          if (activeRecording?.runId !== runId) return;
          if (status.phase === "listening") {
            state.voicePhase = "recording";
            state.voiceMessage = "Recording\u2026 Speak naturally, then select Stop Recording.";
          } else if (status.phase === "processing") {
            state.voicePhase = "processing";
            state.voiceMessage = "Transcribing the completed recording\u2026";
          } else {
            state.voiceMessage = "Preparing the configured speech-to-text provider\u2026";
          }
          render();
        },
        onResult: (result) => {
          const current = activeRecording;
          if (!current || current.runId !== runId) return;
          if (result.isFinal) {
            if (result.text) finalSegments.push(result.text);
            current.interimText = "";
          } else {
            current.interimText = result.text;
          }
          state.voiceProvisionalText = joinTranscriptUpdates(finalSegments, current.interimText);
          render();
        }
      });
      activeRecording = {
        runId,
        operationId,
        session,
        finalSegments,
        interimText: ""
      };
      recordingStartedAt = Date.now();
      state.voicePhase = "starting";
      state.voiceElapsedMs = 0;
      state.voiceProvider = session.provider;
      state.voiceProvisionalText = "";
      state.voiceMessage = "Starting microphone capture\u2026";
      recordingTimer = setInterval(() => {
        if (!activeRecording || activeRecording.runId !== runId) return;
        state.voiceElapsedMs = Date.now() - recordingStartedAt;
        render();
      }, 250);
      recordingDeadline = setTimeout(() => {
        if (activeRecording?.runId !== runId) return;
        state.voiceMessage = "Five-minute recording limit reached. Finalizing\u2026";
        stopActiveRecording();
      }, MAX_RECORDING_DURATION_MS);
      void session.ready.then(() => {
        if (activeRecording?.runId !== runId || state.voicePhase === "processing") return;
        state.voicePhase = "recording";
        state.voiceMessage = "Recording\u2026 Speak naturally, then select Stop Recording.";
        render();
      }).catch((error) => failRecording(runId, error));
      void session.result.then((transcript) => finishRecording(runId, transcript)).catch((error) => failRecording(runId, error));
      render();
    } catch (error) {
      failRecording(runId, error);
      if (!activeRecording) {
        state.voicePhase = "error";
        state.voiceMessage = describeRecordingError(error);
        render();
      }
    }
  };
  const requestRecordingPermissions = async () => {
    const required = ["media", "chats", "generation"];
    const missing = required.filter((permission) => !state.permissions.granted.includes(permission));
    if (!missing.length) return true;
    try {
      const granted = await ctx.permissions.request(missing, {
        reason: "Record through Lumiverse speech-to-text, read bounded chat context, and normalize the transcript through your configured Lumiverse generation connection."
      });
      state.permissions = sanitizeGrantedPermissions(granted);
      const ready = required.every((permission) => granted.includes(permission));
      state.voiceMessage = ready ? "Recording and normalization permissions are ready. Select Record Message again to begin." : "Required recording or normalization permission was not granted. No recording started.";
      render();
      return ready;
    } catch {
      state.voiceMessage = "Required recording or normalization permission was not granted. No recording started.";
      render();
      return false;
    }
  };
  const handleRecordMessage = async () => {
    if (state.voicePhase === "starting" || state.voicePhase === "recording") {
      stopActiveRecording();
      return;
    }
    if (voiceBusy() || !state.snapshot || state.saving || state.activeChatId !== state.snapshot.chatId)
      return;
    const missingPermission = ["media", "chats", "generation"].some(
      (permission) => !state.permissions.granted.includes(permission)
    );
    if (missingPermission) {
      await requestRecordingPermissions();
      return;
    }
    startRecording();
  };
  const handleUndoRecording = async () => {
    const snapshot = state.snapshot;
    if (!snapshot?.canUndoRecording || voiceBusy() || state.saving) return;
    state.automatedBusy = true;
    state.voiceMessage = "Removing the most recently appended recording segment\u2026";
    render();
    const outcome = await performRequest({
      protocolVersion: PROTOCOL_VERSION,
      type: "draft.recording.undo.request",
      requestId: createRequestId("recording-undo"),
      operationId: createRequestId("recording-undo-operation"),
      chatId: snapshot.chatId,
      expectedVersion: snapshot.draftVersion
    });
    state.automatedBusy = false;
    if (!alive) return;
    if (outcome.status === "resolved" && outcome.value.type === "draft.snapshot.response") {
      applySnapshot(outcome.value.snapshot, true);
      state.voiceMessage = outcome.value.outcome === "applied" ? "Last recording segment removed; older content was preserved." : "The last recording can no longer be removed as one unchanged segment.";
    } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
      state.voiceMessage = outcome.value.message;
    } else {
      state.voiceMessage = "Recording undo timed out. The existing draft was preserved.";
    }
    render();
  };
  const requestSendPermissions = async () => {
    const required = ["chats", "chat_mutation", "generation"];
    const missing = required.filter((permission) => !state.permissions.granted.includes(permission));
    if (missing.length === 0) return true;
    try {
      const granted = await ctx.permissions.request(missing, {
        reason: "Verify the owning chat, add the confirmed draft as one user message, and start the normal Lumiverse response."
      });
      state.permissions = sanitizeGrantedPermissions(granted);
      return required.every((permission) => granted.includes(permission));
    } catch {
      state.statusMessage = "Send permissions were not granted. The draft remains private and unchanged.";
      return false;
    }
  };
  const handleSend = async () => {
    if (sendFlowActive || !state.snapshot) return;
    sendFlowActive = true;
    render();
    try {
      await drainMutations();
      const snapshot = state.snapshot;
      const currentChatId = ctx.getActiveChat().chatId;
      state.activeChatId = currentChatId;
      if (!snapshot || desiredText !== snapshot.cleanText || snapshot.cleanText.trim().length === 0) {
        state.statusMessage = "Wait for the draft to finish saving before sending.";
        return;
      }
      if (!currentChatId || currentChatId !== snapshot.chatId) {
        state.statusMessage = "Return to the draft\u2019s owning chat before sending.";
        return;
      }
      if (!await requestSendPermissions()) return;
      const confirmation = await ctx.ui.showConfirm({
        title: "Confirm and send draft?",
        message: "JarvisType will add exactly the clean draft text to this chat and start the normal Lumiverse response.",
        variant: "success",
        confirmLabel: "Confirm & Send"
      });
      if (!confirmation.confirmed) {
        state.statusMessage = "Send cancelled. The draft remains private.";
        return;
      }
      state.sending = true;
      state.statusMessage = "Sending the confirmed clean draft\u2026";
      render();
      const operationId = createRequestId("send-operation");
      const outcome = await performRequest(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "draft.send.request",
          requestId: createRequestId("send"),
          operationId,
          chatId: snapshot.chatId,
          expectedVersion: snapshot.draftVersion
        },
        true
      );
      state.sending = false;
      if (!alive) return;
      if (outcome.status === "resolved" && outcome.value.type === "draft.send.response") {
        applySnapshot(outcome.value.snapshot, true);
        state.sendOutcomeUnknown = false;
        state.statusMessage = outcome.value.generationIdPresent ? "Draft sent once and normal response generation started." : "Draft sent once. Lumiverse did not return a generation identifier.";
      } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
        if (outcome.value.snapshot) applySnapshot(outcome.value.snapshot, true);
        state.sendOutcomeUnknown = false;
        state.statusMessage = outcome.value.message;
      } else {
        state.sendOutcomeUnknown = true;
        state.statusMessage = "Send confirmation timed out. Checking the persisted draft before allowing retry\u2026";
        render();
        await loadDraft(snapshot.chatId);
      }
    } finally {
      state.sending = false;
      sendFlowActive = false;
      render();
    }
  };
  const removeBackendListener = ctx.onBackendMessage((payload) => {
    if (!alive || !isBackendResponse(payload)) return;
    if (!registry.resolve(payload.requestId, payload))
      sendRegistry.resolve(payload.requestId, payload);
  });
  disposers.push(removeBackendListener);
  const refreshFromHost = () => void refreshHostState();
  const handlePermissionChange = () => {
    if (activeRecording) {
      cancelActiveRecording("Recording cancelled because permissions changed.");
    }
    void refreshHostState();
  };
  const handleChatSwitch = () => {
    cancelActiveRecording("Recording cancelled because the active chat changed.");
    if (state.pendingProposal) rejectNormalizationProposal();
    void refreshHostState();
  };
  disposers.push(ctx.events.on("PERMISSION_CHANGED", handlePermissionChange));
  disposers.push(ctx.events.on("CHAT_SWITCHED", handleChatSwitch));
  disposers.push(
    ctx.ui.events.onDrawerChange((drawer) => {
      if (activeRecording && (!drawer.open || drawer.tabId !== tab.tabId)) {
        cancelActiveRecording("Recording cancelled because JarvisType was closed.");
      }
    })
  );
  disposers.push(tab.onActivate(refreshFromHost));
  disposers.push(inputAction.onClick(() => tab.activate()));
  const handleVisibility = () => {
    if (document.visibilityState === "visible") void refreshHostState();
  };
  const handlePageHide = () => cancelActiveRecording("Recording cancelled because the page is closing.");
  const handleFocus = () => void refreshHostState();
  const handleRetry = () => void checkBackend();
  const handleSwitchDraft = () => {
    if (state.activeChatId) void loadDraft(state.activeChatId);
  };
  const handleHistoryToggle = () => {
    state.historyExpanded = !state.historyExpanded;
    render();
  };
  const handleUndoClick = () => void handleUndo();
  const handleRecordClick = () => void handleRecordMessage();
  const handleCancelRecordingClick = () => cancelActiveRecording("Recording cancelled. No transcript was appended.");
  const handleUndoRecordingClick = () => void handleUndoRecording();
  const handleSendClick = () => void handleSend();
  const handleAcceptProposalClick = () => void acceptNormalizationProposal();
  const handleRejectProposalClick = () => rejectNormalizationProposal();
  const handleSaveSettingsClick = () => void saveSettings();
  const handleSaveGlossaryClick = () => void saveGlossaryEntry();
  const handleCancelGlossaryClick = () => {
    clearGlossaryForm();
    render();
  };
  const handleUndoGlossaryClick = () => void undoGlossary();
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("focus", handleFocus);
  retryButton.addEventListener("click", handleRetry);
  switchDraftButton.addEventListener("click", handleSwitchDraft);
  editor.addEventListener("input", handleEditorInput);
  recordButton.addEventListener("click", handleRecordClick);
  cancelRecordingButton.addEventListener("click", handleCancelRecordingClick);
  undoRecordingButton.addEventListener("click", handleUndoRecordingClick);
  undoButton.addEventListener("click", handleUndoClick);
  historyButton.addEventListener("click", handleHistoryToggle);
  sendButton.addEventListener("click", handleSendClick);
  acceptProposalButton.addEventListener("click", handleAcceptProposalClick);
  rejectProposalButton.addEventListener("click", handleRejectProposalClick);
  saveSettingsButton.addEventListener("click", handleSaveSettingsClick);
  glossarySaveButton.addEventListener("click", handleSaveGlossaryClick);
  glossaryCancelButton.addEventListener("click", handleCancelGlossaryClick);
  glossaryUndoButton.addEventListener("click", handleUndoGlossaryClick);
  glossaryList.addEventListener("click", handleGlossaryListClick);
  render();
  void checkBackend();
  ctx.ready();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    alive = false;
    cancelActiveRecording("Recording cancelled during extension cleanup.");
    clearRecordingTimers();
    if (editGroupTimer) clearTimeout(editGroupTimer);
    registry.cancelAll();
    sendRegistry.cancelAll();
    for (const dispose of disposers.splice(0)) dispose();
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("focus", handleFocus);
    retryButton.removeEventListener("click", handleRetry);
    switchDraftButton.removeEventListener("click", handleSwitchDraft);
    editor.removeEventListener("input", handleEditorInput);
    recordButton.removeEventListener("click", handleRecordClick);
    cancelRecordingButton.removeEventListener("click", handleCancelRecordingClick);
    undoRecordingButton.removeEventListener("click", handleUndoRecordingClick);
    undoButton.removeEventListener("click", handleUndoClick);
    historyButton.removeEventListener("click", handleHistoryToggle);
    sendButton.removeEventListener("click", handleSendClick);
    acceptProposalButton.removeEventListener("click", handleAcceptProposalClick);
    rejectProposalButton.removeEventListener("click", handleRejectProposalClick);
    saveSettingsButton.removeEventListener("click", handleSaveSettingsClick);
    glossarySaveButton.removeEventListener("click", handleSaveGlossaryClick);
    glossaryCancelButton.removeEventListener("click", handleCancelGlossaryClick);
    glossaryUndoButton.removeEventListener("click", handleUndoGlossaryClick);
    glossaryList.removeEventListener("click", handleGlossaryListClick);
    inputAction.destroy();
    tab.destroy();
  };
  const removeTeardownListener = ctx.onTeardown?.(cleanup);
  if (removeTeardownListener) disposers.push(removeTeardownListener);
  return cleanup;
}
function renderGlossary(container, entries) {
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "jt-empty";
    empty.textContent = "No glossary entries yet. Confirmed explicit spelling can add them automatically.";
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "jt-glossary-row";
    const text = document.createElement("p");
    text.textContent = `${entry.canonical}${entry.variants.length ? ` \u2014 heard as: ${entry.variants.join(", ")}` : ""}${entry.hint ? ` \u2014 ${entry.hint}` : ""}`;
    const actions = document.createElement("div");
    actions.className = "jt-actions";
    for (const action of ["edit", "delete"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.glossaryAction = action;
      button.dataset.entryId = entry.id;
      button.textContent = action === "edit" ? "Edit" : "Delete";
      actions.append(button);
    }
    row.append(text, actions);
    container.append(row);
  }
}
function renderParagraphs(container, cleanText) {
  container.replaceChildren();
  if (cleanText.length === 0) {
    const empty = document.createElement("p");
    empty.className = "jt-empty";
    empty.textContent = "Paragraph numbers appear here as you type.";
    container.append(empty);
    return;
  }
  let ordinal = 0;
  for (const line of cleanText.split("\n")) {
    const row = document.createElement("div");
    row.className = "jt-paragraph-row";
    if (line.trim().length === 0) {
      row.classList.add("jt-paragraph-row--separator");
      row.setAttribute("aria-label", "Blank paragraph separator");
      container.append(row);
      continue;
    }
    ordinal += 1;
    const number = document.createElement("span");
    number.className = "jt-paragraph-number";
    number.textContent = String(ordinal);
    number.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "jt-paragraph-text";
    text.textContent = line;
    row.append(number, text);
    container.append(row);
  }
}
function renderDiff(snapshot, panel, paragraphs, removed, added) {
  const diff = snapshot?.latestDiff;
  panel.hidden = !diff;
  if (!diff) return;
  paragraphs.textContent = diff.affectedParagraphOrdinals.length ? `Affected paragraph${diff.affectedParagraphOrdinals.length === 1 ? "" : "s"}: ${diff.affectedParagraphOrdinals.join(", ")}` : "Draft-level change";
  removed.textContent = diff.removed || "\u2205";
  added.textContent = diff.added || "\u2205";
}
function renderHistory(list, snapshot) {
  list.replaceChildren();
  for (const entry of snapshot?.history ?? []) {
    const item = document.createElement("li");
    const kind = entry.kind === "undo" ? "Undo" : entry.kind === "recording-append" ? "Recording appended" : entry.kind === "recording-undo" ? "Recording removed" : "Manual edit";
    const affected = entry.diff.affectedParagraphOrdinals.length ? ` \xB7 paragraph ${entry.diff.affectedParagraphOrdinals.join(", ")}` : "";
    item.textContent = `${kind} \xB7 v${entry.beforeVersion} \u2192 v${entry.afterVersion}${affected}`;
    list.append(item);
  }
}
function joinTranscriptUpdates(finalSegments, interimText) {
  return [...finalSegments, interimText].filter(Boolean).join(" ").trim();
}
function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1e3));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
function describeRecordingError(error) {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") {
    return "Microphone access was denied. No transcript was appended.";
  }
  if (name === "NotFoundError") {
    return "No microphone is available. No transcript was appended.";
  }
  if (name === "NotReadableError") {
    return "The microphone is unavailable or already in use. No transcript was appended.";
  }
  if (name === "AbortError") return "Recording cancelled. No transcript was appended.";
  return "Speech transcription failed. No transcript was appended; you may record again.";
}
function grantLabel(granted, permission) {
  return granted.includes(permission) ? "granted" : "not granted";
}
function draftBackupKey(chatId) {
  return `__jarvistypeDraftBackup:${chatId}`;
}
function saveDraftBackup(chatId, text) {
  try {
    window.sessionStorage.setItem(draftBackupKey(chatId), text);
  } catch {
  }
}
function loadDraftBackup(chatId) {
  try {
    const text = window.sessionStorage.getItem(draftBackupKey(chatId));
    return text !== null && text.length <= MAX_DRAFT_CHARACTERS ? text : null;
  } catch {
    return null;
  }
}
function clearDraftBackup(chatId) {
  try {
    window.sessionStorage.removeItem(draftBackupKey(chatId));
  } catch {
  }
}
function shellMarkup() {
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
      .jt-form-grid input { width: 100%; min-width: 0; min-height: 2.3rem; padding: .4rem .55rem; }
      .jt-proposal { display: grid; gap: .55rem; padding: .7rem; border: 1px solid #d69e2e; border-radius: .5rem; }
      .jt-proposal pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; padding: .55rem; background: color-mix(in srgb, currentColor 6%, transparent); }
      .jt-glossary { display: grid; gap: .55rem; }
      .jt-glossary-row { display: grid; gap: .35rem; padding: .55rem; border-radius: .45rem; background: color-mix(in srgb, currentColor 6%, transparent); overflow-wrap: anywhere; }
      .jt-empty { opacity: .65; font-style: italic; }
      [data-state="ready"] { color: #38a169; }
      [data-state="unavailable"] { color: #e53e3e; }
    </style>
    <main class="jt-shell" aria-labelledby="jt-title">
      <header class="jt-shell__header">
        <p class="jt-shell__eyebrow">Phase 4 context and vocabulary \xB7 v${APP_VERSION}</p>
        <h2 id="jt-title">JarvisType</h2>
        <p>Compose privately, review every change, and send only when you confirm.</p>
      </header>

      <section class="jt-shell__card" aria-labelledby="jt-connection-title">
        <h3 id="jt-connection-title">Connection and ownership</h3>
        <div class="jt-shell__status-grid">
          <p>Backend: <strong data-backend-status data-state="connecting">Connecting\u2026</strong></p>
          <p data-host-versions>Host versions pending</p>
          <p data-active-chat>Active chat: none</p>
          <p data-owner-chat>Draft owner: not loaded</p>
          <p data-permission-status>Permissions: checking\u2026</p>
        </div>
        <p class="jt-shell__notice" role="status" aria-live="polite" data-shell-status>Connecting to the JarvisType backend\u2026</p>
        <div class="jt-shell__warning" data-chat-mismatch hidden>
          <p><strong>Different active chat.</strong> This draft stays attached to its original chat and cannot be sent here.</p>
        </div>
        <div class="jt-actions">
          <button type="button" data-retry-backend hidden>Retry backend connection</button>
          <button type="button" data-switch-draft hidden>Open active chat\u2019s draft</button>
        </div>
      </section>

      <section class="jt-shell__card" aria-labelledby="jt-draft-title">
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

        <div class="jt-actions" aria-label="Editing voice controls">
          <button type="button" disabled>Record Edit \xB7 Phase 5</button>
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

      <section class="jt-shell__card" aria-labelledby="jt-context-title">
        <h3 id="jt-context-title">Context and glossary</h3>
        <p class="jt-shell__notice">JarvisType sends the selected recent chat text, current draft tail, and glossary to your configured Lumiverse generation connection only for post-transcription normalization. Lumiverse STT receives no added context. Set recent messages to 0 to exclude chat history.</p>
        <div class="jt-form-grid">
          <label>Recent messages (0\u201320, default 5)<input type="number" min="0" max="20" step="1" value="5" data-context-count></label>
          <label><span><input type="checkbox" checked data-context-enabled> Use bounded context normalization</span></label>
        </div>
        <div class="jt-actions"><button type="button" data-settings-save>Save context settings</button></div>
        <p role="status" aria-live="polite" data-phase4-status>Loading context and glossary settings\u2026</p>

        <h4>Personal glossary</h4>
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
  `;
}
function requireElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`JarvisType shell is missing ${selector}`);
  return element;
}
export {
  setup
};
