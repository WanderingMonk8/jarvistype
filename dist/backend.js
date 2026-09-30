// src/shared.ts
var PROTOCOL_VERSION = 1;
var MAX_PROBE_AUDIO_BYTES = 25 * 1024 * 1024;
function isProbeRequest(value) {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (!isBoundedString(value.requestId, 1, 128)) return false;
  if (value.type === "probe.health.request") return true;
  if (value.type === "probe.stt.surface.request") return isSttApiSurface(value.frontend);
  if (value.type === "probe.stt.conformance.capability") return true;
  if (value.type === "probe.stt.conformance.cancel") {
    return isBoundedString(value.targetRequestId, 1, 128);
  }
  if (value.type === "probe.stt.conformance.run") {
    return isBoundedString(value.uploadId, 1, 512) && isBoundedString(value.reportedMimeType, 0, 128) && isSafeProbeSize(value.expectedSize);
  }
  if (value.type === "probe.chat.run") {
    return isBoundedString(value.chatId, 1, 256) && (value.mode === "append-only" || value.mode === "append-and-generate");
  }
  if (value.type !== "probe.upload.verify") return false;
  return isBoundedString(value.uploadId, 1, 512) && typeof value.expectedSize === "number" && Number.isSafeInteger(value.expectedSize) && value.expectedSize >= 0 && value.expectedSize <= MAX_PROBE_AUDIO_BYTES && typeof value.expectedHash === "string" && /^[0-9a-f]{8}$/.test(value.expectedHash) && isBoundedString(value.reportedMimeType, 0, 128);
}
function isSttApiSurface(value) {
  if (!isRecord(value)) return false;
  return isBoundedStringArray(value.relevantRootMembers) && isBoundedStringArray(value.connectionMembers) && isBoundedStringArray(value.providerMembers) && isBoundedStringArray(value.relevantHostCapabilities) && isBoundedStringArray(value.invocationCandidates) && isBoundedStringArray(value.registrationCandidates);
}
function isBoundedStringArray(value) {
  return Array.isArray(value) && value.length <= 64 && value.every((item) => isBoundedString(item, 1, 128));
}
function hashBytes(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function isSafeProbeSize(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PROBE_AUDIO_BYTES;
}

// src/backend.ts
function send(response, userId) {
  spindle.sendToFrontend(response, userId);
}
var activeSttRuns = /* @__PURE__ */ new Map();
var STT_CONFORMANCE_METHODS = [
  "transcribe",
  "transcribeStream",
  "getProviders",
  "listConnections",
  "getConnection"
];
spindle.onFrontendMessage(async (payload, userId) => {
  if (!isProbeRequest(payload)) {
    spindle.log.warn("JarvisType probe rejected a malformed frontend message");
    return;
  }
  if (payload.type === "probe.health.request") {
    try {
      const [backendVersion, frontendVersion] = await Promise.all([
        spindle.version.getBackend(),
        spindle.version.getFrontend()
      ]);
      send(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "probe.health.response",
          requestId: payload.requestId,
          ok: true,
          backendVersion,
          frontendVersion,
          serverTimestamp: (/* @__PURE__ */ new Date()).toISOString()
        },
        userId
      );
    } catch (error) {
      send(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "probe.error",
          requestId: payload.requestId,
          ok: false,
          error: describeError(error)
        },
        userId
      );
    }
    return;
  }
  if (payload.type === "probe.stt.surface.request") {
    const backend = inspectSttSurface(spindle);
    const hasInvocation = payload.frontend.invocationCandidates.length > 0 || backend.invocationCandidates.length > 0;
    const hasRegistration = payload.frontend.registrationCandidates.length > 0 || backend.registrationCandidates.length > 0;
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "probe.stt.surface.response",
        requestId: payload.requestId,
        ok: true,
        frontend: payload.frontend,
        backend,
        conclusion: hasInvocation ? "invocation-api-found" : hasRegistration ? "registration-only" : "no-stt-surface"
      },
      userId
    );
    return;
  }
  if (payload.type === "probe.stt.conformance.capability") {
    const check = inspectProposedSttApi(spindle);
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "probe.stt.conformance.capability.result",
        requestId: payload.requestId,
        ok: true,
        hostCapabilityVersion: check.hostCapabilityVersion,
        permissionGranted: spindle.permissions.has("stt"),
        availableMethods: check.availableMethods,
        missingMethods: check.missingMethods,
        supported: check.supported
      },
      userId
    );
    return;
  }
  if (payload.type === "probe.stt.conformance.cancel") {
    const controller = activeSttRuns.get(sttRunKey(userId, payload.targetRequestId));
    if (controller) {
      controller.abort("Cancelled by the conformance-test user");
    } else {
      send(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "probe.error",
          requestId: payload.requestId,
          ok: false,
          error: "No matching active STT conformance run was found"
        },
        userId
      );
    }
    return;
  }
  if (payload.type === "probe.stt.conformance.run") {
    void runSttConformance(payload, userId);
    return;
  }
  if (payload.type === "probe.chat.run") {
    const chatMutationPermission = spindle.permissions.has("chat_mutation");
    const generationPermission = spindle.permissions.has("generation");
    let messageIdPresent = false;
    let generationIdPresent = false;
    let error;
    try {
      if (!chatMutationPermission) throw new Error("chat_mutation permission is not granted");
      if (payload.mode === "append-and-generate" && !generationPermission) {
        throw new Error("generation permission is not granted");
      }
      const result = await spindle.chat.appendMessage(
        payload.chatId,
        {
          role: "user",
          content: payload.mode === "append-only" ? "[JarvisType Phase 0 test \u2014 append only]" : "[JarvisType Phase 0 test \u2014 append and generate a brief acknowledgement]",
          metadata: {
            jarvistype_probe: true,
            probe_version: "0.5.0",
            mode: payload.mode
          }
        },
        { triggerGeneration: payload.mode === "append-and-generate" }
      );
      messageIdPresent = typeof result.id === "string" && result.id.length > 0;
      generationIdPresent = typeof result.generationId === "string" && result.generationId.length > 0;
    } catch (caught) {
      error = safeChatError(caught);
    }
    const ok = error === void 0 && messageIdPresent && (payload.mode === "append-only" ? !generationIdPresent : generationIdPresent);
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "probe.chat.result",
        requestId: payload.requestId,
        ok,
        mode: payload.mode,
        chatMutationPermission,
        generationPermission,
        messageIdPresent,
        generationIdPresent,
        ...error ? { error } : {}
      },
      userId
    );
    return;
  }
  let deleted = false;
  let actualSize = null;
  let actualHash = null;
  let fileName = null;
  let errorMessage;
  try {
    const uploaded = await spindle.uploads.get(payload.uploadId, userId);
    if (!uploaded) {
      throw new Error("The staged upload was missing, expired, or unavailable to this user");
    }
    actualSize = uploaded.size;
    actualHash = hashBytes(uploaded.data);
    fileName = uploaded.fileName;
  } catch (error) {
    errorMessage = describeError(error);
  } finally {
    try {
      deleted = await spindle.uploads.delete(payload.uploadId, userId);
    } catch (error) {
      spindle.log.warn(`JarvisType probe could not delete staged upload: ${describeError(error)}`);
    }
    const bytesMatched = actualSize === payload.expectedSize && actualHash === payload.expectedHash;
    const ok = deleted && bytesMatched && errorMessage === void 0;
    const resultError = errorMessage ?? (!bytesMatched ? "Staged upload bytes did not match the frontend sample" : !deleted ? "Staged upload verification finished, but explicit deletion was not confirmed" : void 0);
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "probe.upload.result",
        requestId: payload.requestId,
        ok,
        expectedSize: payload.expectedSize,
        actualSize,
        expectedHash: payload.expectedHash,
        actualHash,
        reportedMimeType: payload.reportedMimeType,
        fileName,
        deleted,
        ...resultError ? { error: resultError } : {}
      },
      userId
    );
  }
});
spindle.log.info("JarvisType Phase 0 capability probe loaded");
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function safeChatError(error) {
  const message = describeError(error);
  if (/permission/i.test(message)) return "Required Lumiverse permission was not granted";
  if (/chat/i.test(message) && /(missing|not found|active|ownership)/i.test(message)) {
    return "The selected disposable chat was unavailable";
  }
  return "Lumiverse rejected the chat test";
}
async function runSttConformance(payload, userId) {
  const key = sttRunKey(userId, payload.requestId);
  if (activeSttRuns.has(key)) return;
  const controller = new AbortController();
  activeSttRuns.set(key, controller);
  let connectionCount = 0;
  let providerCount = 0;
  let partialCount = 0;
  let finalSegmentCount = 0;
  let finalText = null;
  let appliedFeatures = [];
  let unsupportedOptionalFeatures = [];
  let uploadDeleted = false;
  let error;
  let errorCode;
  let aborted = false;
  try {
    const check = inspectProposedSttApi(spindle);
    if (!check.supported || !check.api) {
      throw conformanceError("STT_CAPABILITY_UNAVAILABLE", "Host does not implement stt-invocation-v1");
    }
    if (!spindle.permissions.has("stt")) {
      throw conformanceError("PERMISSION_DENIED", "The stt permission has not been granted");
    }
    const [providers, connections] = await Promise.all([
      check.api.getProviders(userId),
      check.api.listConnections(userId)
    ]);
    providerCount = Array.isArray(providers) ? providers.length : 0;
    connectionCount = Array.isArray(connections) ? connections.length : 0;
    const stream = check.api.transcribeStream({
      source: {
        kind: "upload",
        upload_id: payload.uploadId,
        mime_type: payload.reportedMimeType || void 0
      },
      language: "en",
      context_prompt: "JarvisType is a voice-composition extension. This conformance recording mentions JarvisType and Pip-Boy.",
      keywords: ["JarvisType", "Pip-Boy"],
      punctuation: "enabled",
      timeout_ms: 12e4,
      signal: controller.signal
    });
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
      throw conformanceError("STT_INVALID_STREAM", "transcribeStream did not return an async iterable");
    }
    for await (const rawEvent of stream) {
      const event = asRecord(rawEvent);
      const eventType = readString(event, "type");
      if (eventType === "started") {
        appliedFeatures = readStringArray(event, "applied_features");
        unsupportedOptionalFeatures = readStringArray(event, "unsupported_optional_features");
        sendSttEvent(payload.requestId, userId, "started", event);
      } else if (eventType === "partial") {
        partialCount += 1;
        sendSttEvent(payload.requestId, userId, "partial", event);
      } else if (eventType === "final_segment") {
        finalSegmentCount += 1;
        sendSttEvent(payload.requestId, userId, "final_segment", event);
      } else if (eventType === "done") {
        const result = asRecord(event.result);
        finalText = readNullableString(result, "text");
        appliedFeatures = readStringArray(result, "applied_features", appliedFeatures);
        unsupportedOptionalFeatures = readStringArray(
          result,
          "unsupported_optional_features",
          unsupportedOptionalFeatures
        );
      }
    }
    if (finalText === null) {
      throw conformanceError("STT_MISSING_FINAL", "Stream ended without an authoritative final transcript");
    }
  } catch (caught) {
    aborted = controller.signal.aborted || readErrorCode(caught) === "STT_ABORTED";
    errorCode = aborted ? "STT_ABORTED" : readErrorCode(caught);
    error = safeSttErrorMessage(caught, errorCode);
  } finally {
    activeSttRuns.delete(key);
    try {
      uploadDeleted = await spindle.uploads.delete(payload.uploadId, userId);
    } catch (caught) {
      spindle.log.warn(`JarvisType STT conformance upload cleanup failed: ${describeError(caught)}`);
    }
  }
  if (!uploadDeleted && error === void 0) {
    errorCode = "STT_UPLOAD_DELETE_FAILED";
    error = "Transcription finished, but staged-upload deletion was not confirmed";
  }
  const ok = error === void 0 && finalText !== null && uploadDeleted;
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "probe.stt.conformance.result",
      requestId: payload.requestId,
      ok,
      connectionCount,
      providerCount,
      partialCount,
      finalSegmentCount,
      finalText,
      appliedFeatures,
      unsupportedOptionalFeatures,
      uploadDeleted,
      aborted,
      ...errorCode ? { errorCode } : {},
      ...error ? { error } : {}
    },
    userId
  );
}
function inspectProposedSttApi(root) {
  const host = asRecord(readMember(root, "host"));
  const capabilities = asRecord(host.capabilities);
  const rawVersion = capabilities["stt-invocation-v1"];
  const hostCapabilityVersion = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion > 0 ? rawVersion : 0;
  const candidate = readMember(root, "stt");
  const availableMethods = STT_CONFORMANCE_METHODS.filter(
    (method) => typeof readMember(candidate, method) === "function"
  );
  const missingMethods = STT_CONFORMANCE_METHODS.filter(
    (method) => !availableMethods.includes(method)
  );
  const supported = hostCapabilityVersion >= 1 && missingMethods.length === 0;
  return {
    hostCapabilityVersion,
    availableMethods: [...availableMethods],
    missingMethods: [...missingMethods],
    supported,
    api: supported ? candidate : null
  };
}
function sendSttEvent(requestId, userId, eventType, event) {
  send(
    {
      protocolVersion: PROTOCOL_VERSION,
      type: "probe.stt.conformance.event",
      requestId,
      ok: true,
      eventType,
      sequence: readNullableInteger(event, "sequence"),
      segmentId: readNullableString(event, "segment_id"),
      revision: readNullableInteger(event, "revision"),
      text: readNullableString(event, "text"),
      appliedFeatures: readStringArray(event, "applied_features"),
      unsupportedOptionalFeatures: readStringArray(event, "unsupported_optional_features")
    },
    userId
  );
}
function sttRunKey(userId, requestId) {
  return `${userId}:${requestId}`;
}
function conformanceError(code, message) {
  return Object.assign(new Error(message), { code });
}
function readErrorCode(error) {
  const code = readMember(error, "code");
  return typeof code === "string" && code.length <= 128 ? code : "STT_UNKNOWN_ERROR";
}
function safeSttErrorMessage(error, code) {
  if (code === "STT_CAPABILITY_UNAVAILABLE" || code === "PERMISSION_DENIED" || code === "STT_INVALID_STREAM" || code === "STT_MISSING_FINAL") {
    return describeError(error);
  }
  if (code === "STT_ABORTED") return "STT conformance run was cancelled";
  return `STT conformance run failed with ${code}`;
}
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}
function readString(record, key) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
function readNullableString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.length <= 1e5 ? value : null;
}
function readNullableInteger(record, key) {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function readStringArray(record, key, fallback = []) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 64) : fallback;
}
function inspectSttSurface(root) {
  return {
    relevantRootMembers: relevantMembers(root),
    connectionMembers: memberNames(readMember(root, "connections")),
    providerMembers: memberNames(readMember(root, "providers")),
    relevantHostCapabilities: relevantCapabilityNames(readMember(root, "host")),
    invocationCandidates: existingFunctionPaths(root, [
      "transcribe",
      "stt",
      "stt.transcribe",
      "stt.invoke",
      "speechToText",
      "speechToText.transcribe",
      "speech",
      "speech.transcribe",
      "transcription",
      "transcription.transcribe",
      "voice.transcribe",
      "audio.transcribe",
      "media.transcribe",
      "connections.transcribe",
      "providers.invoke",
      "providers.call",
      "providers.execute",
      "providers.transcribe"
    ]),
    registrationCandidates: existingFunctionPaths(root, [
      "registerSttEngine",
      "providers.register",
      "providers.handle"
    ])
  };
}
function relevantMembers(value) {
  return memberNames(value).filter((name) => /(stt|speech|transcri|voice|provider|connection)/i.test(name));
}
function memberNames(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return [];
  const names = /* @__PURE__ */ new Set();
  let cursor = value;
  for (let depth = 0; cursor && depth < 3; depth += 1) {
    try {
      for (const name of Object.getOwnPropertyNames(cursor)) {
        if (name !== "constructor" && name.length <= 128) names.add(name);
      }
      cursor = Object.getPrototypeOf(cursor);
    } catch {
      break;
    }
  }
  return [...names].sort().slice(0, 64);
}
function relevantCapabilityNames(host) {
  const capabilities = readMember(host, "capabilities");
  if (typeof capabilities !== "object" || capabilities === null) return [];
  return Object.keys(capabilities).filter((name) => /(stt|speech|transcri|voice|provider|connection)/i.test(name)).sort().slice(0, 64);
}
function existingFunctionPaths(root, paths) {
  return paths.filter((path) => {
    let value = root;
    for (const segment of path.split(".")) value = readMember(value, segment);
    return typeof value === "function";
  });
}
function readMember(value, name) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return void 0;
  try {
    return value[name];
  } catch {
    return void 0;
  }
}
