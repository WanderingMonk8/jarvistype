// src/domain/draft-session.ts
var DRAFT_SCHEMA_VERSION = 1;
var MAX_DRAFT_CHARACTERS = 1e5;
var MAX_HISTORY_ENTRIES = 200;
function createDraftSession(chatId, now = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    chatId,
    draftVersion: 0,
    cleanText: "",
    paragraphs: [],
    history: [],
    latestDiff: null,
    undoStack: [],
    canUndo: false,
    dirty: false,
    updatedAt: now
  };
}
function applyManualEdit(session, nextText, options) {
  if (options.expectedVersion !== session.draftVersion) {
    return { applied: false, reason: "stale-version", session };
  }
  if (nextText.length > MAX_DRAFT_CHARACTERS) {
    return { applied: false, reason: "too-large", session };
  }
  if (nextText === session.cleanText) {
    return { applied: false, reason: "unchanged", session };
  }
  const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const createId = options.createId ?? defaultId;
  const beforeText = session.cleanText;
  const nextVersion = session.draftVersion + 1;
  const diff = createDiff(beforeText, nextText);
  const previousEntry = session.history.at(-1);
  const mergeWithPrevious = previousEntry?.kind === "manual-edit" && previousEntry.editGroupId === options.editGroupId;
  const history = mergeWithPrevious ? [
    ...session.history.slice(0, -1),
    {
      ...previousEntry,
      afterVersion: nextVersion,
      timestamp: now,
      diff: createDiff(session.undoStack.at(-1) ?? beforeText, nextText)
    }
  ] : [
    ...session.history,
    {
      id: createId(),
      kind: "manual-edit",
      editGroupId: options.editGroupId,
      beforeVersion: session.draftVersion,
      afterVersion: nextVersion,
      timestamp: now,
      diff
    }
  ].slice(-MAX_HISTORY_ENTRIES);
  const undoStack = mergeWithPrevious ? session.undoStack : [...session.undoStack, beforeText].slice(-MAX_HISTORY_ENTRIES);
  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: nextText,
      paragraphs: reconcileParagraphs(session.paragraphs, nextText, createId),
      history,
      latestDiff: diff,
      undoStack,
      canUndo: undoStack.length > 0,
      dirty: nextText.length > 0,
      updatedAt: now
    }
  };
}
function undoLatestDraftMutation(session, expectedVersion, now = (/* @__PURE__ */ new Date()).toISOString(), createId = defaultId) {
  if (expectedVersion !== session.draftVersion) {
    return { applied: false, reason: "stale-version", session };
  }
  const previousText = session.undoStack.at(-1);
  if (previousText === void 0) return { applied: false, reason: "unchanged", session };
  const nextVersion = session.draftVersion + 1;
  const diff = createDiff(session.cleanText, previousText);
  return {
    applied: true,
    session: {
      ...session,
      draftVersion: nextVersion,
      cleanText: previousText,
      paragraphs: reconcileParagraphs(session.paragraphs, previousText, createId),
      history: [
        ...session.history,
        {
          id: createId(),
          kind: "undo",
          beforeVersion: session.draftVersion,
          afterVersion: nextVersion,
          timestamp: now,
          diff
        }
      ].slice(-MAX_HISTORY_ENTRIES),
      latestDiff: diff,
      undoStack: session.undoStack.slice(0, -1),
      canUndo: session.undoStack.length > 1,
      dirty: previousText.length > 0,
      updatedAt: now
    }
  };
}
function clearDraftAfterSend(session, now = (/* @__PURE__ */ new Date()).toISOString()) {
  return createDraftSession(session.chatId, now);
}
function toDraftSnapshot(session) {
  return {
    chatId: session.chatId,
    draftVersion: session.draftVersion,
    cleanText: session.cleanText,
    paragraphs: session.paragraphs,
    history: session.history,
    latestDiff: session.latestDiff,
    canUndo: session.canUndo,
    dirty: session.dirty,
    updatedAt: session.updatedAt
  };
}
function isPersistedDraftSession(value, expectedChatId) {
  if (!isRecord(value)) return false;
  return value.schemaVersion === DRAFT_SCHEMA_VERSION && value.chatId === expectedChatId && isNonNegativeInteger(value.draftVersion) && typeof value.cleanText === "string" && value.cleanText.length <= MAX_DRAFT_CHARACTERS && Array.isArray(value.paragraphs) && value.paragraphs.every(isDraftParagraph) && Array.isArray(value.history) && value.history.length <= MAX_HISTORY_ENTRIES && value.history.every(isHistoryEntry) && (value.latestDiff === null || isDraftDiff(value.latestDiff)) && Array.isArray(value.undoStack) && value.undoStack.length <= MAX_HISTORY_ENTRIES && value.undoStack.every(
    (text) => typeof text === "string" && text.length <= MAX_DRAFT_CHARACTERS
  ) && typeof value.canUndo === "boolean" && value.canUndo === value.undoStack.length > 0 && typeof value.dirty === "boolean" && typeof value.updatedAt === "string";
}
function createDiff(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const beforeStart = paragraphOrdinalAtOffset(before, prefix);
  const afterStart = paragraphOrdinalAtOffset(after, prefix);
  return {
    removed,
    added,
    startOffset: prefix,
    affectedParagraphOrdinals: [...new Set([beforeStart, afterStart].filter(isPositiveInteger))]
  };
}
function reconcileParagraphs(previous, cleanText, createId) {
  const nextLines = cleanText.split("\n");
  const nextTexts = nextLines.filter(isNonEmptyParagraph);
  const matches = longestCommonSubsequenceMatches(
    previous.map((paragraph) => paragraph.text),
    nextTexts
  );
  const ids = new Array(nextTexts.length);
  for (const [previousIndex, nextIndex] of matches) ids[nextIndex] = previous[previousIndex]?.id;
  const anchors = [[-1, -1], ...matches, [previous.length, nextTexts.length]];
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const [previousStart, nextStart] = anchors[anchorIndex];
    const [previousEnd, nextEnd] = anchors[anchorIndex + 1];
    const pairCount = Math.min(previousEnd - previousStart - 1, nextEnd - nextStart - 1);
    for (let offset = 1; offset <= pairCount; offset += 1) {
      ids[nextStart + offset] = previous[previousStart + offset]?.id;
    }
  }
  let paragraphIndex = 0;
  const paragraphs = [];
  for (const [lineIndex, text] of nextLines.entries()) {
    if (!isNonEmptyParagraph(text)) continue;
    paragraphs.push({
      id: ids[paragraphIndex] ?? createId(),
      ordinal: paragraphIndex + 1,
      lineIndex,
      text
    });
    paragraphIndex += 1;
  }
  return paragraphs;
}
function longestCommonSubsequenceMatches(left, right) {
  const table = Array.from(
    { length: left.length + 1 },
    () => new Array(right.length + 1).fill(0)
  );
  for (let leftIndex2 = left.length - 1; leftIndex2 >= 0; leftIndex2 -= 1) {
    for (let rightIndex2 = right.length - 1; rightIndex2 >= 0; rightIndex2 -= 1) {
      table[leftIndex2][rightIndex2] = left[leftIndex2] === right[rightIndex2] ? 1 + table[leftIndex2 + 1][rightIndex2 + 1] : Math.max(table[leftIndex2 + 1][rightIndex2], table[leftIndex2][rightIndex2 + 1]);
    }
  }
  const matches = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      matches.push([leftIndex, rightIndex]);
      leftIndex += 1;
      rightIndex += 1;
    } else if (table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return matches;
}
function paragraphOrdinalAtOffset(text, offset) {
  const lines = text.slice(0, offset).split("\n");
  let ordinal = 0;
  for (const line of lines) if (isNonEmptyParagraph(line)) ordinal += 1;
  return ordinal || (text.length > 0 ? 1 : null);
}
function isDraftParagraph(value) {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && isPositiveInteger(value.ordinal) && isNonNegativeInteger(value.lineIndex) && typeof value.text === "string" && isNonEmptyParagraph(value.text);
}
function isHistoryEntry(value) {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && (value.kind === "manual-edit" || value.kind === "undo") && (value.editGroupId === void 0 || typeof value.editGroupId === "string") && isNonNegativeInteger(value.beforeVersion) && isPositiveInteger(value.afterVersion) && typeof value.timestamp === "string" && isDraftDiff(value.diff);
}
function isDraftDiff(value) {
  if (!isRecord(value)) return false;
  return typeof value.removed === "string" && typeof value.added === "string" && isNonNegativeInteger(value.startOffset) && Array.isArray(value.affectedParagraphOrdinals) && value.affectedParagraphOrdinals.every(isPositiveInteger);
}
function isNonEmptyParagraph(text) {
  return text.trim().length > 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function defaultId() {
  return crypto.randomUUID();
}

// src/protocol/messages.ts
var PROTOCOL_VERSION = 2;
var APP_VERSION = "0.8.0";
var PHASE_TWO_PERMISSIONS = ["media", "chats", "chat_mutation", "generation"];

// src/protocol/validation.ts
function isFrontendRequest(value) {
  if (!hasEnvelope(value)) return false;
  if (value.type === "app.health.request") {
    return isBoundedString(value.clientTimestamp, 1, 128) && (value.activeChatId === null || isIdentifier(value.activeChatId));
  }
  if (value.type === "app.operation.cancel") return isIdentifier(value.targetRequestId);
  if (value.type === "draft.load.request") return isIdentifier(value.chatId);
  if (value.type === "draft.mutate.request") {
    return isIdentifier(value.operationId) && isIdentifier(value.chatId) && isNonNegativeInteger2(value.expectedVersion) && isIdentifier(value.editGroupId) && typeof value.cleanText === "string" && value.cleanText.length <= MAX_DRAFT_CHARACTERS;
  }
  if (value.type === "draft.undo.request" || value.type === "draft.send.request") {
    return isIdentifier(value.operationId) && isIdentifier(value.chatId) && isNonNegativeInteger2(value.expectedVersion);
  }
  return false;
}
function sanitizeGrantedPermissions(granted) {
  return {
    declared: [...PHASE_TWO_PERMISSIONS],
    granted: PHASE_TWO_PERMISSIONS.filter((permission) => granted.includes(permission))
  };
}
function hasEnvelope(value) {
  return isRecord2(value) && value.protocolVersion === PROTOCOL_VERSION && isBoundedString(value.type, 1, 128) && isIdentifier(value.requestId);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function isIdentifier(value) {
  return isBoundedString(value, 1, 256);
}
function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function isNonNegativeInteger2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// src/backend.ts
var activeRequests = /* @__PURE__ */ new Map();
var draftCache = /* @__PURE__ */ new Map();
var draftLocks = /* @__PURE__ */ new Map();
var completedSends = /* @__PURE__ */ new Map();
var MAX_COMPLETED_SENDS = 100;
function send(response, context) {
  spindle.sendToFrontend(response, context.userId, {
    ...context.frontendSessionId ? { frontendSessionId: context.frontendSessionId } : {}
  });
}
spindle.onFrontendMessage((payload, userId, frontendSessionId) => {
  const context = { userId, ...frontendSessionId ? { frontendSessionId } : {} };
  if (!isFrontendRequest(payload)) {
    spindle.log.warn("JarvisType rejected a malformed frontend message");
    return;
  }
  void handleRequest(payload, context);
});
async function handleRequest(request, context) {
  if (request.type === "app.operation.cancel") {
    const target = activeRequests.get(request.targetRequestId);
    const cancellationAccepted = Boolean(target?.cancellable);
    if (target?.cancellable) target.cancelled = true;
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "app.operation.cancelled",
        requestId: request.requestId,
        ok: true,
        targetRequestId: request.targetRequestId,
        cancellationAccepted
      },
      context
    );
    return;
  }
  const activeRequest = {
    cancelled: false,
    cancellable: request.type !== "draft.send.request"
  };
  activeRequests.set(request.requestId, activeRequest);
  try {
    if (request.type === "app.health.request") {
      await handleHealth(request, context, activeRequest);
    } else if (request.type === "draft.load.request") {
      await handleDraftLoad(request, context, activeRequest);
    } else if (request.type === "draft.mutate.request") {
      await handleDraftMutation(request, context, activeRequest);
    } else if (request.type === "draft.undo.request") {
      await handleDraftUndo(request, context, activeRequest);
    } else {
      await handleDraftSend(request, context);
    }
  } catch (error) {
    if (activeRequest.cancelled) return;
    spindle.log.error(`JarvisType request failed: ${describeError(error)}`);
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "app.error",
        requestId: request.requestId,
        ok: false,
        code: "INTERNAL_ERROR",
        message: "JarvisType could not complete the request. The draft was preserved.",
        retryable: true,
        ..."operationId" in request ? { operationId: request.operationId } : {}
      },
      context
    );
  } finally {
    activeRequests.delete(request.requestId);
  }
}
async function handleHealth(request, context, activeRequest) {
  const [backendVersion, frontendVersion, granted] = await Promise.all([
    spindle.version.getBackend(),
    spindle.version.getFrontend(),
    spindle.permissions.getGranted()
  ]);
  if (activeRequest.cancelled) return;
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "app.health.response",
      requestId: request.requestId,
      ok: true,
      backendVersion,
      frontendVersion,
      serverTimestamp: (/* @__PURE__ */ new Date()).toISOString(),
      permissions: sanitizeGrantedPermissions(granted)
    },
    context
  );
}
async function handleDraftLoad(request, context, activeRequest) {
  const session = await withDraftLock(
    context.userId,
    request.chatId,
    () => loadDraft(context.userId, request.chatId)
  );
  if (activeRequest.cancelled) return;
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "draft.snapshot.response",
      requestId: request.requestId,
      ok: true,
      outcome: "loaded",
      snapshot: toDraftSnapshot(session)
    },
    context
  );
}
async function handleDraftMutation(request, context, activeRequest) {
  const result = await withDraftLock(context.userId, request.chatId, async () => {
    const session = await loadDraft(context.userId, request.chatId);
    const mutation = applyManualEdit(session, request.cleanText, {
      expectedVersion: request.expectedVersion,
      editGroupId: request.editGroupId
    });
    if (mutation.applied) await persistDraft(context.userId, mutation.session);
    return mutation;
  });
  if (activeRequest.cancelled) return;
  if (result.reason === "too-large") {
    sendDraftError(
      request,
      context,
      "DRAFT_TOO_LARGE",
      "The draft exceeds the safe size limit.",
      result.session
    );
    return;
  }
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "draft.snapshot.response",
      requestId: request.requestId,
      ok: true,
      outcome: result.applied ? "applied" : result.reason === "stale-version" ? "stale-version" : "unchanged",
      operationId: request.operationId,
      snapshot: toDraftSnapshot(result.session)
    },
    context
  );
}
async function handleDraftUndo(request, context, activeRequest) {
  const result = await withDraftLock(context.userId, request.chatId, async () => {
    const session = await loadDraft(context.userId, request.chatId);
    const mutation = undoLatestDraftMutation(session, request.expectedVersion);
    if (mutation.applied) await persistDraft(context.userId, mutation.session);
    return mutation;
  });
  if (activeRequest.cancelled) return;
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "draft.snapshot.response",
      requestId: request.requestId,
      ok: true,
      outcome: result.applied ? "applied" : result.reason === "stale-version" ? "stale-version" : "unchanged",
      operationId: request.operationId,
      snapshot: toDraftSnapshot(result.session)
    },
    context
  );
}
async function handleDraftSend(request, context) {
  const sendKey = `${context.userId}:${request.operationId}`;
  const completed = completedSends.get(sendKey);
  if (completed) {
    sendSendResponse(request, context, completed);
    return;
  }
  const result = await withDraftLock(context.userId, request.chatId, async () => {
    const alreadyCompleted = completedSends.get(sendKey);
    if (alreadyCompleted) return { completed: alreadyCompleted };
    const session = await loadDraft(context.userId, request.chatId);
    if (session.draftVersion !== request.expectedVersion) {
      return { error: "stale", session };
    }
    if (session.cleanText.trim().length === 0) return { error: "empty", session };
    if (!spindle.permissions.has("chats") || !spindle.permissions.has("chat_mutation") || !spindle.permissions.has("generation")) {
      return { error: "permission", session };
    }
    const activeChat = await spindle.chats.getActive(context.userId);
    if (!activeChat || activeChat.id !== request.chatId) {
      return { error: "chat-mismatch", session };
    }
    try {
      const appendResult = await spindle.chat.appendMessage(
        request.chatId,
        {
          role: "user",
          content: session.cleanText,
          metadata: {
            jarvistype: {
              version: APP_VERSION,
              operation_id: request.operationId,
              draft_version: session.draftVersion
            }
          }
        },
        { triggerGeneration: true }
      );
      if (!appendResult.id) throw new Error("Lumiverse did not confirm a message identifier");
      const cleared = clearDraftAfterSend(session);
      draftCache.set(draftKey(context.userId, request.chatId), cleared);
      await clearPersistedDraft(context.userId, request.chatId, cleared);
      const completed2 = {
        messageIdPresent: true,
        generationIdPresent: Boolean(appendResult.generationId),
        session: cleared
      };
      rememberCompletedSend(sendKey, completed2);
      return { completed: completed2 };
    } catch (error) {
      spindle.log.error(`JarvisType send failed: ${describeError(error)}`);
      return { error: "send", session };
    }
  });
  if ("error" in result && result.session) {
    if (result.error === "stale") {
      sendDraftError(
        request,
        context,
        "INTERNAL_ERROR",
        "The draft changed before sending. Review it and try again.",
        result.session
      );
    } else if (result.error === "empty") {
      sendDraftError(request, context, "DRAFT_EMPTY", "The draft is empty.", result.session);
    } else if (result.error === "permission") {
      sendDraftError(
        request,
        context,
        "PERMISSION_DENIED",
        "Required Lumiverse send permissions are not granted.",
        result.session
      );
    } else if (result.error === "chat-mismatch") {
      sendDraftError(
        request,
        context,
        "CHAT_MISMATCH",
        "The active chat no longer owns this draft. Return to its chat before sending.",
        result.session
      );
    } else {
      sendDraftError(
        request,
        context,
        "SEND_FAILED",
        "Lumiverse did not confirm the send. The draft was preserved for retry.",
        result.session
      );
    }
    return;
  }
  if ("completed" in result && result.completed) {
    sendSendResponse(request, context, result.completed);
  }
}
function sendSendResponse(request, context, completed) {
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "draft.send.response",
      requestId: request.requestId,
      ok: true,
      operationId: request.operationId,
      messageIdPresent: true,
      generationIdPresent: completed.generationIdPresent,
      snapshot: toDraftSnapshot(completed.session)
    },
    context
  );
}
function sendDraftError(request, context, code, message, session) {
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "app.error",
      requestId: request.requestId,
      ok: false,
      code,
      message,
      retryable: code !== "DRAFT_EMPTY",
      operationId: request.operationId,
      snapshot: toDraftSnapshot(session)
    },
    context
  );
}
async function loadDraft(userId, chatId) {
  const key = draftKey(userId, chatId);
  const cached = draftCache.get(key);
  if (cached) return cached;
  const raw = await spindle.userStorage.getJson(draftPath(chatId), {
    fallback: null,
    userId
  });
  const session = isPersistedDraftSession(raw, chatId) ? raw : createDraftSession(chatId);
  draftCache.set(key, session);
  return session;
}
async function persistDraft(userId, session) {
  await spindle.userStorage.setJson(draftPath(session.chatId), session, { userId });
  draftCache.set(draftKey(userId, session.chatId), session);
}
async function clearPersistedDraft(userId, chatId, cleared) {
  try {
    await spindle.userStorage.delete(draftPath(chatId), userId);
  } catch {
    try {
      await spindle.userStorage.setJson(draftPath(chatId), cleared, { userId });
    } catch (error) {
      spindle.log.error(
        `JarvisType sent the draft but could not clear its persisted copy: ${describeError(error)}`
      );
    }
  }
}
async function withDraftLock(userId, chatId, task) {
  const key = draftKey(userId, chatId);
  const previous = draftLocks.get(key) ?? Promise.resolve();
  let release = () => void 0;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  draftLocks.set(key, chain);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (draftLocks.get(key) === chain) draftLocks.delete(key);
  }
}
function rememberCompletedSend(key, completed) {
  completedSends.set(key, completed);
  while (completedSends.size > MAX_COMPLETED_SENDS) {
    const oldest = completedSends.keys().next().value;
    if (typeof oldest !== "string") break;
    completedSends.delete(oldest);
  }
}
function draftKey(userId, chatId) {
  return `${userId}:${chatId}`;
}
function draftPath(chatId) {
  return `draft-${encodeURIComponent(chatId)}.json`;
}
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
spindle.log.info("JarvisType Phase 2 draft service loaded");
