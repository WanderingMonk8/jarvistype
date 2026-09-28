# JarvisType Product Requirements Document

- **Status:** Draft 0.1
- **Last updated:** 2026-08-30
- **Product:** JarvisType
- **Platform:** Lumiverse Spindle extension
**Document role:** Product source of truth

## 1. Purpose

JarvisType is a Lumiverse extension for composing chat messages by voice. It gives users a private working draft in which they can dictate a message over multiple recording sessions, correct it through separate spoken editing instructions, inspect the resulting changes, and explicitly approve the final text before it is added to the Lumiverse conversation.

This document defines the agreed product behavior. When implementation details, mockups, or tickets conflict with this document, this document takes precedence unless it is deliberately amended.

## 2. Problem statement

Conventional speech-to-text tools produce a single transcript with limited awareness of the conversation in which it will be used. They often struggle with proper nouns, domain-specific terms, homophones, explicit spelling, punctuation, and corrections to longer drafts. They also tend to require either manual keyboard editing or a complete re-recording when recognition is inaccurate.

JarvisType should make voice composition practical for complex Lumiverse messages by providing:

- Context-aware transcription using recent conversation history.
- Incremental composition across multiple recordings.
- Conversational editing through dedicated voice instructions.
- Precise paragraph and sentence references.
- Visible diffs, undo, and explicit final approval.
- A personal spelling glossary for preferred spellings, capitalization, pronunciation cues, and references.
- Explicit letter-by-letter spelling for difficult words.
- Referential disambiguation for homophones and other easily confused words.
- Reliable punctuation handling.

## 3. Product principles

1. **Nothing is sent without confirmation.** Recording, transcription, correction, and editing operate only on an unsent working draft.
2. **Preserve the user's words.** Context may correct recognition errors but must not silently paraphrase or expand the user's meaning.
3. **Separate content from commands.** Message dictation and editing instructions use different controls.
4. **Prefer constrained edits.** Editing operations modify only the requested text instead of regenerating the entire message.
5. **Make every automated change inspectable.** The current message, latest diff, and undo controls remain visible before sending.
6. **Fail without losing work.** Processing or send failures must preserve the draft and its recoverable history.
7. **Use context conservatively.** Recent messages improve recognition, but hard size limits control cost, latency, and privacy exposure.

## 4. Target user

The primary user is a Lumiverse user who prefers voice input or uses it alongside a keyboard, especially when composing long, detailed, or terminology-heavy messages.

Important use cases include:

- Drafting a long message in several short recordings.
- Correcting a misheard phrase without touching the keyboard.
- Inserting or moving content by referring to a numbered paragraph.
- Dictating punctuation explicitly.
- Teaching JarvisType the preferred spelling of an ordinary word, name, acronym, technical term, or fictional term.
- Spelling a word letter by letter when its written form matters.
- Correcting a homophone by naming the intended word and giving a familiar reference.

## 5. Scope

### 5.1 In scope

- A Lumiverse input-bar action that opens JarvisType.
- An extension-owned draft editor.
- Bounded microphone recording sessions initiated by the user.
- Sequential voice segments appended to one draft.
- Configurable recent-message context, defaulting to five messages.
- Progressive transcript display when the transcription provider supplies partial results.
- Separate voice recording for editing instructions.
- Structured parsing and validation of editing commands.
- Paragraph numbering for voice reference.
- Diff presentation and edit history.
- Undo for recorded additions and automated edits.
- Manual keyboard editing of the working draft.
- Automatic and explicitly dictated punctuation.
- Explicit letter-by-letter word spelling.
- Spoken capitalization transformations during editing.
- Referential disambiguation for names, homophones, homonyms, and near-homophones.
- A persistent per-user personal spelling glossary.
- Explicit confirmation before sending.
- Direct addition of the approved message to the active Lumiverse chat.

### 5.2 Out of scope for the initial product

- Always-on or continuously streaming microphone capture.
- Automatically sending a transcript when recording stops.
- Dependence on undocumented selectors in Lumiverse's native composer.
- Editing unrelated messages already present in chat history.
- Collaborative multi-user editing of one draft.
- Background recording while JarvisType is closed.
- Audio archival or a voice-note library.
- A dedicated **Record Insert** control. Location-specific insertion is initially handled through **Record Edit**.

## 6. Primary user experience

### 6.1 Entry and draft lifecycle

