import assert from 'node:assert/strict'

const protocolVersion = 1

async function loadBackend({ capabilityVersion = 0, permissionGranted = false, stt } = {}) {
  const sent = []
  let frontendHandler
  const deletedUploads = []

  globalThis.spindle = {
    host: {
      descriptorVersion: 1,
      lumiverseVersion: 'test',
      extensionInstallationId: 'test-installation',
      capabilities: capabilityVersion ? { 'stt-invocation-v1': capabilityVersion } : {},
    },
    stt,
    permissions: {
      has: (permission) => permission === 'stt' && permissionGranted,
    },
    uploads: {
      delete: async (uploadId) => {
        deletedUploads.push(uploadId)
        return true
      },
    },
    version: {
      getBackend: async () => 'test',
      getFrontend: async () => 'test',
    },
    log: { info() {}, warn() {} },
    onFrontendMessage(handler) {
      frontendHandler = handler
      return () => {}
    },
    sendToFrontend(message, userId) {
      sent.push({ message, userId })
    },
  }

  await import(`../dist/backend.js?test=${Date.now()}-${Math.random()}`)
  assert.equal(typeof frontendHandler, 'function')
  return { frontendHandler, sent, deletedUploads }
}

function request(type, requestId, extra = {}) {
  return { protocolVersion, type, requestId, ...extra }
}

async function waitFor(sent, predicate, timeoutMs = 1_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const match = sent.find(({ message }) => predicate(message))
    if (match) return match.message
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for backend probe message')
}

function proposalApi(transcribeStream) {
  return {
    transcribe: async () => ({ text: 'unused' }),
    transcribeStream,
    getProviders: async () => [{ id: 'provider' }],
    listConnections: async () => [{ id: 'connection' }],
    getConnection: async () => ({ id: 'connection' }),
  }
}

async function testUnsupportedHost() {
  const { frontendHandler, sent } = await loadBackend()
  await frontendHandler(
    request('probe.stt.conformance.capability', 'capability-unsupported'),
    'user-a',
  )
  const result = await waitFor(
    sent,
    (message) => message.type === 'probe.stt.conformance.capability.result',
  )
  assert.equal(result.supported, false)
  assert.equal(result.hostCapabilityVersion, 0)
  assert.deepEqual(result.availableMethods, [])
  assert.deepEqual(result.missingMethods, [
    'transcribe',
    'transcribeStream',
    'getProviders',
    'listConnections',
    'getConnection',
  ])
}

async function testSuccessfulStream() {
  const stt = proposalApi(async function* () {
    yield {
      type: 'started',
      applied_features: ['context_prompt', 'keywords'],
      unsupported_optional_features: [],
    }
    yield { type: 'partial', sequence: 1, segment_id: 'segment-1', revision: 1, text: 'Jarvis' }
    yield {
      type: 'final_segment',
      sequence: 2,
      segment_id: 'segment-1',
      revision: 2,
      text: 'JarvisType uses a Pip-Boy.',
    }
    yield {
      type: 'done',
      result: {
        text: 'JarvisType uses a Pip-Boy.',
        applied_features: ['context_prompt', 'keywords'],
        unsupported_optional_features: [],
      },
    }
  })
  const { frontendHandler, sent, deletedUploads } = await loadBackend({
    capabilityVersion: 1,
    permissionGranted: true,
    stt,
  })

  await frontendHandler(
    request('probe.stt.conformance.run', 'run-success', {
      uploadId: 'upload-success',
      reportedMimeType: 'audio/webm;codecs=opus',
      expectedSize: 128,
    }),
    'user-b',
  )
  const result = await waitFor(
    sent,
    (message) => message.type === 'probe.stt.conformance.result',
  )
  assert.equal(result.ok, true)
  assert.equal(result.partialCount, 1)
  assert.equal(result.finalSegmentCount, 1)
  assert.equal(result.finalText, 'JarvisType uses a Pip-Boy.')
  assert.equal(result.uploadDeleted, true)
  assert.deepEqual(deletedUploads, ['upload-success'])
}

async function testCancellation() {
  const stt = proposalApi(async function* (input) {
    yield { type: 'started', applied_features: [], unsupported_optional_features: [] }
    await new Promise((resolve, reject) => {
      input.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('provider details must not escape')
          error.code = 'STT_ABORTED'
          reject(error)
        },
        { once: true },
      )
    })
  })
  const { frontendHandler, sent, deletedUploads } = await loadBackend({
    capabilityVersion: 1,
    permissionGranted: true,
    stt,
  })

  await frontendHandler(
    request('probe.stt.conformance.run', 'run-cancel', {
      uploadId: 'upload-cancel',
      reportedMimeType: 'audio/webm;codecs=opus',
      expectedSize: 256,
    }),
    'user-c',
  )
  await waitFor(
    sent,
    (message) => message.type === 'probe.stt.conformance.event' && message.eventType === 'started',
  )
  await frontendHandler(
    request('probe.stt.conformance.cancel', 'cancel-request', {
      targetRequestId: 'run-cancel',
    }),
    'user-c',
  )
  const result = await waitFor(
    sent,
    (message) => message.type === 'probe.stt.conformance.result',
  )
  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
  assert.equal(result.errorCode, 'STT_ABORTED')
  assert.equal(result.error, 'STT conformance run was cancelled')
  assert.equal(result.error.includes('provider details'), false)
  assert.equal(result.uploadDeleted, true)
  assert.deepEqual(deletedUploads, ['upload-cancel'])
}

await testUnsupportedHost()
await testSuccessfulStream()
await testCancellation()

delete globalThis.spindle
console.log('Validated proposed STT API conformance probe')
