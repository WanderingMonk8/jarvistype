# Phase 0 Validation Register

## Purpose

This register separates facts guaranteed by published documentation from behavior that must be demonstrated on the hosted Lumiverse installation or against a selected provider. The PRD remains the product source of truth.

Status values are `DOCUMENTED`, `READY`, `PARTIAL`, `PASS`, `FAIL`, `LOCAL-PENDING`, `PROVIDER-PENDING`, and `PRODUCT-PENDING`.

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

Current probe version: `0.2.0`

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