1. The user opens JarvisType from an action in the Lumiverse chat input bar.
2. JarvisType opens an extension-owned composition surface associated with the active chat.
3. The surface shows the current draft, paragraph numbers, recording controls, processing status, latest diff, undo controls, and **Confirm & Send**.
4. The draft remains unsent until the user explicitly selects **Confirm & Send**.
5. After Lumiverse confirms a successful send, JarvisType clears the submitted draft and its transient history.
6. If sending fails, JarvisType retains the full draft and permits retry.

### 6.2 Initial and sequential dictation

1. The user selects **Record Message**.
2. JarvisType records until the user stops the recording.
3. JarvisType submits the recording for transcription with the configured context.
4. Provisional transcription appears progressively if partial results are available.
5. When transcription completes, the new segment is committed to the end of the working draft.
6. Each subsequent use of **Record Message** repeats this process and appends another segment.

The user is not required to dictate a complete message in one session.

### 6.3 Conversational editing

1. The user selects **Record Edit**.
2. JarvisType records a bounded spoken instruction.
3. JarvisType transcribes the audio into an auditable instruction transcript that is never appended as message content.
4. A semantic command interpreter evaluates the natural-language instruction against the current draft and its stable paragraph identifiers.
5. JarvisType produces one or more constrained edit operations in the supported command schema.
6. A deterministic target resolver and validator verify the operations against the current draft version.
7. Only the deterministic patch engine applies validated operations to the draft.
8. High-confidence, unambiguous changes may be applied immediately and remain undoable.
9. Ambiguous or low-confidence changes are displayed as proposals and require approval.
10. The editor displays the instruction transcript, interpreted operation, complete updated draft, and latest diff.
11. The user may record further message segments, issue further edit instructions, type manually, undo, or send.

### 6.4 Confirmation and sending

1. The user reviews the current clean draft and any outstanding proposed change.
2. **Confirm & Send** is disabled while transcription, edit parsing, or an unresolved edit proposal is active.
3. On confirmation, JarvisType removes presentation-only data such as paragraph numbers and diff markers.
4. JarvisType adds the final text as a user message in the active Lumiverse chat.
5. The default send behavior starts the normal Lumiverse response-generation flow.

## 7. Functional requirements

### 7.1 Draft composition

**FR-DRAFT-001:** JarvisType shall maintain one working draft for the active composition session.

**FR-DRAFT-002:** Selecting **Record Message** shall always append the resulting committed transcription to the end of the working draft.

**FR-DRAFT-003:** JarvisType shall retain an internal ordered record of appended segments even though the user sees one continuous draft.

**FR-DRAFT-004:** The user shall be able to undo the most recently appended segment without removing older segments.

**FR-DRAFT-005:** JarvisType shall join appended segments using conservative whitespace handling:

- Preserve intentional leading or trailing line breaks.
- Do not duplicate whitespace at a segment boundary.
- Insert a single space when two non-whitespace boundaries would otherwise run together.
- Do not invent terminal punctuation.

**FR-DRAFT-006:** The user shall be able to edit the draft manually with a keyboard.

**FR-DRAFT-007:** A processing error shall not remove or replace previously committed draft text.

### 7.2 Context-aware transcription

**FR-CTX-001:** JarvisType shall use the five most recent eligible Lumiverse messages as transcription context by default.

**FR-CTX-002:** The user shall be able to configure the number of recent messages, including selecting zero.

**FR-CTX-003:** JarvisType shall enforce a hard token or character limit independently of the selected message count.

**FR-CTX-004:** Eligible context shall prioritize recent visible user and assistant text messages. Hidden messages and non-text payloads shall not be sent as transcription context.

**FR-CTX-005:** The current unsent draft shall be supplied as separate continuity context and shall not count against the configured recent-message number.

**FR-CTX-006:** The user's personal spelling glossary shall be supplied as vocabulary context independently of the recent-message number.

**FR-CTX-007:** Contextual correction shall preserve semantic fidelity and shall not intentionally paraphrase the transcript.

**FR-CTX-008:** The settings interface shall disclose when recent conversation content may be transmitted to the configured provider.

### 7.3 Transcription display

**FR-STT-001:** JarvisType shall visibly distinguish recording, uploading, transcribing, and completed states.

**FR-STT-002:** When the provider returns partial transcription results, JarvisType shall display them progressively as provisional text.

**FR-STT-003:** Provisional text shall not be treated as a committed segment until the transcription operation completes successfully.

