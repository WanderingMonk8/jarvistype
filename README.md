# JarvisType

JarvisType is a planned [Lumiverse](https://lumiverse.chat/) extension for composing chat messages by voice. It provides a private working draft where users can dictate a message in multiple recordings, make corrections through separate spoken editing commands, inspect every change, and approve the final text before it is sent.

> **Project status:** Specification stage. The product requirements are defined; implementation has not started.

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
- Secure Enclave storage for external provider credentials.
- User-scoped storage for settings and personal spelling glossary entries.

The exact transcription provider, editor placement, context ceiling, supported languages, and draft-persistence policy remain open product decisions documented in the PRD.

## Contributing

Development conventions and build instructions will be added with the initial project scaffold. Until then, proposed product changes should begin with an update to `PRD.md` so implementation and documentation remain aligned.
