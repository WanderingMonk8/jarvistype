import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import * as tus from 'tus-js-client'
import {
  AUDIO_MIME_CANDIDATES,
  MAX_PROBE_AUDIO_BYTES,
  PROBE_VERSION,
  PROTOCOL_VERSION,
  hashBytes,
  isProbeResponse,
  type ProbeRequest,
} from './shared'

const MAX_RECORDING_MS = 60_000
const CLEANUP_STORAGE_KEY = 'jarvistype.phase0.cleanup.v1'
const MAX_CLEANUP_RECEIPTS = 4
const LIFECYCLE_UPLOAD_BYTES = 2 * 1024 * 1024
const LIFECYCLE_UPLOAD_CHUNK_BYTES = 64 * 1024
const LIFECYCLE_UPLOAD_DELAY_MS = 400

interface CleanupReceipt {
  at: string
  trigger: 'pagehide' | 'extension-teardown'
  recordingWasActive: boolean
  uploadWasActive: boolean
  tracksStopped: boolean
  uploadAbortRequested: boolean
  passed: boolean
}

interface UiSelfCheck {
  at: string
  widthPx: number
  scrollWidthPx: number
  horizontalOverflow: boolean
  enabledControlCount: number
  unnamedControlCount: number
  negativeTabIndexCount: number
  passed: boolean
}

interface ProbeEvent {
  at: string
  level: 'info' | 'pass' | 'fail'
  message: string
  details?: Record<string, unknown>
}

interface ProbeReport {
  probeVersion: string
  exportedAt: string
  page: {
    secureContext: boolean
    origin: string
    userAgent: string
  }
  lifecycle: {
    deferReadyAvailable: boolean
    readyAvailable: boolean
    activeSetupInstances: number
    drawerActivationCount: number
    inputActionActivationCount: number
    cleanupReceipts: CleanupReceipt[]
  }
  ui?: UiSelfCheck
  media: {
    mediaDevicesAvailable: boolean
    mediaRecorderAvailable: boolean
    supportedMimeTypes: string[]
    selectedMimeType: string | null
    lastRecording?: {
      requestedMimeType: string | null
      actualMimeType: string
      durationMs: number
      sizeBytes: number
      hash: string
      tracksStopped: boolean
    }
  }
  lumiverse?: {
    backendVersion: string
    frontendVersion: string
    serverTimestamp: string
  }
  upload?: {
    expectedSize: number
    actualSize: number | null
    expectedHash: string
    actualHash: string | null
    deleted: boolean
    passed: boolean
    error?: string
  }
  events: ProbeEvent[]
}

type LifecycleContext = SpindleFrontendContext & {
  deferReady?: () => void
  ready?: () => void
}