**FR-STT-004:** If a provider returns only a completed transcript, JarvisType shall display the completed result without simulating streaming.

**FR-STT-005:** Only one message recording, edit recording, or related processing operation may be active at a time.

**FR-STT-006:** The user shall be able to cancel an active recording before submission.

### 7.4 Paragraph numbering

**FR-PARA-001:** JarvisType shall display a number for every non-empty paragraph in the current draft.

**FR-PARA-002:** Paragraph numbers shall be presentation-only and shall never be included in copied or submitted message text.

**FR-PARA-003:** Empty separator lines shall not receive paragraph numbers.

**FR-PARA-004:** Visible paragraph numbers shall be recalculated after an operation adds, deletes, moves, splits, or joins paragraphs.

**FR-PARA-005:** Each paragraph shall retain an internal stable identifier for the lifetime of the draft where technically possible.

**FR-PARA-006:** An editing instruction shall resolve ordinal references against the numbering visible when that instruction was submitted.

### 7.5 Conversational editing

**FR-EDIT-001:** **Record Edit** shall treat the resulting transcript exclusively as an instruction and shall not append it to the message.

**FR-EDIT-002:** The parser shall support references by:

- Paragraph number.
- Sentence position within a paragraph.
- Exact quoted text.
- Approximate quoted text when a single high-confidence match exists.
- Semantic description of a sentence or passage.
- Beginning or end of a paragraph or the complete message.

**FR-EDIT-003:** The initial supported operation set shall include:

- Replace text.
- Insert text.
- Delete text.
- Append or prepend text.
- Add a new paragraph.
- Split or join paragraphs.
- Move a paragraph.
- Change punctuation or capitalization.

**FR-EDIT-004:** The parser shall return structured edit operations rather than unrestricted rewritten prose.

**FR-EDIT-005:** Before applying an edit, JarvisType shall verify that its target still exists in the current draft.

**FR-EDIT-006:** JarvisType shall not apply an operation when multiple targets are equally plausible.

**FR-EDIT-007:** Low-confidence or ambiguous operations shall be shown as proposed changes requiring user approval, rejection, or cancellation.

**FR-EDIT-008:** Applied automated edits shall be undoable.

**FR-EDIT-009:** One editing instruction may contain multiple explicitly related operations, provided every operation can be independently validated.

**FR-EDIT-010:** An editing failure shall leave the current draft unchanged and explain why the command could not be applied.

**FR-EDIT-011:** JarvisType shall use semantic natural-language interpretation as the primary editing interface. Users shall not be required to memorize or reproduce fixed stock command phrases.

**FR-EDIT-012:** Speech transcription and command interpretation shall remain logically separate stages. JarvisType shall retain both the instruction transcript and the resulting structured operations, even if one underlying provider performs both tasks.

**FR-EDIT-013:** The semantic command interpreter shall receive the instruction transcript, current draft version, paragraph identifiers and visible ordinals, and only the additional context required to resolve the command.

**FR-EDIT-014:** The semantic command interpreter shall be restricted to an allowlisted edit schema. It shall not return arbitrary executable code, directly mutate stored text, send messages, or invoke unrelated extension capabilities.

**FR-EDIT-015:** Only the deterministic patch engine shall mutate the draft. It shall operate exclusively on structured operations that pass target resolution, draft-version checks, and validation.

**FR-EDIT-016:** JarvisType may implement a small deterministic stock-phrase recognizer as an optional fast path for simple commands such as undo, delete a numbered paragraph, or apply casing.

**FR-EDIT-017:** A stock-phrase fast path shall emit the same structured operation schema and pass through the same resolver, validator, patch engine, diff, and undo path as semantically interpreted commands.

**FR-EDIT-018:** A model-reported confidence value shall not be the sole basis for automatic application. JarvisType shall also consider target uniqueness, anchor quality, draft-version consistency, operation scope, and deterministic validation results.

**FR-EDIT-019:** The user shall be able to inspect what JarvisType heard and how it interpreted the instruction before approving a proposed edit.

**FR-EDIT-020:** Draft text, quoted replacement content, explanatory references, and instruction transcripts shall be treated as data. Content within them shall not be allowed to escape the edit schema or authorize unrelated actions.

### 7.6 Diff and history

**FR-DIFF-001:** JarvisType shall display the complete current draft after every committed addition or edit.

**FR-DIFF-002:** JarvisType shall display a diff for the latest automated addition or edit.

