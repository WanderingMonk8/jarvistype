# Phase 7 Validation Register

## Scope

Phase 7 hardens the accepted floating-composer beta for release across recovery, privacy, security, accessibility, performance, compatibility, and exactly-once sending.

Candidate version: `1.6.7`

Minimum supported Lumiverse version: `1.2.5`

## Current status

| ID    | Requirement                              | Status      | Evidence                                                                                                                                                                                  |
| ----- | ---------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F7-01 | Recoverable failures preserve drafts     | REMOTE-PASS | Hosted Test 1 passed on October 17, 2026: saved drafts, history, glossary data, floating ownership, focus return, reload recovery, and race-safe per-chat draft switching were confirmed. |
| F7-02 | Privacy-safe operational diagnostics     | LOCAL-PASS  | Provider exception text is redacted; user-visible failures carry a bounded diagnostic reference; regression tests reject private draft/provider leakage.                                  |
| F7-03 | Protocol and structured-edit security    | LOCAL-PASS  | Closed-schema validation rejects malformed, oversized, unknown, overlapping, stale, and incompatible operations.                                                                          |
| F7-04 | Prompt-injection resistance              | REMOTE-PASS | Hosted Test 4 confirmed instruction-like draft and quoted edit text remain inert data; only the reviewed allowlisted replacement executed after acceptance.                               |
| F7-05 | Keyboard and assistive-technology access | PARTIAL     | Hosted keyboard and focus workflows passed through editing, review, history, commands, glossary, and confirmed send. The user deliberately deferred screen-reader verification.           |
| F7-06 | Long-state performance budgets           | REMOTE-PASS | Hosted maximum-state testing passed for a near-100,000-character draft, 500 glossary entries, 50 retained history entries, and maximum bounded context.                                   |
| F7-07 | Supported-platform compatibility         | PENDING     | Hosted desktop and narrow/mobile matrix remains.                                                                                                                                          |
| F7-08 | Exactly-once safe send under stress      | PASS        | Hosted normal and rapid-repeat confirmation paths produced one message; deterministic delayed-ack concurrency proves one append and repeatable acknowledgements.                          |
| F7-09 | Complete package quality gate            | LOCAL-PASS  | Formatting, lint, strict typing, 107 tests, backend/frontend builds, and package validation pass.                                                                                         |

## Privacy and security decisions

- JarvisType invokes microphone access only from labeled user actions through Lumiverse `ctx.stt.start(...)`.
- Lumiverse owns audio transport, temporary audio lifetime, provider selection, and credentials; JarvisType receives transcript callbacks and never receives provider credentials.
- Context normalization receives bounded text only after STT. Ordinary message normalization sends the current recording, at most two recent messages, a compact spelling/proper-noun reference vocabulary, glossary data, and the configured generation connection; it does not send the working draft. Record Edit receives the draft separately because target resolution requires it.
- Operational logs contain event category, error class, and a random diagnostic ID. They do not contain provider exception messages, raw transcripts, context, glossary entries, user IDs, chat IDs, credentials, or full drafts.
- Generated normalization and edit interpretations cannot call tools or mutate state. They must pass bounded response parsing, an allowlisted schema, deterministic target validation, visible review, and explicit confirmation.

## Command safeguard audit

**Status:** LOCAL-PASS — October 17, 2026, version `1.6.7`

