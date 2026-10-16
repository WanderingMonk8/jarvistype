# Phase 4 Validation Register

## Scope

Phase 4 adds bounded post-transcription context normalization, spoken punctuation, explicit spelling and casing, per-user glossary learning and maintenance, visible review, and reversible glossary changes.

Current candidate version: `1.2.0`

## Platform decision

- Lumiverse `ctx.stt.start(...)` remains the authoritative audio and transcript path. JarvisType never receives raw audio or provider credentials.
- The verified STT contract has no context or vocabulary-hint input. JarvisType therefore applies context after STT through Main or a user-selected Lumiverse generation connection. The normalization model receives text, never audio.
- Lumiverse supplies redacted connection metadata only; credentials remain host-owned. Its connection-aware model combobox searches and refreshes the selected text connection's host-managed model catalog. An optional selection overrides the connection's configured model for normalization only.
- Recent chat context includes only eligible visible user/assistant text. The setting defaults to five, accepts zero, is capped at twenty messages, and is independently capped at 12,000 characters using newest-first retention.
- Current draft continuity and glossary entries are supplied separately and do not consume the configured message count.
- Deterministic spelling, punctuation, casing, and glossary rules run before optional contextual correction.
- Any candidate that differs from the raw provider transcript requires visible user confirmation. Rejecting or cancelling changes neither the draft nor glossary.
- Raw and normalized transcripts are retained separately in recording-segment metadata. Logs contain neither transcript nor context values.

## Implemented baseline

| ID    | Requirement                            | Status     | Evidence                                                                                                                  |
| ----- | -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| F4-01 | Configurable bounded context           | LOCAL-PASS | Unit tests cover default five, zero, maximum clamping, eligibility, ordering, and hard-character truncation.              |
| F4-02 | Conservative post-STT normalization    | LOCAL-PASS | Backend preserves raw text, validates model output, falls back safely, and routes every changed result through review.    |
| F4-03 | Spoken punctuation and literal wording | LOCAL-PASS | Deterministic tests cover punctuation, paragraph breaks, and explicit `literal`/`the word` escape wording.                |
| F4-04 | Explicit spelling and casing           | LOCAL-PASS | Tests cover separated letters, pronunciation cue collapse, casing, and learning-candidate creation.                       |
| F4-05 | Personal glossary lifecycle            | LOCAL-PASS | Per-user storage supports inspect, add, edit, delete, conflicts, usage metadata, and undo.                                |
| F4-06 | Commit-only automatic learning         | LOCAL-PASS | Backend test proves an explicit spelling is absent before confirmation and learned only after the confirmed draft commit. |
| F4-07 | Visible and reversible changes         | LOCAL-PASS | Review card shows raw/candidate/context details; learned-entry notice points to independent glossary undo.                |
| F4-08 | Draft and chat safety                  | LOCAL-PASS | Version and active-chat checks guard normalization and confirmation; rejection leaves the draft unchanged.                |
| F4-09 | Privacy disclosure                     | LOCAL-PASS | Drawer states exactly which data goes to Lumiverse generation and that STT receives no added context.                     |
| F4-10 | Searchable normalization dispatch      | LOCAL-PASS | Settings use Lumiverse's connection-aware searchable model picker and pass the selected connection ID and model override. |
| F4-11 | Automated quality gate                 | LOCAL-PASS | Formatting, lint, strict typing, 36 unit tests, both builds, and package validation pass.                                 |
| F4-12 | Hosted Lumiverse verification          | PENDING    | Run the sequence below on the hosted installation.                                                                        |

## Hosted verification sequence

### Test 1: Upgrade, migration, settings, and disclosure

**Status:** REMOTE-PASS — 2026-10-16

Verified on the hosted Lumiverse installation: version `1.0.0` loaded successfully, the Phase 3 draft state migrated intact, the context/glossary controls and post-STT disclosure were present, and context-count values `0` and `5` both persisted across reloads.

1. Update the extension from `development` and verify the current candidate loads with backend status **Ready**.
2. Open a chat with an existing Phase 3 draft. Confirm its exact text, paragraph numbering, history, and recording segment count still load.
3. Find **Context and glossary** and confirm the recent-message value is `5` and bounded context normalization is enabled.
4. Read the disclosure and confirm it says recent chat text, the draft tail, and glossary go to the configured Lumiverse generation connection after STT; it must not claim context is sent to STT.
5. Set recent messages to `0`, save, reload JarvisType, and confirm `0` persists. Restore `5`, save, reload, and confirm `5` persists.

### Test 2: Spoken punctuation and literal wording

**Status:** REMOTE-PASS — 2026-10-16

Verified on the hosted Lumiverse installation. Part A normalized spoken punctuation and the paragraph break correctly, displayed review, and committed the accepted segment once. Part B initially exposed timeout, hidden-state, and contextual-override defects; after the `1.0.2` fixes, JarvisType preserved the provider transcript `Use the word period here, period.`, proposed `Use period here.`, enabled both review actions, and rejected the segment without committing it.