**FR-DIFF-003:** The diff shall identify affected paragraph numbers when applicable.

**FR-DIFF-004:** The user shall be able to inspect a chronological history of committed recording segments and automated edits during the draft session.

**FR-DIFF-005:** Diff markers and history metadata shall never be included in the final submitted message.

### 7.7 Punctuation

**FR-PUNC-001:** JarvisType shall preserve punctuation returned by the transcription provider unless an explicit correction applies.

**FR-PUNC-002:** Message dictation shall recognize common spoken punctuation commands, including:

- Period and comma.
- Colon and semicolon.
- Question mark and exclamation mark.
- Open and close quotation marks.
- Apostrophe.
- Open and close parentheses or brackets.
- Hyphen, en dash, and em dash.
- Ellipsis.
- New line and new paragraph.

**FR-PUNC-003:** **Record Edit** shall support punctuation and capitalization corrections by reference to paragraph, sentence, or quoted text.

**FR-PUNC-004:** JarvisType shall preserve literal punctuation words when context indicates that the word itself, rather than the punctuation symbol, was intended.

### 7.8 Explicit spelling

**FR-SPELL-001:** During **Record Message**, JarvisType shall recognize an explicitly separated sequence of spoken letters as the spelling of one intended word.

**FR-SPELL-002:** JarvisType shall accept common letter-separation forms, including individually spoken letters, pauses between letters, and spoken separators such as "dash" or "hyphen."

**FR-SPELL-003:** A whole-word rendition immediately following a spelled sequence may be treated as a pronunciation or confirmation cue for the same token rather than duplicate message content. For example, "C-A-E-S-A-R, Caesar" shall produce one occurrence of `Caesar` when the interpretation is unambiguous.

**FR-SPELL-004:** JarvisType shall support explicit casing instructions such as "capital C," "all caps," and "lowercase." When casing is not specified, it may infer conventional casing from sentence position, the spoken whole-word cue, glossary data, and conversational context.

**FR-SPELL-005:** Explicitly supplied letters shall take precedence over competing phonetic transcription, contextual correction, and glossary spelling for that occurrence.

**FR-SPELL-006:** If the letter sequence, intended casing, separator, or boundary between spelling metadata and message content is ambiguous, JarvisType shall present the interpreted token for confirmation before committing it.

**FR-SPELL-007:** **Record Edit** shall support replacing existing text with an explicitly spelled word using the same rules.

**FR-SPELL-008:** After an explicitly spelled token is committed through either **Record Message** or **Record Edit**, JarvisType shall automatically add or update that token in the user's personal spelling glossary.

**FR-SPELL-009:** JarvisType shall not learn from provisional streaming text, cancelled recordings, rejected edit proposals, failed operations, or interpretations awaiting confirmation.

**FR-SPELL-010:** A learned entry shall become available to subsequent transcription and correction requests immediately, including later recordings in the same draft session.

**FR-SPELL-011:** Automatic learning shall upsert an existing matching entry rather than create a duplicate. JarvisType may update usage count, last-used time, and newly observed spoken or recognized variants.

**FR-SPELL-012:** Automatic learning shall preserve the committed canonical spelling, capitalization, and hyphenation. A trailing whole-word rendition or explicit reference may be stored as a pronunciation or disambiguation cue when present.

**FR-SPELL-013:** If an automatically learned spelling conflicts with an existing canonical entry or alias, JarvisType shall not silently overwrite either entry. It shall ask the user whether to keep both, replace the existing mapping, or cancel the new glossary change.

**FR-SPELL-014:** After automatic learning, JarvisType shall display a reversible notification such as `Added "Caesar" to your glossary — Undo`.

**FR-SPELL-015:** Undoing an automatic glossary update shall restore the glossary to its prior state without undoing the associated draft content.

### 7.9 Capitalization editing commands

**FR-CASE-001:** **Record Edit** shall recognize explicit capitalization commands that target a uniquely identifiable word, phrase, sentence, paragraph, or the complete draft.

**FR-CASE-002:** The initial capitalization command set shall include:

- **Capitalize**: uppercase the first alphabetic character of the targeted word while preserving the remaining characters unless the user supplies an explicit replacement.
- **All caps** or **uppercase**: convert all cased letters in the target to uppercase.
- **Lowercase**: convert all cased letters in the target to lowercase.

**FR-CASE-003:** JarvisType shall accept natural variants such as "make it all caps," "put that in uppercase," "change this to lower case," and "capitalize Caesar."