| Activation surface                                                                                       | Flexible behavior                                                                                                                                                                                                                                                          | False-activation safeguards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Record Message** and **Record Edit**                                                                   | User-facing buttons accept unrestricted spoken content after activation.                                                                                                                                                                                                   | No spoken phrase can start recording; microphone access always requires a labeled user action. Message content is never interpreted as a structured edit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Spoken punctuation and layout                                                                            | Bare forms remain available in clear dictation contexts; `insert`, `punctuation`, or `command` can explicitly force any supported mark. An enabled contextual pass may recover a standout command from a minor transcription error even without prior context.             | `literal`, `the word`, `the words`, and `the phrase` protect every supported term. Common noun, verb, article, medical, typographic, and descriptive contexts remain literal. Command intent is determined only from the current sentence and immediate neighbors; historical references may inform spelling and subjects but not activation. Contextual command decisions must quote an exact raw span and resolve to the allow-list. Deterministic marks are authoritative against contextual normalization. Provider punctuation attached to any recognized command is pruned; closing delimiters retain a needed terminal mark only for otherwise unterminated content. Bare terminal commands after provider punctuation and exact repeated terminal commands are deduplicated; cross-type combinations, explicit cues, and outer periods after closed parentheticals remain available. |
| `quote` and `single quote`                                                                               | A complete bare pair creates typographic quotation marks; explicit open/close or punctuation cues remain available. Voice-generated openings prune provider punctuation attached to the opening command, tighten spacing, and capitalize an ordinary lowercase first word. | A lone or odd number of bare quote terms remains literal. Any protected literal quote context disables bare-pair inference for that utterance. Provider-supplied quotation marks, explicitly commanded leading punctuation, and established mixed-case terms remain unchanged. General command-boundary pruning removes a provider period attached to the closing command when the quoted content already has terminal punctuation.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Explicit spelling                                                                                        | Separated letters, optional casing, and a matching whole-word pronunciation cue remain flexible.                                                                                                                                                                           | At least three letters are required; unmatched cues remain text; compact hyphenated forms require uppercase evidence, an explicit casing cue, or a matching pronunciation cue; learning occurs only after approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `as in` reference                                                                                        | Natural explanatory wording remains available with the repeated-token form `X, as in … X …` and clear inflectional references such as `filled, as in filling something up`.                                                                                                | The token immediately before `as in` must repeat exactly or as an unmistakable inflection shortly afterward. Otherwise `as in` must survive literally in the structured operation or interpretation is rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Replace, insert, delete, append, prepend, move, case, split, join, punctuation targeting, and multi-edit | The dedicated **Record Edit** path accepts natural phrasing rather than fixed activation sentences.                                                                                                                                                                        | Model output is data only and must pass the closed operation schema, size/count limits, draft-version check, unique target resolution, overlap/no-op checks, visible proposal, explicit approval, diff, and undo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| New content supplied through **Record Edit**                                                             | Replacement, insertion, append, and prepend payloads accept the same spoken punctuation, layout, spelling, casing, and glossary cues as message dictation after the operation is identified.                                                                               | Normalization is restricted to structured `operation.text`; instruction verbs and target selectors remain untouched, while explicit-literal and natural-language safeguards preserve command vocabulary used as content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Deterministic paragraph insertion                                                                        | Common variations around “insert a new paragraph before/after paragraph N” are accepted.                                                                                                                                                                                   | The fast path is anchored to the entire instruction, requires a valid positive paragraph ordinal and non-empty payload, and still produces a review proposal. Other wording falls back to the guarded semantic interpreter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Undo, redo, history, glossary changes, and send                                                          | Clearly labeled controls avoid memorized spoken incantations.                                                                                                                                                                                                              | Disabled-state checks and versioning prevent invalid actions; send additionally requires ownership, permissions, a confirmation dialog, and exactly-once operation handling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Hosted verification sequence

### Test 1: Upgrade, recovery, and permanent floating ownership

**Status:** REMOTE-PASS — October 17, 2026, version `1.6.7` through commit `adc75be`

The hosted retest confirmed upgrade preservation, toolbar and drawer launch paths, permanent floating ownership, state preservation across close/reopen and reload, focus return to the drawer launcher, automatic loading of distinct chat-owned drafts, preservation of an edit made immediately before switching, and protection against stale loads during rapid switching.

