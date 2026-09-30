# Phase 0 Validation Register

## Purpose

This register separates facts guaranteed by published documentation from behavior that must be demonstrated on the hosted Lumiverse installation or against a selected provider. The PRD remains the product source of truth.

Status values are `DOCUMENTED`, `READY`, `PARTIAL`, `PASS`, `FAIL`, `LOCAL-PENDING`, `HOST-PENDING`, `PROVIDER-PENDING`, and `PRODUCT-PENDING`.

## Documentation-settled facts

| ID | Fact | Status | Reference |
|---|---|---|---|
| D-01 | Drawer tabs and input-bar actions do not require `ui_panels`. | DOCUMENTED | <https://docs.lumiverse.chat/frontend-api/ui-placement/> |
| D-02 | Drawer tabs expose `activate()` and automatically appear in the command palette. | DOCUMENTED | <https://docs.lumiverse.chat/frontend-api/ui-placement/> |
| D-03 | Staged uploads use tus, are scoped by user and extension, have a documented 1 GB maximum, and expire after 30 minutes of inactivity. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/uploads/> |
| D-04 | The staged-upload identifier, rather than audio bytes, should cross ordinary frontend/backend messaging. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/uploads/> |
| D-05 | Host audio conversion requires `media` and host FFmpeg. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/media/> |
| D-06 | CORS proxy request bodies are strings; binary multipart and incremental response streaming cannot be assumed. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/cors-proxy/> |
| D-07 | Secure Enclave provides per-user encrypted secret storage. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/secure-enclave/> |
| D-08 | `spindle.userStorage` provides per-user extension-scoped persistence. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/storage/> |
| D-09 | Appending requires `chat_mutation`; triggering normal response generation additionally requires `generation`. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/chat-mutation/> |
| D-10 | Backend and frontend Lumiverse versions can be read independently without permission. | DOCUMENTED | <https://docs.lumiverse.chat/backend-api/version/> |
| D-11 | Browser microphone capture requires a secure context and explicit permission. | DOCUMENTED | <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia> |

## Probe scope and safety

Current probe version: `0.4.0`

The remote probe:

- Requests no gated permissions.
- Does not read or modify chats.
- Does not call an STT or LLM provider.
- Retains a recorded sample only in frontend memory for the current page lifecycle.
- Uploads recorded audio only after a second explicit user action; the synthetic lifecycle upload also requires its own explicit button action.
- Computes a non-cryptographic integrity hash solely to compare transferred bytes.
- Explicitly deletes every completed staged upload after backend verification.
- Stores at most four sanitized teardown receipts in the current browser tab's `sessionStorage`; receipts contain only timestamps and cleanup booleans.
- Provides a paced 2 MiB synthetic upload for reload/disable testing. Completed test uploads are verified and deleted; interrupted partial uploads rely on the documented 30-minute inactivity expiry.
- Counts active setup instances and drawer/input-action activations, and can audit the visible drawer for horizontal overflow, accessible control names, and negative tab stops.
- Inspects only sanitized frontend/backend API member names and host capability names when checking for configured STT access.
- Requests the proposed `stt` permission only after `stt-invocation-v1` and all required methods are detected and the user explicitly starts the conformance run.
- Keeps the visible conformance transcript out of exported JSON; only transcript length and a non-cryptographic hash are retained.
- Exports no audio or credentials in its result JSON.

## Remote installation tests

### Recorded run R-001

- Test date: 2026-09-28.
- Probe version: `0.1.0` (the exported report does not embed a Git commit hash).
- Environment: Windows 10 x64, Firefox 156, secure HTTPS context.
- Lumiverse backend/frontend: `1.2.4` / `1.2.4`.
- Readiness API: `deferReady()` and `ready()` both available.
- Media APIs: `getUserMedia()` and `MediaRecorder` available.
- Supported candidates: `audio/webm;codecs=opus`, `audio/webm`, and `audio/ogg;codecs=opus`.
- Selected/actual format: `audio/webm;codecs=opus`.
- Recording result: 5,384 ms, 75,280 bytes, all media tracks stopped.
- Upload result: expected and backend sizes both 75,280 bytes; FNV-1a hashes both `9c04c4e0`; explicit deletion confirmed.
- Event result: no failure event was reported.
- Data handling: only this sanitized summary is committed; the host origin and complete user-agent report remain outside the repository.

