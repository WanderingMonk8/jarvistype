# Phase 2 Validation Register

## Scope

Phase 2 implements the complete manual draft lifecycle before voice recording: chat ownership, persistence, paragraph numbering and identity, manual editing, diff, history, undo, confirmed sending, duplicate suppression, and failure retention.

Current candidate version: `0.8.0`

## Persistence decision

- The backend stores one draft per Lumiverse user and owning chat through `spindle.userStorage`.
- Drafts survive page reloads and extension restarts until a confirmed successful send.
- A synchronous, tab-scoped buffer protects the most recent unsaved keystrokes during an immediate reload; the buffer is reconciled into the backend draft on startup.
- Switching chats never changes a draft's owner. The UI warns, blocks sending, and lets the user open the active chat's separate draft.
- Exact expiry and explicit discard UX remain future product decisions.

## Implemented baseline

| ID    | Requirement                                | Status      | Evidence                                                                                                                          |
| ----- | ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| F2-01 | Canonical chat-owned draft and persistence | LOCAL-PASS  | Backend domain session is stored per user/chat; a bounded synchronous frontend recovery buffer covers immediate reloads.          |
| F2-02 | Versioned mutations and stale rejection    | LOCAL-PASS  | Every committed edit and undo increments the version; stale expected versions are rejected and reconciled.                        |
| F2-03 | Numbering and blank separators             | LOCAL-PASS  | Tests verify only non-empty lines receive ordinals while exact clean text and blank lines remain intact.                          |
| F2-04 | Stable paragraph identity                  | LOCAL-PASS  | LCS anchors plus aligned unmatched regions retain IDs through text edits and structural insertion where meaningful.               |
| F2-05 | Manual editing, diff, history, and undo    | LOCAL-PASS  | Native textarea behavior supplies keyboard/selection/clipboard support; grouped history, latest diff, and undo are domain tested. |
| F2-06 | Clean-text isolation                       | LOCAL-PASS  | Paragraph numbers, diff markers, history, IDs, and versions exist outside `cleanText`; mocked send asserts exact clean content.   |
| F2-07 | Chat mismatch protection                   | LOCAL-PASS  | Frontend blocks mismatched sends and backend independently verifies `spindle.chats.getActive()` before append.                    |
| F2-08 | Duplicate-safe confirmed send              | LOCAL-PASS  | UI locks the send flow; backend operation IDs deduplicate repeated requests; mocked test confirms one append.                     |
| F2-09 | Success clearing and failure retention     | LOCAL-PASS  | Successful append clears storage only after a message ID; rejected append returns the unchanged snapshot for retry.               |
| F2-10 | Default normal generation                  | LOCAL-PASS  | Mocked send verifies `triggerGeneration: true` and reports whether Lumiverse returned a generation ID.                            |
| F2-11 | Automated quality gate                     | LOCAL-PASS  | Formatting, lint, strict typing, 16 tests, builds, package validation, and CI pass.                                               |
| F2-12 | Hosted Lumiverse verification              | REMOTE-PASS | All six hosted test groups passed on Lumiverse 1.2.5 on 2026-10-14.                                                               |

## Hosted verification sequence

### Test 1: Installation and draft structure

**Status:** REMOTE-PASS — 2026-10-14

Verified on the hosted Lumiverse installation: version and connection readiness, matching chat ownership, saved editable draft, numbering of three non-empty paragraphs, an unnumbered blank separator, and clean copied text without ordinals or metadata.

1. Update from `development` and verify JarvisType `0.8.0`.
2. Open a disposable chat and open JarvisType.
3. Confirm backend readiness, matching active/draft-owner chat IDs, and the enabled working-draft editor.
4. Type three non-empty paragraphs with a blank line between the first and second.
5. Confirm the numbered preview shows `1`, `2`, and `3`, while the blank separator has no number.
6. Copy from the editor and confirm the clipboard contains only typed text and line breaks—no ordinals or metadata.

### Test 2: Diff, history, and undo

**Status:** REMOTE-PASS — 2026-10-14

Verified on the hosted Lumiverse installation: a paragraph-2 edit produced version 2 and an accurate insertion diff, history showed the versioned manual edits, and one undo restored the original paragraph text while preserving numbering.

1. Change text in one paragraph and wait for **Saved**.
2. Confirm the latest-change panel reports the affected paragraph and shows removed/added text.
3. Open history and confirm chronological version entries appear.
4. Select **Undo** and confirm the latest grouped manual edit reverses, numbering recalculates, and the version increments.

### Test 3: Persistence and recovery

**Status:** REMOTE-PASS — 2026-10-14

Verified on the hosted Lumiverse installation: normal reload and extension disable/re-enable restored the complete saved draft, numbering, history, and undo state. The user accepted the immediate-reload recovery path as passed because autosave completed too quickly to create a reproducible observable pre-save window.

1. Enter distinctive unsent text and confirm **Saved**.
2. Reload Lumiverse and confirm the same chat restores the draft, paragraph numbers, history, and undo availability.
3. Add a few characters and reload immediately; confirm the tab-scoped recovery buffer restores them and then reports **Saved**.
4. Disable and re-enable JarvisType and confirm the saved draft returns.

### Test 4: Chat ownership isolation

**Status:** REMOTE-PASS — 2026-10-14

Verified on the hosted Lumiverse installation: switching chats produced the ownership mismatch guard and disabled sending, opening the active chat loaded an independent draft, and returning to each chat restored only its own saved content.

1. Keep a non-empty draft in chat A and switch to chat B.
2. Confirm JarvisType warns that the active chat differs and disables **Confirm & Send**.
3. Select **Open active chat's draft** and confirm chat B has an independent draft.
4. Return to chat A and confirm its original draft is unchanged.

### Test 5: Confirmed clean send

**Status:** REMOTE-PASS — 2026-10-14

Verified on the hosted Lumiverse installation: the disposable chat accepted exactly one confirmed user message containing only the clean textarea content, normal response generation began, duplicate activation did not add another message, and the draft cleared only after success.

1. Use a disposable chat and review the exact clean draft. Confirm no message has appeared before sending.
2. Select **Confirm & Send**, grant `chats`, `chat_mutation`, and `generation` if requested, and approve the confirmation modal.
3. Attempt a rapid second activation and confirm only one user message is added.
4. Confirm the message contains exactly the textarea text—no paragraph numbers, diff, or history metadata.
5. Confirm normal Lumiverse response generation starts.
6. Confirm JarvisType clears the submitted draft only after success.

### Test 6: Layout and lifecycle regression

**Status:** REMOTE-PASS — 2026-10-14

Verified on the hosted Lumiverse installation: the narrow layout contained long draft, diff, and history content; editing and review controls remained usable; repeated reload and disable/re-enable cycles restored the draft without duplicate UI or event behavior.

1. Repeat the narrowest-drawer check with long paragraphs, diff, and expanded history.
2. Confirm keyboard editing, selection, copy/paste, Undo, Show/Hide History, and Confirm & Send are reachable.
3. Reload twice and disable/re-enable twice; confirm no duplicate UI or handlers appear.

## Exit gate

**PASSED — 2026-10-14.** A user can type, edit, review, restore, and send exactly one clean message without paragraph numbers or recoverable draft loss. Phase 2 is complete.
