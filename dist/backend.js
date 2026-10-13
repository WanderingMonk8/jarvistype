// src/protocol/messages.ts
var PROTOCOL_VERSION = 1;
var PHASE_ONE_PERMISSIONS = ["media"];

// src/protocol/validation.ts
function isFrontendRequest(value) {
  if (!hasEnvelope(value)) return false;
  if (value.type === "app.health.request") {
    return isBoundedString(value.clientTimestamp, 1, 128) && (value.activeChatId === null || isBoundedString(value.activeChatId, 1, 256));
  }
  if (value.type === "app.operation.cancel") {
    return isBoundedString(value.targetRequestId, 1, 128);
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
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

// src/backend.ts
var activeRequests = /* @__PURE__ */ new Map();
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
    if (target) target.cancelled = true;
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "app.operation.cancelled",
        requestId: request.requestId,
        ok: true,
        targetRequestId: request.targetRequestId,
        cancellationAccepted: target !== void 0
      },
      context
    );
    return;
  }
  const activeRequest = { cancelled: false };
  activeRequests.set(request.requestId, activeRequest);
  try {
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
  } catch (error) {
    if (activeRequest.cancelled) return;
    spindle.log.error(`JarvisType health request failed: ${describeError(error)}`);
    send(
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "app.error",
        requestId: request.requestId,
        ok: false,
        code: "INTERNAL_ERROR",
        message: "JarvisType could not initialize its backend connection.",
        retryable: true
      },
      context
    );
  } finally {
    activeRequests.delete(request.requestId);
  }
}
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
spindle.log.info("JarvisType Phase 1 foundation loaded");
