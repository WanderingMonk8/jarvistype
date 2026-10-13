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
var PROTOCOL_VERSION = 1;
var APP_VERSION = "0.7.0";
var REQUEST_TIMEOUT_MS = 1e4;
var PHASE_ONE_PERMISSIONS = ["media"];
function createRequestId(prefix = "request") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

// src/protocol/validation.ts
var ERROR_CODES = [
  "MALFORMED_REQUEST",
  "BACKEND_UNAVAILABLE",
  "REQUEST_CANCELLED",
  "INTERNAL_ERROR"
];
function isBackendResponse(value) {
  if (!hasEnvelope(value) || typeof value.ok !== "boolean") return false;
  if (value.type === "app.health.response") {
    return value.ok === true && isBoundedString(value.backendVersion, 1, 128) && isBoundedString(value.frontendVersion, 1, 128) && isBoundedString(value.serverTimestamp, 1, 128) && isPermissionSnapshot(value.permissions);
  }
  if (value.type === "app.operation.cancelled") {
    return value.ok === true && isBoundedString(value.targetRequestId, 1, 128) && typeof value.cancellationAccepted === "boolean";
  }
  if (value.type === "app.error") {
    return value.ok === false && typeof value.code === "string" && ERROR_CODES.includes(value.code) && isBoundedString(value.message, 1, 2e3) && typeof value.retryable === "boolean";
  }
  return false;
}
function sanitizeGrantedPermissions(granted) {
  return {
    declared: [...PHASE_ONE_PERMISSIONS],
    granted: PHASE_ONE_PERMISSIONS.filter((permission) => granted.includes(permission))
  };
}
function hasEnvelope(value) {
  return isRecord(value) && value.protocolVersion === PROTOCOL_VERSION && isBoundedString(value.type, 1, 128) && isBoundedString(value.requestId, 1, 128);
}
function isPermissionSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.declared) || !Array.isArray(value.granted)) {
    return false;
  }
  return value.declared.length === PHASE_ONE_PERMISSIONS.length && value.declared.every((permission) => PHASE_ONE_PERMISSIONS.includes(permission)) && value.granted.length <= PHASE_ONE_PERMISSIONS.length && value.granted.every((permission) => PHASE_ONE_PERMISSIONS.includes(permission)) && new Set(value.granted).size === value.granted.length;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