### Recorded run R-002

- Test date: 2026-09-28.
- Probe version: `0.1.0` (the exported report does not embed a Git commit hash).
- Environment: Windows 10 x64, Firefox 156, secure HTTPS context.
- Lumiverse backend/frontend: `1.2.4` / `1.2.4`.
- Recording action: microphone access was followed by cancellation after approximately one second.
- Cleanup result: the probe reported `tracksStopped: true` and retained no recording sample.
- Event result: no failure event was reported.
- Data handling: only this sanitized summary is committed; the host origin and complete user-agent report remain outside the repository.

### Recorded run R-003

- Test date: 2026-09-28.
- Probe version: `0.1.0` (the exported report does not embed a Git commit hash).
- Environment: Windows 10 x64, Firefox 156, secure HTTPS context.
- Lumiverse backend/frontend: `1.2.4` / `1.2.4`.
- Recordings: 2,581 ms / 28,696 bytes and 8,482 ms / 125,616 bytes; both normal stops reported all tracks stopped.
- Repeated upload result: seven completed round trips reported matching bytes and explicit deletion.
- Final completed upload: expected and backend sizes both 125,616 bytes; FNV-1a hashes both `a9c05548`; explicit deletion confirmed.
- Cancellation result: one subsequent active tus upload was aborted locally and emitted `Staged upload cancelled locally` with no failure event.
- Cancellation limitation: probe `0.1.0` does not receive a deletion receipt for an incomplete tus upload; any partial server data relies on the host's documented inactivity expiry.
- Data handling: only this sanitized summary is committed; the host origin and complete user-agent report remain outside the repository.

### Recorded run R-004

- Test date: 2026-09-29.
- Probe version: `0.2.0` (the exported report does not embed a Git commit hash).
- Environment: Windows 10 x64, Firefox 156, secure HTTPS context.
- Lumiverse backend/frontend: `1.2.4` / `1.2.4`; the final setup reported exactly one active probe instance.
- UI placement: the tester manually confirmed one sidebar entry, one input-bar action, one command-palette result, correct activation behavior, and no duplicates after reload.
- Narrow layout and keyboard: the tester manually confirmed the narrow-layout and keyboard-access procedure. The final JSON was exported after later reload tests, so it does not retain the earlier run's optional `ui` snapshot.
- Recording teardown: a `pagehide` receipt captured `recordingWasActive: true`, `tracksStopped: true`, and `passed: true` at `2026-09-29T06:26:52.877Z`.
- Upload teardown: a `pagehide` receipt captured `uploadWasActive: true`, `uploadAbortRequested: true`, and `passed: true` at `2026-09-29T06:34:05.190Z`.
- Upload teardown limitation: the receipt proves that teardown invoked the tus abort path; it does not provide immediate server-side deletion confirmation for partial upload data, which remains subject to documented expiry.
- Additional round trip: a 5,179 ms / 71,187-byte WebM/Opus recording matched hash `93f0159e` after upload and was explicitly deleted.
- Event result: no failure event was reported.
- Data handling: only this sanitized summary is committed; the host origin and complete user-agent report remain outside the repository.

### Recorded run R-005

- Test date: 2026-09-30.
- Probe version: `0.3.0` (the exported report does not embed a Git commit hash).
- Environment: Windows 10 x64, Firefox 156, secure HTTPS context.
- Lumiverse backend/frontend: `1.2.4` / `1.2.4`; the setup reported exactly one active probe instance.
- Frontend surface: connection discovery/selection members were visible, but no STT invocation candidate or STT provider manager was exposed.
- Backend surface: `providers.register`, `providers.handle`, `providers.unregister`, and `providers.onChanged` were visible; no STT invocation candidate was exposed.
- Host capability match: only `connection-dispatch-resolution-v1`; no STT/transcription invocation capability was advertised.
- Conclusion: `registration-only`. The extension can supply a provider to Lumiverse, but cannot invoke the user's configured Lumiverse STT connection through the observed Spindle surface.
- Data handling: the export contained API/capability names and availability results, but no connection IDs, names, URLs, settings, provider metadata, credentials, or audio.