1. Update the extension from `development` and confirm version `1.6.7` reports backend **Ready**. Candidates `1.6.0` through `1.6.6` are superseded by startup, viewport, active-chat draft-loading, long-draft accessibility, spoken-punctuation, and proposal-review ownership fixes.
2. Open a chat that already has a non-empty saved draft, recording history, and glossary entries. Confirm all survive the upgrade exactly.
3. Open JarvisType from the icon-only composer-toolbar button. Confirm the floating workspace contains the draft and all routine composition controls.
4. Close the floating workspace. Confirm routine composition controls do not reappear in the drawer; the drawer still contains launch, connection/ownership diagnostics, context/model settings, and searchable glossary management.
5. Reopen from the composer-toolbar button and confirm draft text, paragraph IDs/order, history, proposal state if applicable, and glossary state are unchanged.
6. Open from the drawer action and then close. Confirm keyboard focus returns to that invoking action.
7. Reload Lumiverse and confirm the saved draft and glossary restore without a duplicate operation or message.
8. Create distinct saved drafts in two chats, switch between them in both directions, and confirm JarvisType automatically displays the active chat's own draft without using a manual switch action.
9. Repeat the switch immediately after typing and then switch rapidly across both chats. Confirm the final edit is preserved in its original chat and a stale load never replaces the currently active chat's draft.

### Test 2: Microphone privacy and terminal cleanup

**Status:** REMOTE-PASS — October 17, 2026, version `1.6.7` through commit `a40f0a8`

The hosted test confirmed textual recording state, cancellation without mutation, capture cleanup on floating-workspace close, edit-capture cleanup on chat switch, reload cleanup, safe microphone-permission revocation, absence of late transcript/proposal/segment/glossary mutations, and successful recording after permission restoration.

1. Start recording from a direct **Record Message** action and confirm the visible recording state includes text as well as styling.
2. Cancel during capture and confirm no proposal, segment, glossary entry, or draft mutation appears.
3. Repeat and close the floating workspace during capture. Confirm capture stops and no late transcript mutates the draft.
4. Repeat with **Record Edit**, permission revocation, chat switch, and page reload.
5. Confirm no microphone activity remains after each terminal path.

### Test 3: Provider, permission, and reconnect failures

**Status:** PASS — hosted recovery confirmed October 17, 2026; malformed-output and send-rejection paths verified by deterministic local injection

The hosted run confirmed denial and restoration of chat, chat-mutation, and generation permissions; unavailable normalization handling; preservation of the complete draft and open floating workspace; and an exactly-once successful retry after the connection was restored. The release UI intentionally exposes no control that can force Lumiverse to return malformed model output or reject an append. Automated backend injection therefore supplies those two cases and verifies structured-output rejection, draft retention, bounded `JT-...` diagnostic references, redacted logs, and retry-safe operation IDs.

1. Preserve a recognizable committed draft, then deny each requested permission in turn.
2. Exercise unavailable normalization connection, malformed interpreter response, and failed send.
3. Confirm every failure preserves the committed draft and provides an actionable message.
4. For unexpected provider/send failures, confirm the UI shows a `JT-...` diagnostic reference while logs omit transcript, draft, context, credential, and raw provider-error text.
5. Restore the dependency and confirm a safe retry succeeds once.

### Test 4: Adversarial content and schema isolation

**Status:** REMOTE-PASS — October 17, 2026, version `1.6.7` through commit `8118a5d`

The hosted test confirmed that embedded instructions to ignore rules, reveal secrets, send immediately, or replace the whole draft did not execute or leak into an unrelated message proposal. A quoted adversarial phrase in an edit instruction produced only the scoped allowlisted replacement; rejection left the draft unchanged, and approval applied only the displayed `pending` to `approved` diff.

1. Put instruction-like and tool-like text in chat context and the draft, including requests to ignore rules, reveal secrets, send immediately, or replace the entire draft.
2. Record an unrelated message and confirm none of those embedded instructions execute or leak into the proposal.
3. Record an edit quoting adversarial text and confirm only allowlisted operations appear.
4. Reject the proposal and confirm no mutation; approve a safe scoped proposal and confirm only its displayed diff applies.

### Test 5: Keyboard and screen-reader workflow

**Status:** PARTIAL â€” October 17, 2026, version `1.6.7` through commit `0b37965`. Hosted keyboard testing passed launcher focus, `Escape` close and focus restoration, draft editing, paragraph ordinals, forward and reverse navigation, message and edit recording, proposal rejection and acceptance, sentence-opening replacement casing, undo/redo, history, command search, glossary entry/search/undo, contained arrow-key scrolling, confirmation cancellation, exactly-once send, automatic close, and launcher-focus restoration. The user deliberately deferred the screen-reader announcement portion; it is not counted as passed.