**FR-CASE-004:** Capitalization commands shall use the same targeting methods as other editing commands, including paragraph number, sentence position, exact quoted text, approximate unique text, and semantic reference.

**FR-CASE-005:** A capitalization transformation shall preserve the target's punctuation, whitespace, paragraph position, and non-letter characters.

**FR-CASE-006:** JarvisType shall show the capitalization change in the latest diff and make it undoable.

**FR-CASE-007:** If the target or requested capitalization scope is ambiguous, JarvisType shall present the proposed interpretation for confirmation and leave the draft unchanged until confirmed.

**FR-CASE-008:** Explicitly dictated casing and explicit capitalization edit commands shall take precedence over automatic casing inferred from context or a glossary for that occurrence.

### 7.10 Personal spelling glossary and referential disambiguation

**FR-GLOSS-001:** JarvisType shall provide a persistent, per-user personal spelling glossary for ordinary words, proper nouns, acronyms, technical terms, fictional terms, and other user-defined vocabulary.

**FR-GLOSS-002:** A glossary entry shall support:

- Canonical spelling.
- Preferred capitalization and hyphenation.
- Spoken, phonetic, or transcription variants when available.
- Optional explanatory hint or reference.
- Entry source, such as explicit spelling or manual creation.
- Usage metadata sufficient for deduplication and maintenance.

**FR-GLOSS-003:** JarvisType shall use glossary entries during transcription and contextual correction.

**FR-GLOSS-004:** JarvisType shall support explanatory speech that disambiguates a term without necessarily inserting the explanation into the final message.

**FR-GLOSS-005:** When it is unclear whether an explanation is intended content or metadata, JarvisType shall request confirmation rather than silently remove it.

**FR-GLOSS-006:** The user shall be able to inspect, add, edit, delete, and undo automatic changes to glossary entries.

**FR-REF-001:** JarvisType shall support one-time explanatory references for any intended word or phrase, not only proper nouns.

**FR-REF-002:** Referential disambiguation shall support homophones, homonyms, near-homophones, names, and other phonetically confusable terms.

**FR-REF-003:** During **Record Edit**, the user may identify the existing phrase, state the intended replacement, and provide a reference. For example: "In the sentence where I say 'can the worker,' I meant 'Ken the worker,' as in Barbie and Ken."

**FR-REF-004:** When the command is unambiguous, JarvisType shall apply only the intended lexical replacement. The explanatory reference shall not be inserted into the draft unless the user explicitly asks to include it.

**FR-REF-005:** A one-time reference shall remain session-scoped by default. JarvisType shall persist it in the user's glossary only after an explicit request to remember it.

**FR-REF-006:** If the reference does not resolve the intended spelling or target uniquely, JarvisType shall present the proposed interpretation for confirmation and leave the draft unchanged until confirmed.

### 7.11 Sending

**FR-SEND-001:** JarvisType shall not add any draft content to the Lumiverse chat before explicit user confirmation.

**FR-SEND-002:** JarvisType shall prevent duplicate submission when the user activates the send control more than once.

**FR-SEND-003:** The submitted content shall contain only the clean draft text.

**FR-SEND-004:** The initial default behavior shall add the content as a user message and trigger the normal Lumiverse response flow.

**FR-SEND-005:** JarvisType shall clear the submitted draft only after receiving confirmation that the message was successfully added.

**FR-SEND-006:** If submission fails, JarvisType shall retain the draft, history, and ability to retry.

**FR-SEND-007:** JarvisType shall warn the user if the active chat changes while a non-empty draft is open and shall not silently send the draft to a different chat.

## 8. Editing command model

The editing subsystem uses the following logical pipeline:

```text
Editing audio
  -> Speech transcription
  -> Auditable instruction transcript
  -> Semantic command interpreter
  -> Allowlisted structured operations
  -> Deterministic target resolver
  -> Draft-version and operation validator
  -> Deterministic patch engine
  -> Updated draft, diff, and undo record
```

A stock-phrase recognizer may bypass the semantic interpreter for a small set of exact, simple commands, but it must rejoin the pipeline at the structured-operation boundary. It must not maintain a separate text-mutation path.

The semantic interpreter supplies flexibility in how users phrase commands. The structured schema, resolver, validator, and patch engine supply predictability and safety. The model is never the component that directly changes draft text.

