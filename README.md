# JarvisType

JarvisType is a planned [Lumiverse](https://lumiverse.chat/) extension for composing chat messages by voice. It provides a private working draft where users can dictate a message in multiple recordings, make corrections through separate spoken editing commands, inspect every change, and approve the final text before it is sent.

> **Project status:** Phase 0 feasibility validation. The product requirements are defined, and the `development` branch contains a permission-free Lumiverse capability probe for remote testing.

## What JarvisType is designed to do

- Use recent Lumiverse messages to improve transcription accuracy.
- Build one message progressively across multiple recordings.
- Append each new **Record Message** transcription to the current draft.
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
Record Message ----> Append transcription to working draft
      |                              |
      +------------------------------+
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

The [Phase 0 Validation Register](./PHASE0-VALIDATION.md) records documentation-settled facts, remote test cases, expected results, and evidence still required before Phase 1.

The [Lumiverse STT API Proposal](./LUMIVERSE-STT-API-PROPOSAL.md) defines the host capability needed to reuse a user's configured STT connection without exposing or duplicating credentials.

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
- A host-managed STT invocation API that reuses the user's configured connection without exposing credentials.
- User-scoped storage for settings and personal spelling glossary entries.

The exact transcription provider, editor placement, context ceiling, supported languages, and draft-persistence policy remain open product decisions documented in the PRD.

## Phase 0 remote capability probe

The current `development` branch builds an installable diagnostic extension. It does not transcribe audio yet. It verifies the platform path that transcription will depend on:

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
- Forward-compatible conformance testing for the proposed `stt-invocation-v1` API.
- Sanitized JSON evidence export.

The probe installs without gated Lumiverse permissions, does not read or modify chats, and does not read connection identifiers or credentials. It requests the proposed `stt` permission only after detecting `stt-invocation-v1` and the user explicitly starts a transcription test. Recorded audio is not retained after the page or extension is unloaded, and a completed conformance upload is deleted by the backend in `finally`.

### Build verification

```bash
npm ci
npm test
```

The compiled `dist/backend.js` and `dist/frontend.js` files are committed so the VPS can install the branch without relying on its extension builder.

### Remote test procedure

1. Install or update the extension from the `development` branch using the VPS deployment workflow.
2. Enable **JarvisType Phase 0 Probe**. It should request no gated permissions.
3. Open **JarvisType Probe** from the chat input-bar Extras menu. Confirm that **Input-action activations** and **Drawer activations** increase once, then open the same drawer through `Ctrl+K` and confirm only the drawer count increases.
4. Reload Lumiverse. Confirm there is exactly one JarvisType sidebar entry, one Extras action, one command-palette result, and **Active probe instances** is `1`.
5. Confirm that the backend and frontend Lumiverse versions appear in **Host and lifecycle**.
6. Select **Start recording**, grant microphone permission, speak briefly, and select **Stop and keep sample**. Confirm the sample is non-empty and **Tracks stopped** reports **Yes**.
7. Select **Upload and verify sample**. Confirm the final status says the bytes matched and staged-upload deletion was confirmed.
8. Repeat once with **Cancel recording** and once with **Cancel upload**.
9. Start a recording and, while it is active, reload the page or disable then re-enable the extension. Reopen the probe and confirm a cleanup receipt has `recordingWasActive: true`, `tracksStopped: true`, and `passed: true`.
10. Select **Start paced teardown upload** and immediately reload or disable/re-enable the extension while its percentage is still advancing. Confirm a cleanup receipt has `uploadWasActive: true`, `uploadAbortRequested: true`, and `passed: true`. Any interrupted partial upload expires under Lumiverse's staged-upload policy.
11. Make the drawer as narrow as the host permits, select **Run UI self-check**, and confirm it passes with no horizontal overflow. Then use only `Tab`, `Shift+Tab`, `Enter`, and `Space` to reach and operate each enabled control.
12. Select **Inspect host STT surface**. This inspects API names and capability flags only; it does not send audio or invoke the configured provider.
13. Record the displayed conclusion. **Candidate STT invocation API found** means the exported report contains one or more callable candidate paths. **Only provider-registration surfaces were found** means the host lets extensions supply an STT engine but exposes no callable route to the user's configured engine.
14. Select **Check proposed API**. On Lumiverse 1.2.4, confirm it reports capability version `0`, lists the five missing methods, and does not show a permission prompt.
15. On a host implementing the proposal, record yourself saying “JarvisType uses a Pip-Boy,” select **Check proposed API**, and then select **Grant permission and transcribe sample**. Approve only the `stt` permission.
16. Confirm genuine partials appear incrementally when supported, the final transcript is authoritative, applied/unsupported features are reported, and staged-upload deletion is confirmed. The visible transcript is not included verbatim in exported JSON.
17. Repeat with a longer sample and select **Cancel STT test** after provider processing starts. Confirm the result is aborted, no late text is accepted, and upload deletion is confirmed.
18. Select **Download JSON** and retain the resulting evidence file. It contains environment and result metadata, cleanup booleans, counters, sanitized API names, and transcript length/hash, but no audio, transcript text, connection identifiers, settings, or credentials.

Do not post the complete JSON report publicly without reviewing its `origin` and `userAgent` fields. Neither field is a credential, but both describe the test environment.

## Contributing

Proposed product changes should begin with an update to `PRD.md` so implementation and documentation remain aligned. Phase 0 implementation evidence belongs in `PHASE0-VALIDATION.md`.