### Recorded run R-006

- Test date: 2026-09-30.
- Probe version: `0.4.0` (the exported report does not embed a Git commit hash).
- Environment: Windows 10 x64, Firefox 156, secure HTTPS context.
- Lumiverse backend/frontend: `1.2.4` / `1.2.4`; the setup reported exactly one active probe instance.
- Capability result: host capability version `0`; `stt-invocation-v1` was unavailable.
- API result: none of the five required methods were exposed. The missing methods were `transcribe`, `transcribeStream`, `getProviders`, `listConnections`, and `getConnection`.
- Safety-gate result: `permissionGranted` remained `false`. The probe stopped at capability detection without recording audio, staging an upload, or invoking a provider.
- Conclusion: the forward-compatible proposal gate passed on an unsupported host. This result does not test the proposed STT API's transcription behavior.
- Data handling: the exported report contained only sanitized capability and method availability results; it contained no audio, transcript, connection metadata, or credentials.

| ID | Test | Pass condition | Status | Evidence |
|---|---|---|---|---|
| L-01 | Install and enable | Production bundle installs from `development`, requests no gated permissions, and backend starts. | PASS | R-001: health response proves frontend and backend loaded; manifest permissions are empty. |
| L-02 | UI placement | Input-bar action activates exactly one drawer; command palette can also open it; reload creates no duplicates. | PASS | R-004: tester confirmed both activation paths, exactly one entry in each placement, no post-reload duplicates, and one active setup instance. |
| L-03 | Version and lifecycle | Backend/frontend versions appear and readiness APIs are reported. | PASS | R-001: versions `1.2.4` / `1.2.4`; both readiness APIs available. |
| L-04 | Microphone availability | Page is secure, permission prompt appears after the button action, and a non-empty sample is produced. | PASS | R-001: secure context; 75,280-byte recording. |
| L-05 | MIME negotiation | Supported candidate MIME types and the selected type are recorded in exported JSON. | PASS | R-001: WebM/Opus, WebM, and Ogg/Opus reported; WebM/Opus selected. |
| L-06 | Recording cleanup | Stop and cancel both leave every acquired media track in `ended` state. | PASS | R-001 verified normal stop; R-002 verified cancellation; both reported all tracks stopped. |
| L-07 | Staged upload round trip | Browser upload completes, backend size/hash match, and explicit deletion returns true. | PASS | R-001 and R-003: eight completed round trips matched; each reported `deleted: true`. |
| L-08 | Upload cancellation | The browser request stops cleanly; incomplete server data is left only to documented host expiry behavior. | PASS | R-003: active tus upload aborted locally without error; partial server data has no deletion receipt and relies on documented expiry. |
| L-09 | Disable/unload cleanup | Disabling or reloading during recording stops media tracks and aborts the active upload. | PASS | R-004: recording teardown stopped all tracks; upload teardown invoked the tus abort path. R-003 separately verified that awaiting that abort path completes cleanly. Partial server data still relies on documented expiry. |
| L-10 | Narrow layout and keyboard | Drawer remains usable at the narrowest supported width and every control is keyboard reachable. | PASS | R-004: tester manually confirmed the narrow-layout and keyboard procedure; the final post-reload export did not retain the earlier optional UI snapshot. |
| L-11 | Cross-user upload isolation | A second user cannot retrieve the first user's upload. A dedicated follow-up probe is required. | LOCAL-PENDING | Not included in probe 0.2.0 |
| L-12 | Host audio conversion | Conversion succeeds only if later selected provider formats require it. | PROVIDER-PENDING | Not included in probe 0.1.0 |
| L-13 | Genuine provider partials | Provider partials arrive incrementally and reconcile with final text; cancellation rejects late updates. | PROVIDER-PENDING | Not included in probe 0.1.0 |
| L-14 | Chat/send permission behavior | Append-only and append-with-generation behavior match the documented permission model. | LOCAL-PENDING | Deferred to a disposable-chat probe |
| L-15 | Semantic interpreter corpus | Structured output validates or returns typed failure; unsafe cases never mutate the draft. | PROVIDER-PENDING | Not included in probe 0.1.0 |

