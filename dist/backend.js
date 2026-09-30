// src/shared.ts
var PROTOCOL_VERSION = 1;
var MAX_PROBE_AUDIO_BYTES = 25 * 1024 * 1024;
function isProbeRequest(value) {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (!isBoundedString(value.requestId, 1, 128)) return false;
  if (value.type === "probe.health.request") return true;
  if (value.type === "probe.stt.surface.request") return isSttApiSurface(value.frontend);
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

// src/backend.ts
function send(response, userId) {
  spindle.sendToFrontend(response, userId);
}
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