The exact schema may change during implementation, but this editing boundary must remain structured. A representative interpretation is:

```json
{
  "instructionTranscript": "In the second paragraph, where I talk about hiking, change coughing up a stomp to coughing up a storm.",
  "draftVersion": 7,
  "operations": [
    {
      "operation": "replace",
      "target": {
        "paragraphId": "paragraph-2",
        "paragraphNumberAtRequest": 2,
        "semanticReference": "the passage about hiking",
        "exactText": "coughing up a stomp"
      },
      "replacement": "coughing up a storm"
    }
  ]
}
```

Validation must confirm that:

- The referenced draft version is still current or can be safely rebased.
- The paragraph still exists.
- The target text or range resolves uniquely.
- The replacement does not affect text outside the requested range.
- Every operation belongs to the allowlisted command schema.
- Multiple operations are independently valid and have no unintended overlap.
- The operation produces a valid new draft.

Model confidence may be recorded as diagnostic input, but it cannot substitute for these checks. The original instruction transcript, draft version, interpreted operations, validation result, resulting draft version, and diff should be retained in transient history for undo and inspection.

## 9. Draft representation

The implementation should conceptually maintain:

```text
DraftSession
  chatId
  draftVersion
  cleanText
  paragraphs[]
    stableId
    currentOrdinal
    text
  recordedSegments[]
    id
    transcript
    timestamp
    resultingDraftVersion
  operations[]
    id
    instructionTranscript
    structuredPatch
    beforeVersion
    afterVersion
    status
  latestDiff
  processingState
```

This is a behavioral model, not a mandated storage schema.

## 10. Interface requirements

The primary surface must contain:

- A numbered, editable draft.
- **Record Message** and recording-stop/cancel controls.
- **Record Edit** and recording-stop/cancel controls.
- A visible recording and processing indicator.
- A provisional transcript area or provisional styling.
- The latest editing-instruction transcript and its interpreted operation.
- A latest-change diff.
- Approve/reject controls for proposed edits.
- Undo for committed voice additions and automated edits.
- Access to edit history.
- **Confirm & Send**.
- A clear indication of which Lumiverse chat owns the draft.

The UI must remain usable with keyboard and pointer input and expose appropriate accessible labels for all recording and editing controls.

## 11. State model

The composition surface follows these primary states:

```text
Ready
  -> Recording Message
  -> Transcribing Message
  -> Applying Addition
  -> Ready

Ready
  -> Recording Edit
  -> Transcribing Instruction
  -> Interpreting Intent
  -> Resolving Targets
  -> Validating Patch
  -> Applying Edit | Awaiting Edit Approval
  -> Ready

Ready
  -> Sending
  -> Sent | Send Failed
```

Only valid actions for the current state should be enabled. The draft remains readable during processing but should not accept conflicting automated operations.

## 12. Lumiverse integration requirements

JarvisType is expected to use the following Spindle capabilities:

- Input-bar action for opening JarvisType.
- An extension-owned drawer, panel, widget, or modal for composition.
- Frontend browser microphone capture.
- Frontend-to-backend messaging for recordings, partial results, status, and draft operations.
- `spindle.chats.getActive()` for active-chat identification.
- `spindle.chat.getMessages(chatId)` for recent context.
- `spindle.chat.appendMessage(...)` for confirmed submission.
- Secure Enclave for external API credentials.
- User-scoped storage for settings and the personal spelling glossary.
- Lumiverse generation APIs if the configured Lumiverse LLM performs edit parsing.
- The CORS proxy if transcription or editing uses an external compatible endpoint.

Expected gated permissions are:

- `chats`
- `chat_mutation`
- `generation` when Lumiverse generation is used for edit parsing or correction, and when **Confirm & Send** triggers the normal Lumiverse response-generation flow
- `cors_proxy` when an external service is used
- `ui_panels` if the selected UI placement requires it
- `media` only if server-side audio conversion is required

JarvisType shall degrade with a clear explanation when a required permission is unavailable or revoked.

## 13. Privacy and data handling

**PRIV-001:** Microphone access shall begin only after a direct user action and browser permission grant.

**PRIV-002:** JarvisType shall display an obvious recording indicator while the microphone is active.

**PRIV-003:** Recorded audio shall be retained only as long as required to complete transcription and retry recoverable failures.

**PRIV-004:** Staged uploads and temporary audio shall be deleted promptly after processing or explicit cancellation.

