# Phase 3 Validation Register

## Scope

Phase 3 adds user-initiated voice capture, host-managed transcription, honest provisional/final display, sequential draft append, recording-segment persistence and undo, and lifecycle cleanup.

Current candidate version: `0.9.0`

## Native STT decision

- JarvisType uses Lumiverse's frontend `ctx.stt.start(...)` API behind `speech-to-text-v1`.
- Lumiverse owns microphone capture, provider credentials, audio transport, temporary provider data, and provider selection. JarvisType never receives or retains raw audio.
- JarvisType asks for `media` permission first when necessary, then requires another direct **Record Message** activation so microphone capture begins from an unambiguous user gesture.
- The configured connection verified in Phase 0 is batch-only. JarvisType displays real interim text only if a provider supplies it and never fabricates progressive transcription.
- A recording is limited to five minutes. Explicit cancel, drawer close, chat switch, page exit, permission change, and extension teardown call the host session's cancellation path.
- The host does not expose captured live audio for replay. A transcription failure therefore requires a new recording; only final-transcript draft commit reconciliation is retried once and deduplicated by operation ID.

## Implemented baseline

| ID    | Requirement                                 | Status      | Evidence                                                                                                                    |
| ----- | ------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| F3-01 | Native STT capability gate                  | LOCAL-PASS  | The UI requires both `speech-to-text-v1` and `ctx.stt`; unsupported hosts keep recording disabled with an explanation.      |
| F3-02 | Direct-action permission and start          | LOCAL-PASS  | Media permission is requested separately; a subsequent direct click synchronously calls `ctx.stt.start(...)`.               |
| F3-03 | Recording state, timing, stop, and cancel   | LOCAL-PASS  | The composer renders explicit lifecycle states, elapsed time, Stop, and Cancel, with a five-minute ceiling.                 |
| F3-04 | Honest provisional and final display        | LOCAL-PASS  | Interim callbacks replace pending provisional text; the session's completed transcript is authoritative.                    |
| F3-05 | Cleanup across terminal and lifecycle paths | LOCAL-PASS  | Active host sessions are cancelled on user cancel, drawer close, chat switch, page exit, permission change, and teardown.   |
| F3-06 | Ordered sequential append and whitespace    | LOCAL-PASS  | Domain tests verify ordered append, single-space boundaries, horizontal-whitespace deduplication, and line-break retention. |
| F3-07 | Versioned segment metadata and idempotency  | LOCAL-PASS  | Each committed segment stores raw transcript, committed text, offsets, timestamp, and versions; IDs suppress duplicates.    |
| F3-08 | Undo Last Recording                         | LOCAL-PASS  | Domain and mocked-backend tests remove only the newest unchanged segment while preserving older content.                    |
| F3-09 | Chat ownership and conflicting-action locks | LOCAL-PASS  | Frontend and backend both require the active owning chat; editing and sending lock while voice work is active.              |
| F3-10 | Persistence and Phase 2 migration           | LOCAL-PASS  | Schema migration preserves old drafts; recording segments persist in the canonical per-chat backend draft.                  |
| F3-11 | Cancellation commits no provisional text    | LOCAL-PASS  | Only the authoritative resolved transcript invokes append; interim results remain presentation-only.                        |
| F3-12 | Automated quality gate                      | LOCAL-PASS  | Formatting, lint, strict typing, 22 tests, builds, and package validation pass.                                             |
| F3-13 | Hosted Lumiverse verification               | REMOTE-PASS | All seven hosted test groups passed on Lumiverse 1.2.5 on 2026-10-15.                                                       |

## Hosted verification sequence

### Test 1: Upgrade, migration, and capability

**Status:** REMOTE-PASS — 2026-10-15

Verified on the hosted Lumiverse installation: version `0.9.0` loaded with backend readiness, the existing Phase 2 draft migrated with its text and review state intact, native STT controls were available, Record Edit remained disabled, and recording/sending stayed blocked until the active chat owned the open draft.

1. Update from `development` and verify JarvisType `0.9.0`.
2. Open a chat that retained a Phase 2 draft and confirm its exact text, history, paragraph numbering, and send behavior still load.
3. Confirm the voice panel reports the Lumiverse provider selection and exposes **Record Message**.
4. Confirm **Record Edit** remains disabled for Phase 5.
5. Switch to a non-owning chat and confirm recording and sending are blocked until **Open active chat's draft** is selected.