1. Start with an empty disposable draft.
2. Record: “Hello comma world question mark new paragraph Next period”.
3. Stop and confirm a review card appears with the unchanged raw provider transcript and the punctuated proposed text.
4. Accept and confirm the draft contains `Hello, world?`, a blank paragraph break, then `Next.`.
5. Record: “Use the word period here period”. Confirm the proposal preserves the first `period` literally and converts the final command to `.`.
6. Reject this second proposal and confirm draft version, text, segment count, and glossary remain unchanged.

### Test 3: Normalization connection and searchable model

**Status:** REMOTE-PASS — 2026-10-16

Verified on the hosted Lumiverse installation: accessible text connections were listed without credentials, the host-managed model control searched and refreshed the selected connection's catalog, the connection and model persisted across reload, normalization completed with the selected override, and clearing the override returned to the connection's configured model. The accepted test segment appended exactly once.

1. Confirm the disclosure states that normalization receives text rather than audio.
2. Open **Normalization connection** and confirm it lists Main plus the accessible Lumiverse connection profiles without displaying credentials or API URLs.
3. Select a non-Main text connection. Confirm the model control clears and rebinds to that connection.
4. Record a punctuation phrase and confirm normalization completes through the selected connection.
5. Open the model control, search for a model known to be available on that connection, and select it. Confirm the list can be refreshed without JarvisType requesting an API key or showing credentials.
6. Save, reload, and confirm both the connection and selected model persist.
7. Record another punctuation phrase and confirm normalization completes with the override.
8. Clear the selected model, save, and confirm JarvisType returns to the selected connection's configured model.

### Test 4: Explicit spelling, casing, and automatic learning

1. Record: “Write capitalized C-A-E-S-A-R Caesar period”.
2. Confirm the proposal contains exactly one `Caesar` for the spelled occurrence and does not duplicate the pronunciation cue.
3. Before accepting, inspect the glossary and confirm `Caesar` is absent.
4. Accept the proposal. Confirm the text appends once and a visible notice says `Caesar` was learned and can be undone.
5. Confirm the glossary contains canonical `Caesar`, its spoken spelling variant, source/usage behavior, and no duplicate entry.
6. Repeat the spelling, accept it, and confirm the same entry is reused rather than duplicated.

### Test 5: Casing and hyphenation variants

1. Record and review an all-caps spelling such as “all caps N-A-S-A”. Confirm the candidate uses `NASA`.
2. Record and review a lowercase spelling such as “lowercase C-A-T”. Confirm the candidate uses `cat`.
3. Record “P-I-P dash B-O-Y Pip-Boy”. Confirm the pronunciation cue yields one correctly hyphenated `Pip-Boy`.
4. Reject one proposal and confirm its term is not learned; accept the others and confirm only accepted terms appear in the glossary.

### Test 6: Context behavior and safety

1. In a disposable chat, create recent messages containing an unusual proper noun, then record a sentence where the provider plausibly misrecognizes that name.
2. Confirm the review card reports no more than the configured number of context messages and identifies whether contextual model correction was used through its change reasons.
3. Confirm no proposed change is appended until accepted.
4. Reject the proposal and verify the draft and glossary remain unchanged.
5. Set the context count to `0`, repeat, and confirm the review metadata reports `0` context messages. Draft continuity and glossary substitution should still remain available.
6. Include instruction-like text in chat history and confirm it is not followed as an instruction or added to the transcript.

### Test 7: Manual glossary management, conflict, and undo

1. Add canonical `Pip-Boy`, variants `pip boy, Pipboy`, and hint `Fallout wrist device`.
2. Reload and confirm the entry persists.
3. Edit its hint and confirm the same entry updates rather than duplicates.
4. Attempt to add canonical `Pipboy`; confirm a conflict is shown and the existing entry is not overwritten.
5. Delete `Pip-Boy`, confirm it disappears, then select **Undo glossary change** and confirm it returns without changing the draft.
6. Record a phrase containing `pip boy`; confirm the proposed text uses `Pip-Boy`, then reject it and confirm the glossary itself remains unchanged.

### Test 8: Ownership, cancellation, failure, and regression

1. Begin a recording and cancel it. Confirm no proposal, draft mutation, or learned entry appears.
2. Produce a review proposal, switch chats before accepting, and confirm the proposal is discarded and cannot mutate either chat.
3. Temporarily deny generation permission or make the configured generation connection unavailable. Confirm normalization fails safely and preserves the draft and glossary.
4. Restore access and confirm recording works again.
5. Confirm Undo Last Recording, manual draft editing, draft undo/history, chat ownership blocking, and Confirm & Send still behave as in Phases 2–3.

## Exit gate

- All eight hosted groups are marked `REMOTE-PASS` or carry an explicitly accepted limitation.
- No tested normalization path silently changes meaning.
- Rejected, cancelled, failed, and unresolved spelling never enters the glossary.
- Every automatic glossary change is visible and independently reversible.