**PRIV-005:** External API credentials shall be stored only in Lumiverse's encrypted Secure Enclave.

**PRIV-006:** JarvisType shall disclose which provider receives audio, recent-message context, glossary terms, and editing instructions.

**PRIV-007:** The extension shall not log raw audio, complete message context, API keys, or full private drafts in normal operational logs.

**PRIV-008:** Personal spelling glossary entries and preferences shall be isolated per user.

## 14. Reliability and error handling

JarvisType must handle:

- Microphone permission denial.
- No usable audio input device.
- Empty or silent recordings.
- Recording cancellation.
- Upload failure or timeout.
- Transcription-provider failure.
- Missing partial-result support.
- Speech-transcription failure for an editing instruction.
- Semantic-interpreter failure or malformed operations.
- A stock-phrase fast path that cannot resolve its target.
- An edit target that changed before application.
- Ambiguous paragraph or sentence references.
- Active-chat changes during composition.
- Revoked Lumiverse permissions.
- Lumiverse submission failure.
- Extension reload or frontend/backend reconnection.

In all recoverable cases, previously committed draft content must remain available.

## 15. Non-functional requirements

### 15.1 Performance

- Recording controls should react immediately to user input.
- Partial transcription should be rendered as soon as the provider supplies it.
- Draft updates and diffs should render without perceptible delay after an operation is validated.
- Context construction must respect the configured count and hard size ceiling before any provider request is made.

### 15.2 Accessibility

- All functionality must be operable without a mouse.
- Recording status must not rely on color alone.
- Dynamic transcription and error states should be announced through suitable live regions without reading every interim token excessively.
- Paragraph numbers must be visually and semantically associated with their paragraphs but excluded from editable and submitted text.

### 15.3 Compatibility

- Microphone capture must be tested in the Lumiverse-supported browser, desktop, and mobile environments selected for release.
- Audio recording should use a supported format negotiated from the browser rather than assuming one container or codec.
- Provider-specific transcription behavior must be isolated behind an adapter boundary.

## 16. Success measures

Initial product evaluation should measure:

- Percentage of drafts sent without manual keyboard correction.
- Average number of voice edits per completed draft.
- Percentage of edit commands applied successfully on the first attempt.
- Rate of ambiguous edits requiring confirmation.
- Undo rate after automatically applied edits.
- Transcription and edit-processing latency.
- Send failure and duplicate-send rates.
- Recognition improvement after a personal spelling glossary entry is added.
- Automatic glossary-learning success and conflict rates.
- First-attempt accuracy for explicitly spelled words.
- First-attempt success rate for referential disambiguation edits.
- Draft abandonment rate.

No analytics collection is implied by this section; any telemetry implementation must be separately approved and disclosed.

## 17. Acceptance scenarios

### Scenario A: Sequential composition

1. The user records “We reached the mountain shortly before sunset.”
2. JarvisType commits it as the first segment.
3. The user records “The trail was much steeper than expected.”
4. JarvisType appends the second segment without removing or rewriting the first.
5. The editor displays one combined draft and retains two undoable segment records.

### Scenario B: Paragraph-targeted correction

1. The draft contains at least three numbered paragraphs.
2. The user records an edit: “In paragraph two, replace steeper with more difficult.”
3. JarvisType uniquely resolves paragraph two and the target word.
4. Only that word is replaced.
5. The latest diff identifies paragraph two and shows the before and after text.

### Scenario C: Paragraph insertion

1. The user records an edit: “Add a new paragraph after paragraph two saying we stopped there to rest.”
2. JarvisType inserts the requested text after the paragraph currently displayed as number two.
3. Paragraphs are renumbered.
4. The numbering is not present in the clean draft sent to Lumiverse.

### Scenario D: Ambiguous semantic edit

1. Two paragraphs contain sentences about hiking.
2. The user requests: “Change the sentence about hiking.”
3. JarvisType does not choose silently.
4. The UI presents the possible targets or asks the user to refine the instruction.
5. The draft remains unchanged until the ambiguity is resolved.

### Scenario E: Personal glossary recognition

1. The glossary contains `Pip-Boy` with the hint “wrist-mounted device from Fallout.”
2. The user dictates a sentence containing a pronunciation recognized initially as “pip boy.”
3. JarvisType uses the glossary to produce `Pip-Boy` in the committed segment.
4. The surrounding sentence is otherwise preserved.

### Scenario F: Explicitly spelled word