### Test 2: First batch-only recording

**Status:** REMOTE-PASS — 2026-10-15

Verified on the hosted Lumiverse installation: user-initiated capture showed recording and elapsed-time feedback, Stop transitioned through processing, the batch-only provider produced no simulated interim stream, and one authoritative final transcript was appended exactly once with a version increment, segment count, and recording-history entry.

1. Open the owning draft in a disposable chat and ensure it reports **Saved**.
2. Select **Record Message**. If media is not granted, approve it and select **Record Message** again.
3. Confirm a visible recording state and advancing elapsed time, then dictate a short distinctive sentence.
4. Select **Stop Recording** and confirm the UI changes to processing without appending provisional text.
5. For the verified batch-only connection, confirm no simulated interim transcript appears.
6. Confirm the authoritative final transcript appears once, is appended once, increments the draft version, and increases the segment count to one.

### Test 3: Sequential composition

**Status:** REMOTE-PASS — 2026-10-15

Verified on the hosted Lumiverse installation: a second recording appended after the first without replacement, duplication, or malformed boundary whitespace; versions, segment count, and chronological recording history advanced correctly and persisted across reload.

1. Record and complete a second distinctive sentence.
2. Confirm it appends after the first segment without replacing or rewriting the first.
3. Confirm the segment count becomes two and history contains two recording-append entries in order.
4. Confirm the boundary contains neither a run-together word nor duplicate horizontal spaces.
5. Reload and confirm both segments and their order persist.

### Test 4: Cancellation safety

**Status:** REMOTE-PASS — 2026-10-15

Verified on the hosted Lumiverse installation: explicit Cancel and closing or switching away from the JarvisType drawer both ended active capture, produced no late transcript, left draft text, version, history, and segment count unchanged, and released the microphone for another recording.

1. Note the current draft version, exact text, and segment count.
2. Start a recording, speak a distinctive phrase, then select **Cancel Recording** before stopping.
3. Confirm the UI reports cancellation and no phrase, version, history entry, or segment is added.
4. Start another recording and close or switch away from the JarvisType drawer while recording.
5. Reopen JarvisType and confirm that recording was also cancelled with no draft mutation.

### Test 5: Route and teardown cleanup

**Status:** REMOTE-PASS — 2026-10-15

Verified on the hosted Lumiverse installation: switching chats and reloading during capture cancelled the host session without mutating either draft or accepting late results, and a fresh recording could start afterward in both cases.

1. Start a recording and switch to another chat. Confirm recording ends and neither chat receives a transcript.
2. Return to the owning chat and confirm a fresh recording can start, proving the previous capture released the microphone.
3. Cancel it, then start once more and reload Lumiverse while recording.
4. Reopen JarvisType and confirm no transcript was committed and a new recording can start normally.

### Test 6: Recording undo and persistence

**Status:** REMOTE-PASS — 2026-10-15

Verified on the hosted Lumiverse installation: Undo Last Recording removed only the newest segment and its boundary whitespace, preserved the older segment, incremented the version, reduced segment count, added recording-removal history, and persisted the undone state across reload.

1. In one disposable chat, complete two short recordings and note the exact combined draft.
2. Select **Undo Last Recording** once.
3. Confirm only the second segment and its boundary whitespace are removed; the first segment and any older manual text remain.
4. Confirm the version increments, history records the recording removal, and the segment count decreases by one.
5. Reload and confirm the undone state persists.

### Test 7: Complete voice-MVP send

**Status:** REMOTE-PASS — 2026-10-15

Verified on the hosted Lumiverse installation: two completed recording segments formed one clean draft, Confirm & Send added exactly one user message containing only that clean text, normal response generation began, and the canonical draft and segment count cleared only after success.

1. In a disposable chat, create a draft from two completed recordings and review its exact clean text.
2. Select **Confirm & Send** and approve the confirmation.
3. Confirm exactly one user message appears with exactly the clean combined text and no segment metadata, paragraph numbers, provisional text, or history data.
4. Confirm normal Lumiverse generation starts and JarvisType clears only after successful send.

## Exit gate

**PASSED — 2026-10-15.** Two recordings append in order and send as one clean message, cancellation adds no text, and no host recording remains active after completion, cancellation, route change, or teardown. Phase 3 is complete.
