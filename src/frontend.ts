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
  }
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
      .jt-probe { box-sizing: border-box; display: grid; gap: 16px; padding: 16px; max-width: 900px; }
      .jt-probe * { box-sizing: border-box; }
      .jt-probe h2, .jt-probe h3, .jt-probe p { margin: 0; }
      .jt-probe-card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 10px; padding: 14px; display: grid; gap: 10px; }
      .jt-probe-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .jt-probe button { min-height: 36px; padding: 7px 12px; cursor: pointer; }
      .jt-probe button:disabled { cursor: not-allowed; opacity: 0.55; }
      .jt-probe-status { font-weight: 600; }
      .jt-probe-grid { display: grid; grid-template-columns: minmax(150px, auto) 1fr; gap: 6px 12px; }
      .jt-probe-grid dt { font-weight: 600; }
      .jt-probe-grid dd { margin: 0; overflow-wrap: anywhere; }
      .jt-probe-log { margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .jt-probe-note { opacity: 0.8; font-size: 0.92em; }
    </style>
    <section class="jt-probe" aria-labelledby="jt-probe-title">
      <div>
        <h2 id="jt-probe-title">JarvisType Phase 0 Capability Probe</h2>
        <p class="jt-probe-note">This probe requests no gated Lumiverse permissions, sends no chat messages, and deletes each completed staged upload after verification.</p>
      </div>
      <section class="jt-probe-card" aria-labelledby="jt-host-title">
        <h3 id="jt-host-title">Host and lifecycle</h3>
        <dl class="jt-probe-grid" data-host-facts></dl>
        <div class="jt-probe-actions"><button type="button" data-refresh-host>Refresh host check</button></div>
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
        <pre class="jt-probe-log" tabindex="0" data-results-log></pre>
      </section>
    </section>
  `

  const hostFacts = requireElement<HTMLElement>(tab.root, '[data-host-facts]')
  const mediaFacts = requireElement<HTMLElement>(tab.root, '[data-media-facts]')
  const recordingStatus = requireElement<HTMLElement>(tab.root, '[data-recording-status]')
  const uploadStatus = requireElement<HTMLElement>(tab.root, '[data-upload-status]')
  const resultsLog = requireElement<HTMLElement>(tab.root, '[data-results-log]')
  const refreshHostButton = requireElement<HTMLButtonElement>(tab.root, '[data-refresh-host]')
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
  let activeUploadRequestId: string | null = null
  let healthRequestId: string | null = null

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
        activeUploadRequestId = null
        uploadStatus.textContent = payload.ok
          ? 'Passed: bytes matched and staged upload deletion was confirmed.'
          : `Failed: ${payload.error ?? 'byte verification did not match.'}`
        uploadButton.disabled = recordedBlob === null
        addEvent(payload.ok ? 'pass' : 'fail', 'Staged upload verification finished', {
          bytesMatched:
            payload.expectedSize === payload.actualSize && payload.expectedHash === payload.actualHash,
          deleted: payload.deleted,
        })
      } else {
        uploadStatus.textContent = 'Backend verified the staged bytes; awaiting deletion confirmation.'
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
    cancelUploadButton.disabled = false
    uploadStatus.textContent = 'Preparing staged upload…'

    const bytes = new Uint8Array(await recordedBlob.arrayBuffer())
    if (bytes.byteLength > MAX_PROBE_AUDIO_BYTES) {
      uploadButton.disabled = false
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
        uploadStatus.textContent = `Upload failed: ${error.message}`
        addEvent('fail', 'Staged upload failed', { error: error.message })
      },
      onSuccess: () => {
        const uploadId = activeUpload?.url?.split('/').filter(Boolean).pop()
        activeUpload = null
        cancelUploadButton.disabled = true
        if (!uploadId) {
          uploadButton.disabled = false
          uploadStatus.textContent = 'Upload finished without an upload ID.'
          addEvent('fail', 'Staged upload returned no upload ID')
          return
        }

        activeUploadRequestId = makeRequestId()
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
    uploadStatus.textContent = 'Upload cancelled. An incomplete staged upload will expire according to host policy.'
    addEvent('pass', 'Staged upload cancelled locally')
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

  const detachInputAction = inputAction.onClick(() => tab.activate())
  refreshHostButton.addEventListener('click', requestHealth)
  startButton.addEventListener('click', () => void startRecording())
  stopButton.addEventListener('click', () => stopRecording(true))
  cancelRecordingButton.addEventListener('click', () => stopRecording(false))
  uploadButton.addEventListener('click', () => void uploadRecording())
  cancelUploadButton.addEventListener('click', () => void cancelUpload())
  copyButton.addEventListener('click', () => void copyResults())
  downloadButton.addEventListener('click', downloadResults)

  addEvent('info', 'Frontend capability probe initialized')
  render()
  lifecycle.ready?.()
  requestHealth()

  return () => {
    disposed = true
    clearRecordingTimer()
    keepRecording = false
    if (activeRecorder && activeRecorder.state !== 'inactive') activeRecorder.stop()
    stopTracks()
    if (activeUpload) void activeUpload.abort()
    unsubscribeBackend()
    detachInputAction()
    inputAction.destroy()
    tab.destroy()
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