## Section 2: configured STT connection access

Probe `0.3.0` determines whether a Spindle extension can reuse the user's existing Lumiverse STT connection. It does not create a connection, request credentials, invoke a provider, or send audio. The exported result is limited to API member names, host capability names, and availability booleans.

| ID | Check | Pass condition | Status | Evidence |
|---|---|---|---|---|
| S2-01 | Host STT invocation surface | The runtime exposes a callable STT/transcription invocation path to either the frontend or backend extension context. | FAIL | R-005: both invocation-candidate arrays were empty; no matching host capability was advertised. |
| S2-02 | Registration versus invocation | Provider-registration APIs are not mistaken for APIs that invoke the user's configured STT provider. | PASS | R-005: `providers.register` and `providers.handle` were classified as registration-only. |
| S2-03 | Sanitized discovery | Export contains no connection IDs, names, URLs, provider metadata, credentials, or audio. | PASS | R-005: review confirmed that only API/capability names and availability results were exported. |
| S2-04 | Proposal capability gate | Probe 0.4.0 detects `stt-invocation-v1` and all five required methods before requesting permission or uploading audio. | PASS | R-006: Lumiverse 1.2.4 reported capability version 0 and all five methods missing; permission remained false and no recording, upload, or provider call occurred. |
| S2-05 | Proposed API conformance | On an implementing host, redacted discovery, streamed transcription, final reconciliation, capability reporting, cancellation, late-result rejection, and upload deletion pass. | HOST-PENDING | Requires a Lumiverse build implementing `LUMIVERSE-STT-API-PROPOSAL.md`. |

### Section 2 conclusion

Lumiverse `1.2.4` does not expose a callable Spindle API for reusing the user's configured STT connection. Connection discovery alone cannot satisfy JarvisType because it provides no way to submit audio, context, glossary hints, cancellation, or partial-result callbacks. JarvisType must not work around this by silently creating or requesting credentials for a duplicate connection.

The preferred resolution is the host-managed interface specified in `LUMIVERSE-STT-API-PROPOSAL.md`: configured connection selection, audio/upload input, context and vocabulary hints, cancellation, capability negotiation, and genuine partial/final result events. Until that capability exists, provider-dependent tests `L-12` and `L-13` remain blocked by the host integration boundary.

## Product and provider decisions

| ID | Decision | Current baseline | Status |
|---|---|---|---|
| P-01 | Primary composition placement | Drawer tab opened by input-bar action; command palette is alternate entry. | PRODUCT-PENDING |
| P-02 | Context range | Default is fixed at `5`; proposed configurable range is `0–20`. | PRODUCT-PENDING |
| P-03 | Hard context ceiling | Application ceiling plus any lower provider-adapter limit. | PROVIDER-PENDING |
| P-04 | Initial languages | Proposed initial release is English. | PRODUCT-PENDING |
| P-05 | Draft persistence | Restore the owning-chat draft across approved lifecycle paths; expiry and chat-switch UX remain open. | PRODUCT-PENDING |
| P-06 | Semantic auto-application | Proposal-first until evaluation supports narrower automatic classes. | PRODUCT-PENDING |
| P-07 | Send without generation | Normal response generation remains default; append-only fallback remains open. | PRODUCT-PENDING |
| P-08 | Product telemetry | Off unless separately approved and disclosed. | PRODUCT-PENDING |
| P-09 | Initial STT provider | No provider selected. | PROVIDER-PENDING |
| P-10 | Semantic interpreter | Compare configured Lumiverse generation with a dedicated adapter. | PROVIDER-PENDING |
| P-11 | Supported platforms and minimum version | Lumiverse 1.2.4 with Firefox 156 on Windows 10 is known-good; minimum and other release targets remain unproven. | LOCAL-PENDING |

## Evidence submission

For each VPS/device run, retain:

- The downloaded sanitized JSON result.
- JarvisType commit hash.
- Test date and tester.
- Client/browser, operating system, and device.
- Expected result, actual result, and any sanitized screenshots or server log excerpts.
- Confirmation that recording tracks stopped and completed staged uploads were deleted.

Never include credentials, raw audio, full private chats, or unrelated server logs.