1. The user dictates: "We named him C-A-E-S-A-R, Caesar."
2. JarvisType recognizes the separated letters as the authoritative spelling of one word.
3. The trailing whole-word rendition is treated as a pronunciation cue rather than duplicate content.
4. The committed sentence reads: "We named him Caesar."
5. JarvisType automatically upserts `Caesar` in the user's personal spelling glossary.
6. JarvisType displays a notification that lets the user undo the glossary update independently of the draft addition.
7. A later recording can use the new glossary entry immediately.

### Scenario G: Referential homophone correction

1. The draft contains the phrase `can the worker`.
2. The user records an edit: "In the sentence where I say 'can the worker,' I meant 'Ken the worker,' as in Barbie and Ken."
3. JarvisType uses the reference to resolve `Ken` as the intended spelling.
4. Only `can the worker` is replaced with `Ken the worker`.
5. The words `as in Barbie and Ken` are not inserted into the draft.
6. The correction remains session-scoped unless the user explicitly asks JarvisType to remember it.

### Scenario H: Capitalization edit

1. The draft contains `We contacted nasa after the launch.`
2. The user records an edit: "In the first sentence, make NASA all caps."
3. JarvisType uniquely resolves `nasa` as the target and transforms it to `NASA`.
4. The resulting sentence reads `We contacted NASA after the launch.`
5. The latest diff shows only the casing change, and the operation can be undone.

### Scenario I: Safe sending

1. The user has an unsent numbered draft and visible diff.
2. No message appears in Lumiverse before **Confirm & Send** is selected.
3. After confirmation, Lumiverse receives only the clean draft.
4. On success, JarvisType clears the draft.
5. On failure, JarvisType retains the draft for retry.

## 18. Open product decisions

The following decisions remain open and must be resolved through deliberate PRD updates:

1. Initial transcription provider and credential model.
2. Supported audio formats and whether host-side conversion is required.
3. Whether edit parsing uses the user's configured Lumiverse LLM or a dedicated service.
4. Primary composition placement: drawer, docked panel, floating widget, or modal.
5. Minimum and maximum values for the recent-message context setting.
6. The hard context token or character ceiling.
7. Exact confidence thresholds for automatic application and proposed edits.
8. Draft persistence behavior across refreshes, extension restarts, and chat switches.
9. Whether an optional send-without-generation action is included.
10. Languages supported in the initial release.
11. Whether **Record Insert** is added in a future release.
12. Whether optional, privacy-preserving product telemetry will be implemented.

## 19. Known platform constraints and risks

- Lumiverse does not currently document a public API for setting the unsent native chat-composer draft. JarvisType therefore uses its own editing surface and submits only after approval.
- The documented Lumiverse CORS proxy uses a string request body. Transcription providers that require binary multipart uploads may need a compatible JSON/base64 endpoint, a JarvisType relay, or future Lumiverse proxy support.
- The documented Lumiverse CORS proxy does not expose an incremental response-stream contract. Genuine partial transcription therefore requires a separately verified provider-to-extension transport rather than an assumption that the CORS proxy can relay streaming results.
- Browser microphone access depends on secure-context behavior, user permission, and the runtime environment. Compatibility must be validated before release commitments are made.
- Progressive display depends on the selected provider returning partial results. Batch-only providers cannot supply genuine interim recognition.
- Semantic editing can be probabilistic. Structured operations, target validation, confidence gating, diffs, and undo are mandatory safeguards.

## 20. Lumiverse documentation references

- [Spindle Extension Developer Guide](https://docs.lumiverse.chat/)
- [Permissions](https://docs.lumiverse.chat/getting-started/permissions/)
- [Chats API](https://docs.lumiverse.chat/backend-api/chats/)
- [Chat Mutation API](https://docs.lumiverse.chat/backend-api/chat-mutation/)
- [Generation API](https://docs.lumiverse.chat/backend-api/generation/)
- [Secure Enclave](https://docs.lumiverse.chat/backend-api/secure-enclave/)
- [CORS Proxy](https://docs.lumiverse.chat/backend-api/cors-proxy/)
- [Uploads API](https://docs.lumiverse.chat/backend-api/uploads/)
- [UI Placement API](https://docs.lumiverse.chat/frontend-api/ui-placement/)
- [Shared Components](https://docs.lumiverse.chat/frontend-api/shared-components/)
- [Frontend-to-Backend Communication](https://docs.lumiverse.chat/frontend-api/backend-communication/)
