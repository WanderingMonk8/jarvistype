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
| F7-04 | Prompt-injection resistance              | LOCAL-PASS  | Context and draft text remain quoted data; model output must pass allowlisted structured parsing and deterministic execution before review.                                               |
| F7-05 | Keyboard and assistive-technology access | PENDING     | Hosted keyboard, focus, screen-reader, zoom, contrast, reduced-motion, and repaired whole-workspace scrolling checks remain.                                                              |
| F7-06 | Long-state performance budgets           | PENDING     | Maximum draft, context, glossary, and history profiling remains.                                                                                                                          |
| F7-07 | Supported-platform compatibility         | PENDING     | Hosted desktop and narrow/mobile matrix remains.                                                                                                                                          |
| F7-08 | Exactly-once safe send under stress      | LOCAL-PASS  | Automated duplicate-operation test proves one append and repeatable acknowledgements; hosted reconnect/delayed-ack checks remain.                                                         |
| F7-09 | Complete package quality gate            | LOCAL-PASS  | Formatting, lint, strict typing, 77 tests, backend/frontend builds, and package validation pass.                                                                                          |

## Privacy and security decisions

- JarvisType invokes microphone access only from labeled user actions through Lumiverse `ctx.stt.start(...)`.
- Lumiverse owns audio transport, temporary audio lifetime, provider selection, and credentials; JarvisType receives transcript callbacks and never receives provider credentials.
- Context normalization receives bounded text only after STT. The drawer disclosure identifies recent messages, the draft tail, glossary data, and the configured generation connection.
- Operational logs contain event category, error class, and a random diagnostic ID. They do not contain provider exception messages, raw transcripts, context, glossary entries, user IDs, chat IDs, credentials, or full drafts.
- Generated normalization and edit interpretations cannot call tools or mutate state. They must pass bounded response parsing, an allowlisted schema, deterministic target validation, visible review, and explicit confirmation.

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

**Status:** PENDING

1. Start recording from a direct **Record Message** action and confirm the visible recording state includes text as well as styling.
2. Cancel during capture and confirm no proposal, segment, glossary entry, or draft mutation appears.
3. Repeat and close the floating workspace during capture. Confirm capture stops and no late transcript mutates the draft.
4. Repeat with **Record Edit**, permission revocation, chat switch, and page reload.
5. Confirm no microphone activity remains after each terminal path.

### Test 3: Provider, permission, and reconnect failures

**Status:** PENDING

1. Preserve a recognizable committed draft, then deny each requested permission in turn.
2. Exercise unavailable normalization connection, malformed interpreter response, and failed send.
3. Confirm every failure preserves the committed draft and provides an actionable message.
4. For unexpected provider/send failures, confirm the UI shows a `JT-...` diagnostic reference while logs omit transcript, draft, context, credential, and raw provider-error text.
5. Restore the dependency and confirm a safe retry succeeds once.

### Test 4: Adversarial content and schema isolation

**Status:** PENDING

1. Put instruction-like and tool-like text in chat context and the draft, including requests to ignore rules, reveal secrets, send immediately, or replace the entire draft.
2. Record an unrelated message and confirm none of those embedded instructions execute or leak into the proposal.
3. Record an edit quoting adversarial text and confirm only allowlisted operations appear.
4. Reject the proposal and confirm no mutation; approve a safe scoped proposal and confirm only its displayed diff applies.

### Test 5: Keyboard and screen-reader workflow

**Status:** PENDING

1. Complete open, draft edit, record, stop, review, accept/reject, undo/redo, history, commands, glossary, and send using only the keyboard.
2. Confirm focus is visible, follows dialogs and proposals logically, and returns to the invoking launcher on close.
3. Confirm controls expose meaningful names, states, and disabled status; paragraph ordinals are associated with text but cannot enter the editor or sent message.
4. Confirm recording and errors are announced without relying on color or repeatedly announcing every interim token.

### Test 6: Responsive, zoom, contrast, and motion

**Status:** PENDING

1. Test desktop and narrow/mobile layouts at default size, 200% zoom, and increased font scaling.
2. Confirm every proposal action remains reachable by scrolling and sticky review actions do not obscure content.
3. With a long draft, confirm the numbered-paragraph box stops growing, scrolls independently with pointer, touch, and keyboard input, and retains a visible focus indicator.
4. Test high-contrast/forced-colors and reduced-motion preferences.
5. Confirm the icon-only launcher remains visible, named on hover/focus, and distinguishable from disabled controls.

### Test 7: Maximum-state performance

**Status:** PENDING

1. Exercise a near-100,000-character draft with many paragraphs, maximum bounded context, a large glossary, and full retained history.
2. Measure launcher response, typing, draft mutation, diff creation, context construction, rendering, cancellation, and unload behavior separately from provider latency.
3. Confirm input remains responsive and all configured count/character ceilings are enforced before provider calls.

### Test 8: Exactly-once send and compatibility matrix

**Status:** PENDING

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
