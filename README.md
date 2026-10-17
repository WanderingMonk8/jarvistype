# JarvisType

JarvisType is a [Lumiverse](https://lumiverse.chat/) extension for composing chat messages by voice. It provides a private working draft where users can dictate a message in multiple recordings, inspect context-aware normalization, manage a personal glossary, and approve the final text before it is sent.

> **Project status:** Phase 6 implementation candidate (`1.4.2`). Phases 0–5 have passed local and hosted validation on the `development` branch. Phase 6 advanced conversational editing and language controls is ready for staged verification.

## What JarvisType is designed to do

- Use recent Lumiverse messages to improve transcription accuracy.
- Let the user select a dedicated Lumiverse text connection and search its available models for post-transcription normalization.
- Build one message progressively across multiple recordings.
- Review and accept or reject every **Record Message** transcription before it can enter the current draft.
- Interpret separate **Record Edit** recordings as editing instructions.
- Number paragraphs for precise spoken references.
- Show the current message and the latest diff after every change.
- Support undo and repeated editing before submission.
- Handle common spoken punctuation commands.
- Accept explicit letter-by-letter spelling for difficult words.
- Apply spoken capitalization commands during editing.
- Use explanatory references to distinguish homophones and other confusable words.
- Maintain a personal spelling glossary for words, names, acronyms, and specialized terms.
- Send nothing to the Lumiverse chat until the user explicitly confirms it.

## Intended workflow

```text
Open JarvisType
      |
Record Message ----> Transcribe and normalize ----> Accept / Reject
                                                       |
                                              Append accepted segment
                                                       |
Record Edit ------> Transcribe -> Interpret intent -> Validate patch
                                                    |
                                             Show draft + diff
                                     |
                           Edit again / Undo
                                     |
                              Confirm & Send
                                     |
                           Add clean text to chat
```

Message recording and editing use separate controls so JarvisType does not have to guess whether speech is content or a command. **Record Message** always appends by default; location-specific insertion is performed through **Record Edit**.

## Context-aware transcription

JarvisType will use the five most recent eligible chat messages by default. Users will be able to change this number, including disabling chat context entirely. A separate hard size limit will keep requests bounded.

Each transcription can also use:

- The complete unsent draft for continuity.
- The user's personal spelling glossary.
- Preferred capitalization, spelling, and hyphenation.

Context is intended to correct recognition errors, not rewrite or paraphrase the user's message.

## Explicit spelling and word references

Users can spell a difficult word letter by letter and optionally follow it with a whole-word pronunciation cue. For example, "C-A-E-S-A-R, Caesar" is interpreted as one occurrence of `Caesar`; the spelled letters are authoritative and the trailing rendition is not duplicated.

Once an explicitly spelled token is committed through either message recording or editing, JarvisType automatically adds or updates it in the user's personal spelling glossary. The entry is available to later recordings immediately. Provisional, cancelled, rejected, or ambiguous results are not learned, conflicts never overwrite an existing mapping silently, and every automatic update includes an independent **Undo** action.

Referential corrections also work for ordinary words, homophones, and near-homophones—not only proper nouns. For example:

> In the sentence where I say "can the worker," I meant "Ken the worker," as in Barbie and Ken.

JarvisType uses the explanation to identify the intended spelling, applies only the requested replacement, and omits the explanatory wording from the draft. One-time references remain local to the current session unless the user explicitly asks to remember them.

## Conversational editing

The draft editor will assign display-only numbers to non-empty paragraphs. This enables instructions such as:

- “In paragraph two, replace ‘steeper’ with ‘more difficult.’”
- “Insert a new paragraph after paragraph three.”
- “Delete the second sentence in paragraph one.”
- “Move paragraph four before paragraph two.”

JarvisType uses semantic natural-language interpretation as the primary command interface, so users do not need to memorize stock phrases. The editing audio is first preserved as an instruction transcript. A language model then converts the flexible wording into an allowlisted, structured operation; it never edits the draft directly.

A deterministic resolver validates the target and draft version, and a deterministic patch engine applies the operation and produces the diff. Ambiguous changes require confirmation, and applied changes remain undoable. A small stock-phrase recognizer may accelerate simple commands such as "undo" or "delete paragraph three," but it must emit the same operation schema and pass through the same validation and patch pipeline.

Editing commands also support explicit casing transformations:

- "Capitalize Caesar."
- "In paragraph two, make NASA all caps."
- "Change the quoted phrase to lowercase."

These transformations affect only the targeted letters and preserve surrounding punctuation, whitespace, and formatting.

Paragraph numbers, diff markers, segment metadata, and editing history are never included in the submitted message.

## Documentation

The [Product Requirements Document](./PRD.md) is the source of truth for product behavior, scope, acceptance scenarios, platform constraints, privacy requirements, and unresolved decisions.

The [Phase 0 Validation Register](./PHASE0-VALIDATION.md) records the completed feasibility evidence and known provider limitations. The [Phase 1 Validation Register](./PHASE1-VALIDATION.md) records the completed production-foundation exit gate. The [Phase 2 Validation Register](./PHASE2-VALIDATION.md) records the completed draft-lifecycle and safe-send exit gate. The [Phase 3 Validation Register](./PHASE3-VALIDATION.md) records the completed voice-recording, transcription, sequential-append, and recording-cleanup exit gate.

The [historical Lumiverse STT API Proposal](./LUMIVERSE-STT-API-PROPOSAL.md) records the backend contract proposed against Lumiverse 1.2.4. Lumiverse 1.2.5 instead shipped the official frontend [Speech-to-text API](https://docs.lumiverse.chat/frontend-api/speech-to-text/), which is now the primary integration target.

Lumiverse extension development references:

- [Spindle Extension Developer Guide](https://docs.lumiverse.chat/)
- [Permissions](https://docs.lumiverse.chat/getting-started/permissions/)
- [Chats API](https://docs.lumiverse.chat/backend-api/chats/)
- [Chat Mutation API](https://docs.lumiverse.chat/backend-api/chat-mutation/)
- [UI Placement API](https://docs.lumiverse.chat/frontend-api/ui-placement/)

## Planned Lumiverse integration

The current design expects to use:

- An input-bar action and extension-owned composition surface.
- Browser microphone capture.
- Frontend/backend extension messaging.
- Lumiverse chat access for recent context.
- Chat mutation for confirmed submission.
- Frontend `ctx.stt` behind `speech-to-text-v1`, reusing the user's selected or explicitly configured STT connection without exposing credentials.
- User-scoped storage for settings and personal spelling glossary entries.

The validated primary placement is an extension-owned drawer opened from the input bar. Lumiverse 1.2.5 is the minimum voice-capable host, and the tested configured STT connection returns batch-only final transcripts. Drafts persist per user and per owning chat across reloads and extension restarts. Context ceilings, supported languages, and draft expiry/discard UX remain open product decisions documented in the PRD.

## Current development build

Version `0.9.0` is the completed Phase 3 build. It retains the completed Phase 2 draft lifecycle and adds:

- User-initiated host-managed recording through Lumiverse `ctx.stt.start(...)`.
- Visible starting, recording, processing, committing, completion, cancellation, and error feedback with elapsed time.
- Genuine interim transcript display when supplied by the provider and authoritative final-only display for batch providers.
- A five-minute recording ceiling and cleanup on cancel, drawer close, chat switch, page exit, permission change, and teardown.
- Ordered, idempotent final-transcript append with conservative boundary whitespace.
- Persisted recording-segment metadata and **Undo Last Recording**.
- Safe migration of existing Phase 2 draft storage.
- Twenty-two passing domain, protocol, request-lifecycle, persistence, and mocked-backend tests.

Record Message is enabled when the active chat owns a saved draft and Lumiverse exposes `speech-to-text-v1`. Record Edit remains intentionally disabled until Phase 5. See [PHASE3-VALIDATION.md](./PHASE3-VALIDATION.md) for the completed hosted verification record.

## Historical Phase 0 remote capability probe

Probe 0.6.1, preserved in repository history and summarized in the Phase 0 register, invoked Lumiverse's native frontend STT API and verified the platform path that JarvisType depends on:

- Drawer-tab registration and input-bar activation.
- Frontend/backend messaging and Lumiverse version discovery.
- Secure-context and browser media API availability.
- Runtime `MediaRecorder` MIME support.
- Bounded microphone recording, cancellation, and media-track cleanup.
- Resumable staged upload from the browser.
- Backend byte-size and hash verification.
- Explicit deletion of the completed staged upload.
- Reload/disable cleanup receipts for active recording and upload resources.
- Drawer activation counters and a responsive-layout/accessibility self-check.
- Sanitized discovery of any host API capable of invoking Lumiverse's configured STT connection.
- Native `ctx.stt` provider discovery, configured-connection capture, interim/final reconciliation, cancellation, and teardown cleanup.
- Forward-compatible conformance testing for the proposed `stt-invocation-v1` API.
- Deterministic audio edge-case checks and device/visibility/track-ending observations.
- A numbered-paragraph composition fixture with long text, diff, edit history, focus, keyboard, and narrow-layout checks.
- Explicitly authorized append-only and append-with-generation tests in a disposable chat.
- Sanitized JSON evidence export.

The probe declares only Lumiverse's `media` permission and does not read chat messages, connection identifiers, or credentials. Native provider discovery does not start the microphone; configured-connection capture begins only from the explicit start button and may send audio to the user's configured STT provider under that provider's policy. The live transcript is visible in the drawer but excluded from the JSON export, which retains only sanitized metadata such as length, hash, lifecycle counts, and error names. Chat mutation is possible only after an explicit disposable-chat confirmation: append-only requests `chat_mutation`, while append-and-generate also requests `generation` and can incur configured-provider usage. Recorded audio is not retained after the page or extension is unloaded, and a completed historical conformance upload is deleted by the backend in `finally`.

### Build verification

```bash
npm ci
npm test
```

The compiled `dist/backend.js` and `dist/frontend.js` files are committed so the VPS can install the branch without relying on its extension builder.

### Remote test procedure

The following procedure is historical and applies to probe 0.6.x, not the current `development` build. Current Phase 1 verification is maintained in `PHASE1-VALIDATION.md`.

#### Native STT 0.6.x focused test

1. For historical reproduction only, check out commit `1130daa` and verify the displayed probe version is `0.6.1`. Approve the declared `media` permission if Lumiverse asks during installation.
2. Open **JarvisType Probe** and select **Discover native providers**. This action must not start the microphone.
3. Confirm the status says the configured connection is available. If it does not, download the JSON and stop; do not continue with capture.
4. Select **Start configured STT**. If Lumiverse requests `media`, approve it and then select **Start configured STT** a second time as instructed.
5. After the status says it is listening, say: “JarvisType uses a Pip-Boy. Caesar is spelled C-A-E-S-A-R.” Watch the visible transcript, then select **Stop and finalize**.
6. Confirm the status reports a passed transcription and an authoritative final transcript. `genuine-interim` means live partials were observed; `batch-only` is also a valid API run but leaves genuine provider partials unconfirmed.
7. Start another run, speak briefly, and select **Cancel and discard** while it is listening. Confirm cancellation passes and the visible transcript is discarded.
8. Select **Download JSON** and retain this first report. Under `nativeStt`, confirm `apiAvailable: true`, an available `connection` provider, a passing `liveRun`, a passing `cancellationRun` with `aborted: true`, and `lateResultCount: 0`. Confirm no transcript text or audio appears in the file.
9. For teardown cleanup, start configured STT once more and wait for the listening status. While it is active, reload Lumiverse or disable and re-enable the extension.
10. Reopen the probe and select **Download JSON** again. Confirm the recovered cleanup receipt has `nativeSttWasActive: true`, `nativeSttCancelRequested: true`, and `passed: true`.

Keep both JSON reports. Do not post them publicly without reviewing `origin` and `userAgent`; neither is a credential, but both describe the test environment.

#### Full regression procedure

1. For historical reproduction only, install commit `1130daa` using the VPS deployment workflow.
2. Enable **JarvisType Phase 0 Probe**. Probe 0.6.1 should declare only the `media` permission.
3. Open **JarvisType Probe** from the chat input-bar Extras menu. Confirm that **Input-action activations** and **Drawer activations** increase once, then open the same drawer through `Ctrl+K` and confirm only the drawer count increases.
4. Reload Lumiverse. Confirm there is exactly one JarvisType sidebar entry, one Extras action, one command-palette result, and **Active probe instances** is `1`.
5. Confirm that the backend and frontend Lumiverse versions appear in **Host and lifecycle**.
6. Select **Start recording**, grant microphone permission, speak briefly, and select **Stop and keep sample**. Confirm the sample is non-empty and **Tracks stopped** reports **Yes**.
7. Select **Upload and verify sample**. Confirm the final status says the bytes matched and staged-upload deletion was confirmed.
8. Repeat once with **Cancel recording** and once with **Cancel upload**.
9. Start a recording and, while it is active, reload the page or disable then re-enable the extension. Reopen the probe and confirm a cleanup receipt has `recordingWasActive: true`, `tracksStopped: true`, and `passed: true`.
10. Select **Start paced teardown upload** and immediately reload or disable/re-enable the extension while its percentage is still advancing. Confirm a cleanup receipt has `uploadWasActive: true`, `uploadAbortRequested: true`, and `passed: true`. Any interrupted partial upload expires under Lumiverse's staged-upload policy.
11. Select **Run deterministic audio checks** while no recording is active. Confirm zero-byte and oversized samples are rejected and repeated idle terminal actions are ignored.
12. Revoke microphone permission in the browser, select **Start recording**, deny the prompt if one appears, and confirm the export records a capture error such as `NotAllowedError` with all acquired tracks stopped. Restore permission afterward.
13. Start another recording, switch to a different tab and back, and confirm visibility changes are counted. If practical, disconnect or change the active microphone and confirm a device change or unexpected track ending is recorded. Cancel the recording and confirm cleanup.
14. In **Composition UI fixture**, select **Run composition UI check**. Confirm three numbered editable paragraphs, wrapped long text, one deletion and insertion in the diff, three history entries, successful focus movement, and no overflow.
15. Make the drawer as narrow as the host permits. Edit all three paragraphs, inspect the diff and history, then use only `Tab`, `Shift+Tab`, `Enter`, and `Space` to reach and operate every enabled control.
16. Create or open a disposable chat. Check the disposable-chat authorization box and select **Test append only**. Approve `chat_mutation`; confirm exactly one marker is added and no generation starts.
17. In that disposable chat, select **Test append and generation**. Approve `generation`; confirm exactly one marker is added and a normal response begins. This can incur configured-provider usage.
18. Select **Inspect host STT surface**. This inspects API names and capability flags only; it does not send audio or invoke the configured provider.
19. Record the displayed conclusion. **Candidate STT invocation API found** means the exported report contains one or more callable candidate paths. **Only provider-registration surfaces were found** means the host lets extensions supply an STT engine but exposes no callable route to the user's configured engine.
20. Select **Check proposed API**. On Lumiverse 1.2.4, confirm it reports capability version `0`, lists the five missing methods, and does not show a permission prompt.
21. On a host implementing the proposal, record yourself saying “JarvisType uses a Pip-Boy,” select **Check proposed API**, and then select **Grant permission and transcribe sample**. Approve only the `stt` permission.
22. Confirm genuine partials appear incrementally when supported, the final transcript is authoritative, applied/unsupported features are reported, and staged-upload deletion is confirmed. The visible transcript is not included verbatim in exported JSON.
23. Repeat with a longer sample and select **Cancel STT test** after provider processing starts. Confirm the result is aborted, no late text is accepted, and upload deletion is confirmed.
24. Run the focused native STT procedure above, then select **Download JSON** and retain the resulting evidence files. They contain environment and result metadata, cleanup booleans, counters, sanitized API/provider summaries, chat-test booleans, and transcript length/hash, but no audio, transcript text, chat/message identifiers, connection identifiers, settings, or credentials.

Do not post the complete JSON report publicly without reviewing its `origin` and `userAgent` fields. Neither field is a credential, but both describe the test environment.

## Contributing

Proposed product changes should begin with an update to `PRD.md` so implementation and documentation remain aligned. Phase 0 implementation evidence belongs in `PHASE0-VALIDATION.md`.