export function setup(ctx: SpindleFrontendContext): () => void {
  const lifecycle = ctx as LifecycleContext
  lifecycle.deferReady?.()
  const activeSetupInstances = changeActiveInstanceCount(1)
  const cleanupReceipts = loadCleanupReceipts()

  const supportedMimeTypes =
    typeof MediaRecorder === 'undefined'
      ? []
      : AUDIO_MIME_CANDIDATES.filter((mimeType) => MediaRecorder.isTypeSupported(mimeType))
  const selectedMimeType = supportedMimeTypes[0] ?? null
  const events: ProbeEvent[] = []
  const report: ProbeReport = {
    probeVersion: PROBE_VERSION,
    exportedAt: new Date().toISOString(),
    page: {
      secureContext: window.isSecureContext,
      origin: window.location.origin,
      userAgent: navigator.userAgent,
    },
    lifecycle: {
      deferReadyAvailable: typeof lifecycle.deferReady === 'function',
      readyAvailable: typeof lifecycle.ready === 'function',
      activeSetupInstances,
      drawerActivationCount: 0,
      inputActionActivationCount: 0,
      cleanupReceipts,
    },
    media: {
      mediaDevicesAvailable: Boolean(navigator.mediaDevices?.getUserMedia),
      mediaRecorderAvailable: typeof MediaRecorder !== 'undefined',
      supportedMimeTypes,
      selectedMimeType,
    },
    events,
  }

  const tab = ctx.ui.registerDrawerTab({
    id: 'jarvistype-phase0-probe',
    title: 'JarvisType Phase 0 Probe',
    shortName: 'Jarvis',
    headerTitle: 'JarvisType Probe',
    description: 'Test JarvisType microphone, messaging, and staged-upload capabilities.',
    keywords: ['jarvistype', 'voice', 'microphone', 'probe', 'phase 0'],
    iconSvg:
      '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M10 12.5a3.5 3.5 0 0 0 3.5-3.5V5a3.5 3.5 0 1 0-7 0v4a3.5 3.5 0 0 0 3.5 3.5Zm-5-4a1 1 0 0 1 1 1 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V17h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-1.59A6 6 0 0 1 4 9.5a1 1 0 0 1 1-1Z"/></svg>',
  })

  const inputAction = ctx.ui.registerInputBarAction({
    id: 'jarvistype-open-phase0-probe',
    label: 'JarvisType Probe',
    subtitle: 'Test microphone and upload support',
    iconSvg:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 10a3 3 0 0 0 3-3V4a3 3 0 0 0-6 0v3a3 3 0 0 0 3 3Zm-5-3a1 1 0 0 1 2 0 3 3 0 1 0 6 0 1 1 0 1 1 2 0 5 5 0 0 1-4 4.9V14h1.5a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2H7v-2.1A5 5 0 0 1 3 7Z"/></svg>',
  })

  tab.root.innerHTML = `
    <style>
      .jt-probe { box-sizing: border-box; container-type: inline-size; display: grid; gap: 16px; padding: 16px; max-width: 900px; min-width: 0; width: 100%; }
      .jt-probe * { box-sizing: border-box; }
      .jt-probe h2, .jt-probe h3, .jt-probe p { margin: 0; }
      .jt-probe-card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 10px; padding: 14px; display: grid; gap: 10px; min-width: 0; }
      .jt-probe-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
      .jt-probe button { min-height: 36px; padding: 7px 12px; cursor: pointer; }
      .jt-probe button:disabled { cursor: not-allowed; opacity: 0.55; }
      .jt-probe-status { font-weight: 600; }
      .jt-probe-grid { display: grid; grid-template-columns: minmax(150px, auto) minmax(0, 1fr); gap: 6px 12px; min-width: 0; }
      .jt-probe-grid dt { font-weight: 600; }
      .jt-probe-grid dd { margin: 0; overflow-wrap: anywhere; }
      .jt-probe-log { margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .jt-probe-note { opacity: 0.8; font-size: 0.92em; }
      @container (max-width: 420px) {
        .jt-probe-grid { grid-template-columns: minmax(0, 1fr); }
        .jt-probe-grid dd { margin-bottom: 6px; }
        .jt-probe-actions button { flex: 1 1 100%; width: 100%; }
      }
    </style>
    <section class="jt-probe" aria-labelledby="jt-probe-title">
      <div>
        <h2 id="jt-probe-title">JarvisType Phase 0 Capability Probe</h2>
        <p class="jt-probe-note">This probe requests no gated Lumiverse permissions, sends no chat messages, and deletes each completed staged upload after verification.</p>
      </div>
      <section class="jt-probe-card" aria-labelledby="jt-host-title">
        <h3 id="jt-host-title">Host and lifecycle</h3>
        <dl class="jt-probe-grid" data-host-facts></dl>
        <div class="jt-probe-actions">
          <button type="button" data-refresh-host>Refresh host check</button>
          <button type="button" data-lifecycle-upload>Start paced teardown upload</button>
          <button type="button" data-ui-check>Run UI self-check</button>
        </div>
        <p class="jt-probe-status" role="status" aria-live="polite" data-lifecycle-status>Use the paced upload immediately before reloading or disabling the extension.</p>
      </section>
      <section class="jt-probe-card" aria-labelledby="jt-media-title">
        <h3 id="jt-media-title">Microphone recording</h3>
        <dl class="jt-probe-grid" data-media-facts></dl>
        <div class="jt-probe-actions">
          <button type="button" data-start-recording>Start recording</button>
          <button type="button" data-stop-recording disabled>Stop and keep sample</button>
          <button type="button" data-cancel-recording disabled>Cancel recording</button>
        </div>
        <p class="jt-probe-status" role="status" aria-live="polite" data-recording-status>Idle</p>
      </section>
      <section class="jt-probe-card" aria-labelledby="jt-upload-title">
        <h3 id="jt-upload-title">Staged upload round trip</h3>
        <div class="jt-probe-actions">
          <button type="button" data-upload disabled>Upload and verify sample</button>
          <button type="button" data-cancel-upload disabled>Cancel upload</button>
        </div>
        <p class="jt-probe-status" role="status" aria-live="polite" data-upload-status>Record a sample first.</p>
      </section>
      <section class="jt-probe-card" aria-labelledby="jt-results-title">
        <h3 id="jt-results-title">Sanitized results</h3>
        <div class="jt-probe-actions">
          <button type="button" data-copy-results>Copy JSON</button>
          <button type="button" data-download-results>Download JSON</button>
        </div>
        <pre class="jt-probe-log" tabindex="0" aria-label="Sanitized probe results" data-results-log></pre>
      </section>
    </section>
  `

  const hostFacts = requireElement<HTMLElement>(tab.root, '[data-host-facts]')
  const mediaFacts = requireElement<HTMLElement>(tab.root, '[data-media-facts]')
  const lifecycleStatus = requireElement<HTMLElement>(tab.root, '[data-lifecycle-status]')
  const recordingStatus = requireElement<HTMLElement>(tab.root, '[data-recording-status]')
  const uploadStatus = requireElement<HTMLElement>(tab.root, '[data-upload-status]')
  const resultsLog = requireElement<HTMLElement>(tab.root, '[data-results-log]')
  const refreshHostButton = requireElement<HTMLButtonElement>(tab.root, '[data-refresh-host]')
  const lifecycleUploadButton = requireElement<HTMLButtonElement>(tab.root, '[data-lifecycle-upload]')
  const uiCheckButton = requireElement<HTMLButtonElement>(tab.root, '[data-ui-check]')
  const startButton = requireElement<HTMLButtonElement>(tab.root, '[data-start-recording]')
  const stopButton = requireElement<HTMLButtonElement>(tab.root, '[data-stop-recording]')
  const cancelRecordingButton = requireElement<HTMLButtonElement>(tab.root, '[data-cancel-recording]')
  const uploadButton = requireElement<HTMLButtonElement>(tab.root, '[data-upload]')
  const cancelUploadButton = requireElement<HTMLButtonElement>(tab.root, '[data-cancel-upload]')
  const copyButton = requireElement<HTMLButtonElement>(tab.root, '[data-copy-results]')
  const downloadButton = requireElement<HTMLButtonElement>(tab.root, '[data-download-results]')

  let disposed = false
  let activeRecorder: MediaRecorder | null = null
  let activeStream: MediaStream | null = null
  let recordingStartedAt = 0
  let keepRecording = false
  let recordingTimer: number | null = null
  let recordedBlob: Blob | null = null
  let activeUpload: tus.Upload | null = null
  let uploadResultTarget: 'recording' | 'lifecycle' | null = null
  let activeUploadRequestId: string | null = null
  let healthRequestId: string | null = null
  let cleanupPerformed = false

  const addEvent = (
    level: ProbeEvent['level'],
    message: string,
    details?: Record<string, unknown>,
  ) => {
    events.push({ at: new Date().toISOString(), level, message, ...(details ? { details } : {}) })
    render()
  }

  const render = () => {
    hostFacts.innerHTML = factsHtml([
      ['Secure context', yesNo(report.page.secureContext)],
      ['Origin', report.page.origin],
      ['deferReady()', yesNo(report.lifecycle.deferReadyAvailable)],
      ['ready()', yesNo(report.lifecycle.readyAvailable)],
      ['Active probe instances', String(report.lifecycle.activeSetupInstances)],
      ['Drawer activations', String(report.lifecycle.drawerActivationCount)],
      ['Input-action activations', String(report.lifecycle.inputActionActivationCount)],
      ['Saved cleanup receipts', String(report.lifecycle.cleanupReceipts.length)],
      ['Backend version', report.lumiverse?.backendVersion ?? 'Pending'],
      ['Frontend version', report.lumiverse?.frontendVersion ?? 'Pending'],
    ])
    mediaFacts.innerHTML = factsHtml([
      ['getUserMedia()', yesNo(report.media.mediaDevicesAvailable)],
      ['MediaRecorder', yesNo(report.media.mediaRecorderAvailable)],
      ['Selected MIME', report.media.selectedMimeType ?? 'Browser default'],
      ['Supported candidates', report.media.supportedMimeTypes.join(', ') || 'None detected'],
      ['Last sample', report.media.lastRecording ? `${report.media.lastRecording.sizeBytes} bytes / ${report.media.lastRecording.durationMs} ms` : 'None'],
      ['Tracks stopped', report.media.lastRecording ? yesNo(report.media.lastRecording.tracksStopped) : 'Not tested'],
    ])
    report.exportedAt = new Date().toISOString()
    resultsLog.textContent = JSON.stringify(report, null, 2)
  }

  const requestHealth = () => {
    healthRequestId = makeRequestId()
    const request: ProbeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'probe.health.request',
      requestId: healthRequestId,
    }
    ctx.sendToBackend(request)
    addEvent('info', 'Sent frontend/backend health request')
  }

  const unsubscribeBackend = ctx.onBackendMessage((payload: unknown) => {
    if (!isProbeResponse(payload)) return

    if (payload.type === 'probe.health.response' && payload.requestId === healthRequestId) {
      report.lumiverse = {
        backendVersion: payload.backendVersion,
        frontendVersion: payload.frontendVersion,
        serverTimestamp: payload.serverTimestamp,
      }
      addEvent('pass', 'Frontend/backend health and version check passed')
      return
    }

    if (payload.type === 'probe.upload.result' && payload.requestId === activeUploadRequestId) {
      report.upload = {
        expectedSize: payload.expectedSize,
        actualSize: payload.actualSize,
        expectedHash: payload.expectedHash,
        actualHash: payload.actualHash,
        deleted: payload.deleted,
        passed: payload.ok,
        ...(payload.error ? { error: payload.error } : {}),
      }
      if (payload.deleted) {
        const resultTarget = uploadResultTarget
        activeUploadRequestId = null
        uploadResultTarget = null
        const resultStatus = resultTarget === 'lifecycle' ? lifecycleStatus : uploadStatus
        resultStatus.textContent = payload.ok
          ? 'Passed: bytes matched and staged upload deletion was confirmed.'
          : `Failed: ${payload.error ?? 'byte verification did not match.'}`
        uploadButton.disabled = recordedBlob === null
        lifecycleUploadButton.disabled = false
        addEvent(payload.ok ? 'pass' : 'fail', 'Staged upload verification finished', {
          target: resultTarget ?? 'unknown',
          bytesMatched:
            payload.expectedSize === payload.actualSize && payload.expectedHash === payload.actualHash,
          deleted: payload.deleted,
        })
      } else {
        const resultStatus =
          uploadResultTarget === 'lifecycle' ? lifecycleStatus : uploadStatus
        resultStatus.textContent = 'Backend verified the staged bytes; awaiting deletion confirmation.'
      }
      render()
      return
    }

    if (payload.type === 'probe.error') {
      addEvent('fail', 'Backend probe error', { error: payload.error })
    }
  })

  const stopTracks = (): boolean => {
    if (!activeStream) return true
    for (const track of activeStream.getTracks()) track.stop()
    const stopped = activeStream.getTracks().every((track) => track.readyState === 'ended')
    activeStream = null
    return stopped
  }

  const clearRecordingTimer = () => {
    if (recordingTimer !== null) window.clearTimeout(recordingTimer)
    recordingTimer = null
  }

  const finishRecording = async (blob: Blob, durationMs: number, tracksStopped: boolean) => {
    if (!keepRecording || disposed) {
      recordedBlob = null
      uploadButton.disabled = true
      recordingStatus.textContent = 'Recording cancelled; no sample retained.'
      addEvent('pass', 'Recording cancelled and media tracks stopped', { tracksStopped })
      return
    }

    const bytes = new Uint8Array(await blob.arrayBuffer())
    recordedBlob = blob
    report.media.lastRecording = {
      requestedMimeType: selectedMimeType,
      actualMimeType: blob.type || activeRecorder?.mimeType || 'unknown',
      durationMs,
      sizeBytes: blob.size,
      hash: hashBytes(bytes),
      tracksStopped,
    }
    const passed = blob.size > 0 && tracksStopped
    recordingStatus.textContent = passed
      ? `Sample ready: ${blob.size} bytes. You can now test staged upload.`
      : 'Recording failed: the sample was empty or media tracks did not stop.'
    uploadStatus.textContent = passed ? 'Sample ready for upload.' : 'A valid sample is required.'
    uploadButton.disabled = !passed
    addEvent(passed ? 'pass' : 'fail', 'Microphone recording finished', {
      sizeBytes: blob.size,
      durationMs,
      mimeType: report.media.lastRecording.actualMimeType,
      tracksStopped,
    })
  }

  const startRecording = async () => {
    if (activeRecorder || activeStream) return
    startButton.disabled = true
    recordingStatus.textContent = 'Requesting microphone permission…'
    addEvent('info', 'Requested microphone access')

    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (disposed) {
        stopTracks()
        return
      }

      const options = selectedMimeType ? { mimeType: selectedMimeType } : undefined
      const recorder = new MediaRecorder(activeStream, options)
      activeRecorder = recorder
      const chunks: BlobPart[] = []
      keepRecording = true
      recordingStartedAt = performance.now()

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      })
      recorder.addEventListener('error', (event) => {
        addEvent('fail', 'MediaRecorder emitted an error', {
          error: 'error' in event && event.error instanceof Error ? event.error.message : 'Unknown recorder error',
        })
      })
      recorder.addEventListener(
        'stop',
        () => {
          clearRecordingTimer()
          const durationMs = Math.round(performance.now() - recordingStartedAt)
          const tracksStopped = stopTracks()
          const blob = new Blob(chunks, { type: recorder.mimeType || selectedMimeType || '' })
          activeRecorder = null
          startButton.disabled = false
          stopButton.disabled = true
          cancelRecordingButton.disabled = true
          void finishRecording(blob, durationMs, tracksStopped)
        },
        { once: true },
      )

      recorder.start(250)
      stopButton.disabled = false
      cancelRecordingButton.disabled = false
      recordingStatus.textContent = 'Recording… Speak briefly, then select “Stop and keep sample”.'
      recordingTimer = window.setTimeout(() => {
        if (activeRecorder?.state === 'recording') {
          recordingStatus.textContent = 'Maximum probe duration reached; stopping recording.'
          activeRecorder.stop()
        }
      }, MAX_RECORDING_MS)
    } catch (error) {
      const tracksStopped = stopTracks()
      activeRecorder = null
      startButton.disabled = false
      stopButton.disabled = true
      cancelRecordingButton.disabled = true
      recordingStatus.textContent = `Microphone unavailable: ${describeError(error)}`
      addEvent('fail', 'Microphone request or recorder setup failed', {
        error: describeError(error),
        tracksStopped,
      })
    }
  }

  const stopRecording = (keep: boolean) => {
    keepRecording = keep
    clearRecordingTimer()
    if (activeRecorder && activeRecorder.state !== 'inactive') {
      activeRecorder.stop()
    } else {
      const tracksStopped = stopTracks()
      startButton.disabled = false
      stopButton.disabled = true
      cancelRecordingButton.disabled = true
      if (!keep) addEvent('pass', 'Recording cancelled and media tracks stopped', { tracksStopped })
    }
  }

  const uploadRecording = async () => {
    if (!recordedBlob || activeUpload) return
    uploadButton.disabled = true
    lifecycleUploadButton.disabled = true
    cancelUploadButton.disabled = false
    uploadStatus.textContent = 'Preparing staged upload…'

    const bytes = new Uint8Array(await recordedBlob.arrayBuffer())
    if (bytes.byteLength > MAX_PROBE_AUDIO_BYTES) {
      uploadButton.disabled = false
      lifecycleUploadButton.disabled = false
      cancelUploadButton.disabled = true
      uploadStatus.textContent = `Sample is too large for this probe (${bytes.byteLength} bytes).`
      addEvent('fail', 'Recorded sample exceeded the probe upload limit', {
        sizeBytes: bytes.byteLength,
        limitBytes: MAX_PROBE_AUDIO_BYTES,
      })
      return
    }
    const expectedHash = hashBytes(bytes)
    const extension = extensionForMime(recordedBlob.type)
    const file = new File([recordedBlob], `jarvistype-phase0-${Date.now()}.${extension}`, {
      type: recordedBlob.type || 'application/octet-stream',
    })

    activeUpload = new tus.Upload(file, {
      endpoint: '/api/v1/spindle-uploads',
      chunkSize: 16 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: true,
      metadata: { filename: file.name, extension: 'jarvistype' },
      onProgress: (uploaded, total) => {
        const percent = total > 0 ? Math.round((uploaded / total) * 100) : 0
        uploadStatus.textContent = `Uploading staged audio… ${percent}%`
      },
      onError: (error) => {
        activeUpload = null
        cancelUploadButton.disabled = true
        uploadButton.disabled = false
        lifecycleUploadButton.disabled = false
        uploadStatus.textContent = `Upload failed: ${error.message}`
        addEvent('fail', 'Staged upload failed', { error: error.message })
      },
      onSuccess: () => {
        const uploadId = activeUpload?.url?.split('/').filter(Boolean).pop()
        activeUpload = null
        cancelUploadButton.disabled = true
        if (!uploadId) {
          uploadButton.disabled = false
          lifecycleUploadButton.disabled = false
          uploadStatus.textContent = 'Upload finished without an upload ID.'
          addEvent('fail', 'Staged upload returned no upload ID')
          return
        }

        activeUploadRequestId = makeRequestId()
        uploadResultTarget = 'recording'
        uploadStatus.textContent = 'Upload complete; backend is verifying bytes and deleting the staged file…'
        const request: ProbeRequest = {
          protocolVersion: PROTOCOL_VERSION,
          type: 'probe.upload.verify',
          requestId: activeUploadRequestId,
          uploadId,
          expectedSize: file.size,
          expectedHash,
          reportedMimeType: file.type,
        }
        ctx.sendToBackend(request)
        addEvent('info', 'Staged upload completed; requested backend verification and deletion', {
          sizeBytes: file.size,
          mimeType: file.type,
        })
      },
    })

    uploadStatus.textContent = 'Uploading staged audio… 0%'
    activeUpload.start()
  }

  const cancelUpload = async () => {
    if (!activeUpload) return
    const upload = activeUpload
    activeUpload = null
    await upload.abort()
    cancelUploadButton.disabled = true
    uploadButton.disabled = recordedBlob === null
    lifecycleUploadButton.disabled = false
    uploadStatus.textContent = 'Upload cancelled. An incomplete staged upload will expire according to host policy.'
    addEvent('pass', 'Staged upload cancelled locally')
  }

  const startLifecycleUpload = () => {
    if (activeUpload || activeUploadRequestId) return

    lifecycleUploadButton.disabled = true
    uploadButton.disabled = true
    lifecycleStatus.textContent =
      'Paced upload active. Reload or disable the extension now, then re-enable it and export the receipt.'

    const bytes = new Uint8Array(LIFECYCLE_UPLOAD_BYTES)
    const file = new File([bytes], `jarvistype-lifecycle-${Date.now()}.bin`, {
      type: 'application/octet-stream',
    })
    const expectedHash = hashBytes(bytes)
    const upload = new tus.Upload(file, {
      endpoint: '/api/v1/spindle-uploads',
      chunkSize: LIFECYCLE_UPLOAD_CHUNK_BYTES,
      retryDelays: [0, 1000, 3000],
      removeFingerprintOnSuccess: true,
      metadata: { filename: file.name, extension: 'jarvistype' },
      onBeforeRequest: async (request) => {
        if (request.getMethod() === 'PATCH') await delay(LIFECYCLE_UPLOAD_DELAY_MS)
      },
      onProgress: (uploaded, total) => {
        const percent = total > 0 ? Math.round((uploaded / total) * 100) : 0
        lifecycleStatus.textContent =
          `Paced upload active (${percent}%). Reload or disable the extension now.`
      },
      onError: (error) => {
        if (disposed) return
        activeUpload = null
        lifecycleUploadButton.disabled = false
        uploadButton.disabled = recordedBlob === null
        lifecycleStatus.textContent = `Lifecycle upload failed: ${error.message}`
        addEvent('fail', 'Paced lifecycle upload failed', { error: error.message })
      },
      onSuccess: () => {
        const uploadId = upload.url?.split('/').filter(Boolean).pop()
        activeUpload = null
        if (!uploadId) {
          lifecycleUploadButton.disabled = false
          uploadButton.disabled = recordedBlob === null
          lifecycleStatus.textContent = 'Lifecycle upload finished without an upload ID.'
          addEvent('fail', 'Paced lifecycle upload returned no upload ID')
          return
        }

        activeUploadRequestId = makeRequestId()
        uploadResultTarget = 'lifecycle'
        lifecycleStatus.textContent =
          'Paced upload completed; backend is verifying and deleting the staged file.'
        const request: ProbeRequest = {
          protocolVersion: PROTOCOL_VERSION,
          type: 'probe.upload.verify',
          requestId: activeUploadRequestId,
          uploadId,
          expectedSize: file.size,
          expectedHash,
          reportedMimeType: file.type,
        }
        ctx.sendToBackend(request)
        addEvent('info', 'Paced lifecycle upload completed before teardown', {
          sizeBytes: file.size,
        })
      },
    })

    activeUpload = upload
    addEvent('info', 'Started paced lifecycle upload', {
      sizeBytes: file.size,
      chunkBytes: LIFECYCLE_UPLOAD_CHUNK_BYTES,
      delayMsPerPatch: LIFECYCLE_UPLOAD_DELAY_MS,
    })
    upload.start()
  }

  const runUiSelfCheck = () => {
    const root = requireElement<HTMLElement>(tab.root, '.jt-probe')
    const enabledControls = Array.from(
      root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]'),
    )
    const unnamedControls = enabledControls.filter((control) => !accessibleName(control))
    const negativeTabIndexControls = enabledControls.filter((control) => control.tabIndex < 0)
    const horizontalOverflow = root.scrollWidth > root.clientWidth + 1
    report.ui = {
      at: new Date().toISOString(),
      widthPx: root.clientWidth,
      scrollWidthPx: root.scrollWidth,
      horizontalOverflow,
      enabledControlCount: enabledControls.length,
      unnamedControlCount: unnamedControls.length,
      negativeTabIndexCount: negativeTabIndexControls.length,
      passed:
        !horizontalOverflow && unnamedControls.length === 0 && negativeTabIndexControls.length === 0,
    }
    lifecycleStatus.textContent = report.ui.passed
      ? `UI self-check passed at ${report.ui.widthPx}px. Complete one manual Tab-key pass.`
      : 'UI self-check found overflow or a keyboard/accessibility issue.'
    addEvent(report.ui.passed ? 'pass' : 'fail', 'UI self-check finished', {
      widthPx: report.ui.widthPx,
      horizontalOverflow,
      enabledControlCount: enabledControls.length,
      unnamedControlCount: unnamedControls.length,
      negativeTabIndexCount: negativeTabIndexControls.length,
    })
  }

  const cleanupResources = (trigger: CleanupReceipt['trigger']) => {
    if (cleanupPerformed) return
    cleanupPerformed = true
    disposed = true
    clearRecordingTimer()
    keepRecording = false

    const recordingWasActive =
      Boolean(activeStream) || Boolean(activeRecorder && activeRecorder.state !== 'inactive')
    const uploadWasActive = activeUpload !== null
    if (activeRecorder && activeRecorder.state !== 'inactive') activeRecorder.stop()
    const tracksStopped = stopTracks()
    const upload = activeUpload
    activeUpload = null
    const uploadAbortRequested = upload !== null
    if (upload) void upload.abort().catch(() => undefined)

    saveCleanupReceipt({
      at: new Date().toISOString(),
      trigger,
      recordingWasActive,
      uploadWasActive,
      tracksStopped,
      uploadAbortRequested,
      passed: tracksStopped && (!uploadWasActive || uploadAbortRequested),
    })
  }

  const copyResults = async () => {
    report.exportedAt = new Date().toISOString()
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      addEvent('pass', 'Copied sanitized probe results')
    } catch (error) {
      addEvent('fail', 'Could not copy probe results', { error: describeError(error) })
    }
  }

  const downloadResults = () => {
    report.exportedAt = new Date().toISOString()
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `jarvistype-phase0-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    addEvent('pass', 'Downloaded sanitized probe results')
  }

  const detachTabActivation = tab.onActivate(() => {
    report.lifecycle.drawerActivationCount += 1
    addEvent('pass', 'Drawer activated', {
      activationCount: report.lifecycle.drawerActivationCount,
    })
  })
  const detachInputAction = inputAction.onClick(() => {
    report.lifecycle.inputActionActivationCount += 1
    addEvent('pass', 'Input-bar action activated the probe', {
      activationCount: report.lifecycle.inputActionActivationCount,
    })
    tab.activate()
  })
  const handlePageHide = () => cleanupResources('pagehide')
  window.addEventListener('pagehide', handlePageHide, { once: true })
  refreshHostButton.addEventListener('click', requestHealth)
  lifecycleUploadButton.addEventListener('click', startLifecycleUpload)
  uiCheckButton.addEventListener('click', runUiSelfCheck)
  startButton.addEventListener('click', () => void startRecording())
  stopButton.addEventListener('click', () => stopRecording(true))
  cancelRecordingButton.addEventListener('click', () => stopRecording(false))
  uploadButton.addEventListener('click', () => void uploadRecording())
  cancelUploadButton.addEventListener('click', () => void cancelUpload())
  copyButton.addEventListener('click', () => void copyResults())
  downloadButton.addEventListener('click', downloadResults)

  addEvent(activeSetupInstances === 1 ? 'pass' : 'fail', 'Frontend capability probe initialized', {
    activeSetupInstances,
  })
  for (const receipt of cleanupReceipts) {
    addEvent(receipt.passed ? 'pass' : 'fail', 'Recovered cleanup receipt', {
      trigger: receipt.trigger,
      recordingWasActive: receipt.recordingWasActive,
      uploadWasActive: receipt.uploadWasActive,
      tracksStopped: receipt.tracksStopped,
      uploadAbortRequested: receipt.uploadAbortRequested,
    })
  }
  render()
  lifecycle.ready?.()
  requestHealth()

  return () => {
    window.removeEventListener('pagehide', handlePageHide)
    cleanupResources('extension-teardown')
    unsubscribeBackend()
    detachTabActivation()
    detachInputAction()
    inputAction.destroy()
    tab.destroy()
    changeActiveInstanceCount(-1)
  }
}

function factsHtml(rows: Array<[string, string]>): string {
  return rows
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('')
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`JarvisType probe could not find ${selector}`)
  return element
}

function accessibleName(element: HTMLElement): string {
  const ariaLabel = element.getAttribute('aria-label')?.trim()
  if (ariaLabel) return ariaLabel

  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
    if (label) return label
  }

  return element.getAttribute('title')?.trim() || element.textContent?.trim() || ''
}

function changeActiveInstanceCount(delta: 1 | -1): number {
  const key = '__jarvistypePhase0ActiveInstances'
  const state = window as unknown as Record<string, unknown>
  const current = typeof state[key] === 'number' ? state[key] : 0
  const next = Math.max(0, current + delta)
  state[key] = next
  return next
}

function loadCleanupReceipts(): CleanupReceipt[] {
  try {
    const value = window.sessionStorage.getItem(CLEANUP_STORAGE_KEY)
    if (!value) return []
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter(isCleanupReceipt).slice(-MAX_CLEANUP_RECEIPTS)
      : []
  } catch {
    return []
  }
}

function saveCleanupReceipt(receipt: CleanupReceipt): void {
  try {
    const receipts = [...loadCleanupReceipts(), receipt].slice(-MAX_CLEANUP_RECEIPTS)
    window.sessionStorage.setItem(CLEANUP_STORAGE_KEY, JSON.stringify(receipts))
  } catch {
    // A blocked sessionStorage should never prevent resource cleanup.
  }
}

function isCleanupReceipt(value: unknown): value is CleanupReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Record<string, unknown>
  return (
    typeof receipt.at === 'string' &&
    (receipt.trigger === 'pagehide' || receipt.trigger === 'extension-teardown') &&
    typeof receipt.recordingWasActive === 'boolean' &&
    typeof receipt.uploadWasActive === 'boolean' &&
    typeof receipt.tracksStopped === 'boolean' &&
    typeof receipt.uploadAbortRequested === 'boolean' &&
    typeof receipt.passed === 'boolean'
  )
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('aac')) return 'aac'
  return 'webm'
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function makeRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