1. Complete open, draft edit, record, stop, review, accept/reject, undo/redo, history, commands, glossary, and send using only the keyboard.
2. Confirm focus is visible, follows dialogs and proposals logically, and returns to the invoking launcher on close.
3. Confirm controls expose meaningful names, states, and disabled status; paragraph ordinals are associated with text but cannot enter the editor or sent message.
4. Confirm recording and errors are announced without relying on color or repeatedly announcing every interim token.

### Test 6: Responsive, zoom, contrast, and motion

**Status:** PARTIAL â€” October 18, 2026, version `1.6.7` through commit `3db91a7`. Desktop 200% zoom, increased font scaling, narrow/mobile layout, touch and pointer workspace scrolling, long-proposal action reachability, resize/reclamping, expandable tools, bounded long-draft rendering, non-overlapping paragraph text, visible paragraph focus, and independent pointer, touch, scrollbar, arrow, and page-key paragraph scrolling passed. The user deliberately deferred high-contrast/forced-colors and reduced-motion verification; those checks are not counted as passed.

1. Test desktop and narrow/mobile layouts at default size, 200% zoom, and increased font scaling.
2. Confirm every proposal action remains reachable by scrolling and sticky review actions do not obscure content.
3. With a long draft, confirm the numbered-paragraph box stops growing, scrolls independently with pointer, touch, and keyboard input, and retains a visible focus indicator.
4. Test high-contrast/forced-colors and reduced-motion preferences.
5. Confirm the icon-only launcher remains visible, named on hover/focus, and distinguishable from disabled controls.

### Test 7: Maximum-state performance

**Status:** REMOTE-PASS â€” October 18, 2026, version `1.6.7` through commit `1dd7f56`. A near-100,000-character draft passed launcher, typing, rendering, scrolling, recovery, size enforcement, cancellation, close, unload, and reload budgets. Debounced numbered-paragraph reconstruction passed its hosted retest. A temporary reversible fixture filled the glossary to 500 entries; search, scrolling, edit, delete, undo, recording, reload, and cleanup passed while personal entries remained intact, after which the fixture and protocol were removed. Fifty independently grouped history entries passed rendering, contained scrolling, ordering, truncation, undo, redo, redo invalidation, close/reopen, and reload checks. Maximum selected history passed bounded-context normalization: no more than two full recent messages were supplied, older selected messages contributed only bounded spelling and subject references, historical prose did not leak, and historical command-like wording did not activate commands.

1. Exercise a near-100,000-character draft with many paragraphs, maximum bounded context, a large glossary, and full retained history.
2. Measure launcher response, typing, draft mutation, diff creation, context construction, rendering, cancellation, and unload behavior separately from provider latency.
3. Confirm input remains responsive and all configured count/character ceilings are enforced before provider calls.

### Test 8: Exactly-once send and compatibility matrix

**Status:** IN PROGRESS â€” hosted desktop and mobile end-to-end capture, review, editing, send, automatic close, and cleanup passed on October 18, 2026. Rapid repeated **Confirm & Send** activation remained gated by Lumiverse confirmation and could not create multiple sends. The modal safely prevented a chat switch during confirmation. A manual reconnect race was deemed impractical because acknowledgement normally completes before network state can be changed; deterministic injection now holds acknowledgement open while a duplicate request arrives and verifies one append with repeatable successful acknowledgements.

1. On each supported desktop/browser/mobile target, confirm microphone capture, final transcript handling, review, editing, and send.
2. Double-activate **Confirm & Send**, switch chats during confirmation, delay acknowledgement, and reconnect during send.
3. Confirm one accepted operation creates exactly one clean message, never includes UI metadata, and clears only after confirmed success.
4. Confirm an uncertain outcome forces reconciliation before retry and a failed send retains the draft.

## Exit gate

**Result:** OPEN

- No critical or high-severity security, privacy, accessibility, data-loss, or duplicate-send defect remains.
- The safe-send sequence passes across the supported platform matrix.
- The package installs and completes the workflow on Lumiverse `1.2.5` or the documented newer minimum.
- All hosted groups are `REMOTE-PASS` or carry a deliberately accepted, documented limitation.