// src/frontend.ts
function setup(ctx) {
  ctx.deferReady();
  const tab = ctx.ui.registerDrawerTab({
    id: "jarvistype-composer",
    title: "JarvisType",
    shortName: "Jarvis",
    description: "Compose and revise a message by voice before sending it.",
    keywords: ["voice", "dictation", "draft", "speech"]
  });
  const inputAction = ctx.ui.registerInputBarAction({
    id: "jarvistype-open",
    label: "JarvisType",
    subtitle: "Open voice composition draft"
  });
  tab.root.innerHTML = shellMarkup();
  const backendStatus = requireElement(tab.root, "[data-backend-status]");
  const hostVersions = requireElement(tab.root, "[data-host-versions]");
  const chatStatus = requireElement(tab.root, "[data-chat-status]");
  const permissionStatus = requireElement(tab.root, "[data-permission-status]");
  const shellStatus = requireElement(tab.root, "[data-shell-status]");
  const retryButton = requireElement(tab.root, "[data-retry-backend]");
  const initialChat = ctx.getActiveChat();
  const state = {
    activeChatId: initialChat.chatId,
    backendState: "connecting",
    backendVersion: null,
    frontendVersion: null,
    permissions: { declared: ["media"], granted: [] },
    statusMessage: "Connecting to the JarvisType backend\u2026"
  };
  let alive = true;
  let currentHealthRequestId = null;
  const disposers = [];
  const registry = new RequestRegistry(REQUEST_TIMEOUT_MS, (requestId) => {
    if (!alive) return;
    send({
      protocolVersion: PROTOCOL_VERSION,
      type: "app.operation.cancel",
      requestId: createRequestId("cancel"),
      targetRequestId: requestId
    });
  });
  const render = () => {
    backendStatus.textContent = state.backendState === "ready" ? "Ready" : state.backendState === "connecting" ? "Connecting\u2026" : "Unavailable";
    backendStatus.dataset.state = state.backendState;
    hostVersions.textContent = state.backendVersion && state.frontendVersion ? `Lumiverse backend ${state.backendVersion} \xB7 frontend ${state.frontendVersion}` : "Host versions pending";
    chatStatus.textContent = state.activeChatId ? `Active chat: ${state.activeChatId}` : "No active chat selected";
    permissionStatus.textContent = state.permissions.granted.includes("media") ? "Media permission: granted" : "Media permission: not granted";
    shellStatus.textContent = state.statusMessage;
    retryButton.hidden = state.backendState !== "unavailable";
  };
  const send = (request) => {
    if (alive) ctx.sendToBackend(request);
  };
  const refreshLocalState = async () => {
    const activeChat = ctx.getActiveChat();
    state.activeChatId = activeChat.chatId;
    try {
      state.permissions = sanitizeGrantedPermissions(await ctx.permissions.getGranted());
    } catch {
      state.statusMessage = "Permission status is temporarily unavailable.";
    }
    if (alive) render();
  };
  const checkBackend = async () => {
    if (!alive) return;
    if (currentHealthRequestId) registry.cancel(currentHealthRequestId);
    const requestId = createRequestId("health");
    currentHealthRequestId = requestId;
    state.backendState = "connecting";
    state.statusMessage = "Connecting to the JarvisType backend\u2026";
    render();
    const outcomePromise = registry.wait(requestId);
    send({
      protocolVersion: PROTOCOL_VERSION,
      type: "app.health.request",
      requestId,
      clientTimestamp: (/* @__PURE__ */ new Date()).toISOString(),
      activeChatId: state.activeChatId
    });
    const outcome = await outcomePromise;
    if (!alive || currentHealthRequestId !== requestId) return;
    currentHealthRequestId = null;
    if (outcome.status === "resolved" && outcome.value.type === "app.health.response") {
      state.backendState = "ready";
      state.backendVersion = outcome.value.backendVersion;
      state.frontendVersion = outcome.value.frontendVersion;
      state.permissions = outcome.value.permissions;
      state.statusMessage = "Foundation ready. Drafting features unlock in the next phases.";
    } else if (outcome.status === "resolved" && outcome.value.type === "app.error") {
      state.backendState = "unavailable";
      state.statusMessage = outcome.value.message;
    } else if (outcome.status === "timed-out") {
      state.backendState = "unavailable";
      state.statusMessage = "The backend did not respond. Your future draft will remain local and recoverable.";
    }
    render();
  };
  const removeBackendListener = ctx.onBackendMessage((payload) => {
    if (!alive || !isBackendResponse(payload)) return;
    registry.resolve(payload.requestId, payload);
  });
  disposers.push(removeBackendListener);
  const refreshFromHost = () => void refreshLocalState();
  disposers.push(ctx.events.on("PERMISSION_CHANGED", refreshFromHost));
  disposers.push(ctx.events.on("CHAT_SWITCHED", refreshFromHost));
  disposers.push(tab.onActivate(refreshFromHost));
  disposers.push(inputAction.onClick(() => tab.activate()));
  const handleVisibility = () => {
    if (document.visibilityState === "visible") void refreshLocalState();
  };
  const handleFocus = () => void refreshLocalState();
  const handleRetry = () => void checkBackend();
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("focus", handleFocus);
  retryButton.addEventListener("click", handleRetry);
  render();
  void refreshLocalState();
  void checkBackend();
  ctx.ready();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    alive = false;
    registry.cancelAll();
    for (const dispose of disposers.splice(0)) dispose();
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("focus", handleFocus);
    retryButton.removeEventListener("click", handleRetry);
    inputAction.destroy();
    tab.destroy();
  };
  const removeTeardownListener = ctx.onTeardown?.(cleanup);
  if (removeTeardownListener) disposers.push(removeTeardownListener);
  return cleanup;
}
function shellMarkup() {
  return `
    <style>
      .jt-shell { box-sizing: border-box; display: grid; gap: 1rem; padding: 1rem; min-width: 0; }
      .jt-shell *, .jt-shell *::before, .jt-shell *::after { box-sizing: border-box; }
      .jt-shell h2, .jt-shell h3, .jt-shell p { margin: 0; }
      .jt-shell__header { display: grid; gap: .35rem; }
      .jt-shell__eyebrow { font-size: .78rem; opacity: .72; text-transform: uppercase; letter-spacing: .08em; }
      .jt-shell__card { display: grid; gap: .7rem; padding: .85rem; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: .75rem; min-width: 0; }
      .jt-shell__status-grid { display: grid; gap: .45rem; font-size: .9rem; overflow-wrap: anywhere; }
      .jt-shell__draft { min-height: 9rem; width: 100%; resize: vertical; border-radius: .5rem; padding: .75rem; }
      .jt-shell__actions { display: flex; flex-wrap: wrap; gap: .5rem; }
      .jt-shell button { min-height: 2.35rem; }
      .jt-shell button:disabled { cursor: not-allowed; opacity: .55; }
      .jt-shell__notice { padding: .7rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 8%, transparent); }
      [data-state="ready"] { color: #38a169; }
      [data-state="unavailable"] { color: #e53e3e; }
    </style>
    <main class="jt-shell" aria-labelledby="jt-title">
      <header class="jt-shell__header">
        <p class="jt-shell__eyebrow">Phase 1 foundation \xB7 v${APP_VERSION}</p>
        <h2 id="jt-title">JarvisType</h2>
        <p>Compose privately, review every change, and send only when you confirm.</p>
      </header>

      <section class="jt-shell__card" aria-labelledby="jt-status-title">
        <h3 id="jt-status-title">Connection</h3>
        <div class="jt-shell__status-grid">
          <p>Backend: <strong data-backend-status data-state="connecting">Connecting\u2026</strong></p>
          <p data-host-versions>Host versions pending</p>
          <p data-chat-status>No active chat selected</p>
          <p data-permission-status>Media permission: checking\u2026</p>
        </div>
        <p class="jt-shell__notice" role="status" aria-live="polite" data-shell-status>Connecting to the JarvisType backend\u2026</p>
        <div><button type="button" data-retry-backend hidden>Retry backend connection</button></div>
      </section>

      <section class="jt-shell__card" aria-labelledby="jt-draft-title">
        <h3 id="jt-draft-title">Working draft</h3>
        <textarea class="jt-shell__draft" aria-label="JarvisType working draft placeholder" placeholder="The numbered draft editor arrives in Phase 2." disabled></textarea>
        <div class="jt-shell__actions" aria-label="Voice composition controls">
          <button type="button" disabled>Record Message</button>
          <button type="button" disabled>Record Edit</button>
          <button type="button" disabled>Undo</button>
          <button type="button" disabled>History</button>
        </div>
        <div class="jt-shell__actions">
          <button type="button" disabled>Confirm &amp; Send</button>
        </div>
        <p>Controls are intentionally disabled until their implementation phases satisfy the PRD safety gates.</p>
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
