# JarvisType Project Roadmap

- **Status:** Draft 0.1
- **Last updated:** 2026-08-30
- **Branch:** `development`
- **Authority:** Execution plan derived from `PRD.md`

## 1. Purpose

This roadmap converts the [JarvisType Product Requirements Document](./PRD.md) into implementation phases with explicit scope, specifications, dependencies, deliverables, verification requirements, and exit gates.

The PRD remains the product source of truth. This roadmap governs sequencing and delivery only. Product behavior must be changed in the PRD before the corresponding roadmap scope changes.

Phases are ordered by dependency rather than date. Estimates will be added after Phase 0 resolves the provider, UI, persistence, platform, and language decisions that materially affect implementation effort.

## 2. Delivery principles

1. Each phase must produce a testable increment.
2. Unsent text stays isolated from Lumiverse chat until explicit confirmation.
3. Raw inputs, normalized text, and interpreted commands remain distinguishable.
4. A language model may interpret commands but may never mutate the draft directly.
5. Every automated edit uses the structured schema, resolver, validator, deterministic patch engine, diff, and undo pipeline.
6. Permissions, privacy, accessibility, cleanup, and recovery are functional requirements.
7. Documentation and requirement traceability change with implementation behavior.
8. A phase cannot close with an unresolved critical defect or unmet exit criterion.

## 3. Release checkpoints

| Checkpoint | Completion | User-visible result |
| --- | --- | --- |
| Technical foundation | Phase 1 | Installable extension shell with frontend/backend communication |
| Drafting foundation | Phase 2 | Numbered editor and manual confirmed send |
| Voice MVP | Phase 3 | Record, transcribe, append sequentially, review, and send |
| Context-aware alpha | Phase 4 | Chat context, punctuation, explicit spelling, and personal glossary |
| Editing alpha | Phase 5 | Natural-language editing through validated structured patches |
| Feature-complete beta | Phase 6 | Advanced targeting, references, casing, paragraph operations, and multi-edit support |
| Release candidate | Phase 7 | Accessible, private, resilient, compatible, and performance-tested build |
| General availability | Phase 8 | Validated beta, packaged release, migrations, and support documentation |

## 4. Stable technical boundaries

### Frontend

- Own the JarvisType composition surface.
- Request and visibly indicate microphone access.
- Record bounded audio sessions.
- Display provisional and committed transcription states.
- Render paragraph numbers, draft text, diffs, proposals, history, and errors.
- Collect explicit confirmation before sending.
- Communicate with the backend through typed, versioned messages.

### Backend

- Resolve the active chat and eligible context messages.
- Read and write user-scoped settings and glossary entries.
- Store provider credentials only through Lumiverse Secure Enclave.
- Coordinate transcription, normalization, and semantic-interpretation adapters.
- Enforce request limits, operation schemas, and permissions.
- Submit only confirmed clean text to Lumiverse.
- Delete temporary audio and uploads promptly.

### Draft engine

- Maintain the canonical unsent draft and monotonically increasing draft version.
- Maintain stable paragraph identifiers and visible ordinals.
- Track recorded segments and automated edit operations.
- Resolve targets and validate structured operations before mutation.
- Produce diffs and reversible history records.
- Reject stale, overlapping, ambiguous, or unsupported operations safely.

### Provider adapters

- Hide provider-specific request and response formats.
- Report genuine partial-transcription support.
- Accept bounded context and glossary vocabulary.
- Normalize provider failures into typed errors.
- Keep message transcription and edit-instruction transcription logically distinct.
- Permit provider replacement without changing the draft or editing engine.

## 5. Global definition of done

A phase is complete only when:

- Implementation and tests are integrated into `development`.
- All phase acceptance tests pass.
- Type checking, linting, formatting, tests, and production build pass.
- New frontend/backend messages are typed and documented.
- Permission denial and dependency failures have user-facing behavior.
- No known critical or high-severity security or data-loss defect remains.
- Temporary data cleanup is verified wherever audio or uploads are handled.
- Relevant PRD IDs are recorded in traceability.
- README, roadmap, and user documentation match implemented behavior.
- Manual Lumiverse verification evidence is recorded where automation is impractical.

---

## Phase 0: Decisions and feasibility spikes

### Objective

Resolve open decisions and platform risks that could invalidate the architecture before production implementation.

### Prerequisites

- PRD approved as the baseline.
- A supported Lumiverse development installation.
- Candidate transcription and language-model providers.

### Detailed specifications

#### UI placement

- Prototype drawer, docked panel, floating widget, or modal placements that remain viable after documentation review.
- Verify long drafts, paragraph gutter, diff view, history, recording controls, mobile sizing, focus, and accessibility.
- Select one primary placement, one fallback if necessary, and the minimum Lumiverse version.

#### Microphone and audio

- Verify `getUserMedia` and `MediaRecorder` on intended browser, desktop, and mobile targets.
- Record available MIME types and codecs.
- Test stop, cancel, permission denial, absent device, silence, route change, and extension unload.
- Test backgrounding, tab suspension, device disconnection, corrupt or zero-byte output, and repeated stop/cancel actions.
- Confirm that every media track closes on every terminal path.
- Set maximum recording duration, encoded size, provider timeout, upload timeout, and retry limits.
- Determine whether server-side conversion is needed.

#### Audio transport

- Test Lumiverse staged upload using a programmatically created recording file.
- Verify user/extension isolation, authentication, size limits, retry, expiry, and deletion.
- Test the selected provider against CORS proxy body constraints.
- Verify the end-to-end path for genuine partial results, including ordering, cancellation, late-result rejection, and final-result reconciliation.
- Keep audio bytes out of ordinary frontend/backend JSON messages; only upload identifiers and bounded metadata may cross that channel.
- If multipart or streaming is unsupported, choose a compatible endpoint, JarvisType relay, or upstream requirement.

#### Provider selection

- Compare STT accuracy, punctuation, context prompts, vocabulary hints, partial results, latency, cost, formats, languages, retention, and transport compatibility.
- Verify that partial output is genuine and not simulated.
- Select an initial provider and define a replaceable adapter contract.
- Define credential ownership and relay requirements.

#### Semantic interpreter

- Evaluate free-form simple, semantic, referential, casing, structural, and multi-operation edits.
- Compare the configured Lumiverse model with a dedicated service.
- Verify reliable structured output and typed unable-to-interpret behavior.
- Retain transcript and structured operations separately even if one service performs both tasks.

#### Product decisions

- Set context-setting minimum and maximum while preserving default `5`.
- Set hard context ceiling and truncation policy.
- Decide draft behavior across refresh, reconnect, restart, and chat switch.
- Decide initial languages and unsupported-language behavior.
- Decide whether send-without-generation ships initially.

#### Privacy and security

- Document whether each provider receives audio, chat context, draft, glossary, and edit instructions.
- Document retention expectations and deletion flow.
- Threat-model instructions embedded in draft text, quoted replacements, references, and transcripts.
- Define logging redaction.

### Deliverables

- Architecture decisions for UI, STT, semantic interpreter, context, persistence, languages, and send modes.
- Audio/platform compatibility matrix.
- Completed `PHASE0-VALIDATION.md` evidence register.
- Provider comparison and selected adapter contracts.
- Audio transport prototype and findings.
- Security/privacy data-flow diagram.
- PRD updated to close resolved open decisions.

### Verification

- A real recording reaches the selected provider through the proposed production transport.
- A transcript appears in an extension-owned Lumiverse surface.
- Partial text is proven to originate from the provider and reach the frontend incrementally, or the provider is explicitly classified as batch-only.
- Cancelling recording or processing stops local capture, transport, and acceptance of late results.
- A free-form edit produces a structured operation without changing the draft directly.
- The staged upload is retrieved only by the owning extension/user and is explicitly deleted after the test.
- Temporary spike audio is deleted.
- Target-platform limitations are explicitly documented.

### Exit gate

- No unresolved blocker remains for capture, transport, transcription, semantic interpretation, or UI placement.
- Every decision has a written owner and outcome.
- Supported-platform matrix and minimum Lumiverse version are approved.

---

## Phase 1: Extension foundation and development infrastructure

### Objective

Create an installable Spindle extension shell with dependable frontend/backend lifecycle management and an enforceable quality baseline.

### Dependencies

- Phase 0 UI and minimum-version decisions.

### Detailed specifications

#### Project scaffold

- Add TypeScript frontend, backend, shared types, domain, and test directories.
- Add `spindle.json` with justified permissions and version metadata.
- Configure separate browser and Bun builds.
- Add build, typecheck, lint, format, test, and package scripts.
- Add ignore files, editor settings, contribution guidance, and developer setup.

#### Typed protocol

- Define discriminated messages with protocol version, request ID, operation ID where applicable, and typed success/error responses.
- Validate both directions and reject malformed messages.
- Prevent stale responses from updating newer requests or draft versions.
- Define cancellation and timeout messages before audio features arrive.

#### Lifecycle

- Register frontend readiness before replayed backend messages are handled.
- Clean up UI handles, events, timers, pending requests, media handles, and object URLs.
- Handle reconnect without duplicate listeners or actions.
- Show a recoverable unavailable state when the backend is not ready.

#### Permissions

- Request only Phase 0 justified permissions.
- Check startup and per-operation permission state.
- React to live grants and revocations.
- Explain missing permissions and preserve independent functionality.

#### Composition shell

- Register the input-bar action and selected composition surface.
- Render disabled placeholders for **Record Message**, **Record Edit**, undo, history, and **Confirm & Send**.
- Show active chat and frontend/backend readiness.

#### Quality pipeline

- Add domain unit tests, frontend tests where feasible, mocked Spindle backend tests, and CI.
- Verify clean install, typecheck, tests, build, and manifest entry files.

### Deliverables

- Installable extension shell and typed protocol.
- Lifecycle and permission services.
- Composition UI skeleton.
- Automated quality pipeline and developer documentation.

### Verification

- Extension installs and opens from the Lumiverse input bar.
- Frontend/backend exchange a typed health request.
- Reload and reconnect do not duplicate UI or handlers.
- Permission revocation updates UI without restart.
- Clean checkout passes all scripts.

### Exit gate

- Technical-foundation checkpoint works on supported targets.
- No feature depends on undocumented native-composer selectors.
- Unload cleans all registered resources.

---

## Phase 2: Draft editor, paragraphs, history, and safe send

### Objective

Implement the complete extension-owned draft lifecycle before voice input, proving privacy, recovery, paragraph identity, and confirmed submission.

### PRD coverage

- `FR-DRAFT-001`, `FR-DRAFT-003`, `FR-DRAFT-004`, `FR-DRAFT-006`, `FR-DRAFT-007`
- `FR-PARA-001` through `FR-PARA-006`
- `FR-DIFF-001`, `FR-DIFF-004`, `FR-DIFF-005`
- `FR-SEND-001` through `FR-SEND-007`

### Detailed specifications

#### Draft session

- Key a draft session to its owning chat.
- Maintain clean text, draft version, stable paragraph IDs, ordinals, history, send state, and dirty state.
- Increment the version on every committed mutation, including undo.
- Serialize and restore according to Phase 0 decisions.
- Never attach a restored draft silently to a different chat.

#### Numbered editor

- Number non-empty paragraphs outside editable text.
- Preserve unnumbered blank separators.
- Recalculate ordinals after insertion, deletion, split, join, or move.
- Retain stable IDs where paragraph identity remains meaningful.
- Keep caret and selection stable during presentation updates.

#### Manual editing and history

- Support keyboard editing, selection, and clipboard operations.
- Capture versioned history sufficient for recovery.
- Implement latest-mutation undo and an inspectable chronological history.
- Ensure clean-text extraction excludes numbers and history metadata.

#### Confirmed send

- Lock and verify the owning active chat.
- Strip all presentation and internal metadata.
- Guard against duplicate activation with an idempotency mechanism.
- Add exactly one user message only after **Confirm & Send**.
- Trigger normal Lumiverse generation by default.
- Clear only after confirmed success; retain on failure.
- Warn and block on active-chat mismatch.

### Deliverables

- Canonical draft-domain module.
- Numbered editable UI, history, and undo.
- Persistence behavior and manual confirmed-send flow.

### Tests

- Numbering with blanks and multiline text.
- Stable IDs through manual structural changes.
- Version increments and stale mutation rejection.
- Clean extraction excludes ordinals.
- Duplicate-send prevention.
- Success clears; failure retains.
- Chat mismatch blocks.
- Persistence and restoration follow the decision record.

### Exit gate

- A user can type, edit, review, and send exactly one clean message.
- No tested recoverable failure loses the draft.
- Paragraph numbers never enter sent content.

---

## Phase 3: Voice recording, transcription, and sequential composition MVP

### Objective

Deliver bounded recording, genuine progressive display where supported, ordered sequential append, review, undo, and confirmed send.

### PRD coverage

- `FR-DRAFT-002`, `FR-DRAFT-005`
- `FR-STT-001` through `FR-STT-006`
- Initial `PRIV-001` through `PRIV-004`

### Detailed specifications

#### Microphone controller

- Start only from **Record Message** after direct action and permission.
- Show an unmistakable status and elapsed time.
- Provide stop and cancel.
- Stop every media track on stop, cancel, close, route change, and unload.
- Detect denial, missing device, recorder error, and unusable audio.
- Forbid simultaneous recordings.

#### Upload and cleanup

- Create a provider-supported recording file.
- Keep provider credentials out of frontend code.
- Show meaningful progress and bounded retry.
- Prevent duplicate transcription on retry.
- Delete uploads and release browser resources on every terminal path.

#### STT adapter

- Return genuine provisional events when available, a final transcript, useful metadata, and typed errors.
- Enforce size and duration limits.
- Avoid exposing raw provider details in logs or normal UI.

#### Progressive display

- Style provisional text distinctly.
- Replace it with the final transcript without duplication.
- Commit nothing on failure or cancellation.
- Do not simulate partial results for batch-only providers.

#### Sequential append

- Append each successful final transcript to the draft end.
- Preserve newlines and conservative boundary whitespace.
- Record segment ID, raw transcript, timestamp, and resulting version.
- Disable conflicting automated actions during processing.
- Implement **Undo Last Recording**.

### Deliverables

- Microphone and upload controllers.
- Initial STT adapter.
- Provisional/final transcript UI.
- Sequential append and segment undo.
- Complete voice MVP flow.

### Tests

- Legal and illegal recording transitions.
- Cancellation before and during processing.
- Partial-to-final replacement without duplication.
- Batch-only behavior.
- Ordered appends under delayed responses.
- Boundary whitespace and newlines.
- Segment-only undo.
- Cleanup on every terminal path.

### Exit gate

- Two recordings append in order and send as one clean message.
- Cancellation adds no text.
- No media stream or temporary upload survives completion or cancellation.

---

## Phase 4: Context, normalization, punctuation, spelling, and glossary

### Objective

Improve recognition using bounded chat context, draft continuity, spoken punctuation, explicit spelling, and an immediately learned personal vocabulary.

### PRD coverage

- `FR-CTX-001` through `FR-CTX-008`
- `FR-PUNC-001` through `FR-PUNC-004`
- `FR-SPELL-001` through `FR-SPELL-015`
- `FR-GLOSS-001` through `FR-GLOSS-006`

### Detailed specifications

#### Context builder

- Add a context-count setting with default `5`, approved bounds, and `0` support.
- Select newest eligible visible user/assistant text messages.
- Exclude hidden, non-text, and disallowed messages.
- Enforce the hard ceiling before the provider call using a documented newest-first truncation policy.
- Supply draft continuity and glossary vocabulary separately from message count.

#### Conservative normalization

- Preserve raw transcript separately.
- Produce a normalized candidate limited to recognition, punctuation, spelling, casing, and glossary corrections.
- Prohibit paraphrase, summarization, embellishment, or meaning change.
- Require review when raw-to-normalized difference exceeds an approved threshold.

#### Punctuation

- Implement all PRD spoken punctuation marks and breaks.
- Distinguish commands from literal punctuation words; confirm ambiguous cases.
- Preserve ordinary provider punctuation unless explicitly overridden.

#### Explicit spelling

- Recognize separated letters, pauses, and spoken separators.
- Treat a following whole word as a pronunciation cue when unambiguous.
- Support capitalization, all caps, lowercase, and hyphenation.
- Give explicit letters precedence for that occurrence.
- Confirm uncertain sequences, case, separator, or content boundary.

#### Personal spelling glossary

- Store canonical spelling, casing, hyphenation, variants, optional reference, source, and maintenance metadata per user.
- Auto-upsert committed spelling from message or edit mode.
- Never learn provisional, cancelled, rejected, failed, or unresolved input.
- Make entries available immediately.
- Avoid duplicates and surface conflicts rather than overwrite.
- Show an independent reversible notification.
- Provide inspect, add, edit, delete, and undo UI.

#### Privacy

- Disclose whether context and glossary terms go to the provider.
- Store credentials in Secure Enclave.
- Redact context, drafts, glossary values, and secrets from normal logs.

### Deliverables

- Settings and bounded context builder.
- Conservative normalization pipeline.
- Punctuation and spelling interpreters.
- Personal glossary storage, management, learning, conflicts, and undo.

### Tests

- Default exactly five; `0`; maximum; hidden/non-text exclusions.
- Hard-limit truncation preserves ordering.
- Raw transcript remains unchanged.
- Punctuation command versus literal word.
- `C-A-E-S-A-R, Caesar` produces one `Caesar`.
- Explicit casing and hyphenation.
- Cancelled spelling is not learned.
- Repeated spelling deduplicates.
- Conflicts preserve existing entries.
- Glossary undo leaves draft intact.

### Exit gate

- PRD glossary and spelling scenarios pass end to end.
- No known normalization case silently changes meaning.
- Every automatic glossary change is visible and reversible.

---

## Phase 5: Semantic editing and deterministic patch pipeline

### Objective

Deliver flexible natural-language editing while allowing only resolved, validated, allowlisted operations to mutate the draft.

### PRD coverage

- `FR-EDIT-001` through `FR-EDIT-020`
- `FR-DIFF-001` through `FR-DIFF-005`
- Basic `FR-CASE-001` through `FR-CASE-008`

### Detailed specifications

#### Edit recording

- Reuse bounded recording under separate **Record Edit** state.
- Ensure the transcript can never append as content.
- Display and retain the instruction transcript.
- Permit safe retry without losing draft state.

#### Structured schema

- Version a closed schema for replace, insert, delete, append, prepend, and casing.
- Require draft version, operation ID, target, payload, and interpreter metadata.
- Reject unknown types and malformed fields.
- Bound operation count, lengths, and nesting.
- Treat quoted content and instructions strictly as data.

#### Semantic interpreter

- Make natural language the primary interface; require no memorized stock syntax.
- Provide minimal draft and paragraph context.
- Produce operations, not rewritten full-draft prose.
- Separate command, target, literal payload, and explanation.
- Return typed inability rather than inventing an edit.

#### Optional fast path

- Limit deterministic stock phrases to reviewed simple commands.
- Emit the same schema and use the same downstream pipeline.
- Fall back to semantic interpretation when exact matching fails.
- Never destructively accept a partial stock-phrase match.

#### Resolver

- Resolve captured paragraph IDs/ordinals, sentence positions, unique exact text, and bounded approximate matches.
- Return zero, one, or multiple candidates with evidence.
- Never silently choose between equal candidates.

#### Validator and patch engine

- Check schema, draft version, existence, uniqueness, bounds, overlap, and compatibility.
- Apply edits in a deterministic pure domain module.
- Permit no provider, send, storage, secret, or unrelated calls from the patch engine.
- Produce a new version, affected paragraph IDs, diff data, and undo record.
- Leave draft unchanged on failed atomic validation.

#### Proposal UI

- Show transcript, interpreted operation, affected paragraph, and before/after text.
- Allow automatic application only under approved narrow criteria.
- Require approval for ambiguous, semantic, broad, or stale-rebased operations.
- Support approve, reject, cancel, and undo.
- Disable send while a proposal is unresolved.

### Initial operation scope

- Exact replace in a specified paragraph.
- Insert before/after a unique anchor.
- Delete a unique target.
- Append/prepend to a specified paragraph.
- Capitalize, uppercase, and lowercase a unique explicit target.
- Undo latest applied edit.

### Deliverables

- Edit transcription flow and structured schema.
- Semantic interpreter adapter.
- Resolver, validator, deterministic patch engine.
- Diff/proposal/approval/undo UI.
- Security tests for data/command isolation.

### Tests

- Schema accepts supported and rejects unknown/oversized input.
- Instruction transcript never appends implicitly.
- Unique targets succeed; missing/duplicate targets do not mutate.
- Stale versions reject or require safe proposal.
- Identical patch inputs yield identical output.
- Failed multi-op validation leaves draft unchanged.
- Instruction-like quoted text cannot escape payload.
- Fast path and semantic path share downstream behavior.
- Model confidence cannot bypass deterministic checks.

### Exit gate

- Five natural phrasings of a representative edit yield equivalent operations.
- No model-output path can replace the canonical draft directly.
- PRD paragraph-targeted replacement scenario passes.

---

## Phase 6: Advanced conversational editing and language controls

### Objective

Complete semantic references, paragraph restructuring, referential wording, scoped casing, explicit spelling in edits, and multi-operation commands.

### PRD coverage

- Full `FR-EDIT-002`, `FR-EDIT-003`, `FR-EDIT-009`
- `FR-CASE-001` through `FR-CASE-008`
- `FR-REF-001` through `FR-REF-006`
- Edit-mode `FR-SPELL-007` through `FR-SPELL-015`
- Structural `FR-PARA-004` through `FR-PARA-006`

### Detailed specifications

#### Semantic targeting

- Resolve descriptions such as “the sentence about hiking” within a bounded scope.
- Combine semantic candidates with paragraph, sentence, and anchor evidence.
- Present choices when not unique.
- Require confirmation for semantic-only targets unless evaluation justifies narrower automation.

#### Paragraph structure

- Add before/after a paragraph.
- Split at a resolved anchor.
- Join adjacent paragraphs with controlled whitespace.
- Move a paragraph before/after another.
- Recalculate ordinals and preserve meaningful stable identity.
- Show structural diffs clearly.

#### Referential wording

- Parse existing phrase, intended replacement, and explanatory reference separately.
- Support names, homophones, homonyms, near-homophones, and confusable terms.
- Insert only the replacement unless explanation inclusion is requested.
- Keep references session-scoped unless explicitly remembered.
- Confirm unresolved spelling or target ambiguity.

#### Casing

- Support capitalize, all caps/uppercase, and lowercase.
- Target word, phrase, sentence, paragraph, or full draft using natural language.
- Preserve punctuation, whitespace, position, and non-letters.
- Give explicit casing priority for that occurrence.

#### Spelling in edit mode

- Accept letter-by-letter replacement payloads with casing and separators.
- Apply through the common patch engine.
- Learn only committed spellings using Phase 4 rules.

#### Multi-operation commands

- Resolve all operations against one captured draft version.
- Detect overlap and conflicts.
- Apply approved groups atomically where specified.
- Produce combined and per-operation diffs.
- Reject groups without partial hidden mutation.

### Deliverables

- Semantic candidate-selection UI.
- Structural operations.
- Referential parser and session reference store.
- Full casing transforms and edit-mode spelling.
- Multi-operation planning and validation.

### Tests

- Semantic unique, ambiguous, and absent cases.
- Add/split/join/move preserve text and valid IDs.
- Ordinals update after structure changes.
- `can the worker` becomes `Ken the worker` without inserting the explanation.
- One-time references do not persist silently.
- Casing preserves punctuation and whitespace.
- Edit spelling learns only after commit.
- Multi-operation conflicts cause no mutation.

### Exit gate

- PRD structural, ambiguity, referential, and casing scenarios pass.
- Ambiguity never causes an unreviewed broad mutation.
- Every operation shares patch, diff, history, and undo infrastructure.

---

## Phase 7: Release-candidate hardening

### Objective

Make the feature-complete beta safe and dependable across supported environments and failures.

### PRD coverage

- `PRIV-001` through `PRIV-008`
- PRD Sections 14 and 15
- Final `FR-SEND-*` hardening

### Detailed specifications

#### Recovery

- Inject every documented microphone, upload, provider, interpreter, resolver, permission, chat, reconnect, and send failure.
- Preserve committed drafts through recoverable failures.
- Retry only when it cannot duplicate or reorder work.
- Provide actionable errors and safe diagnostic IDs.

#### Privacy audit

- Verify direct-action microphone activation and accessible indication.
- Verify audio/upload deletion on every terminal path.
- Verify Secure Enclave credential storage.
- Verify log redaction and user-data isolation.
- Match provider disclosures to actual network payloads.

#### Security

- Fuzz protocol and edit schemas.
- Test malformed, oversized, recursive, and unknown operations.
- Test prompt injection in draft, quoted content, references, and commands.
- Confirm interpreter output cannot call functions, access secrets, send messages, or bypass confirmation.

#### Accessibility

- Complete all workflows by keyboard.
- Add correct names, roles, focus, disabled states, and restrained live announcements.
- Avoid color-only recording status.
- Keep ordinals semantically associated but outside editable text.
- Test zoom, font scaling, reduced motion, high contrast, and screen readers.

#### Performance

- Set budgets for UI response, draft mutation, diff, context construction, and extension processing.
- Profile long drafts, maximum context/glossary, and history growth.
- Prevent rendering patterns that delay input.
- Keep cancel and unload responsive during provider delay.
- Separate provider latency from extension latency.

#### Compatibility and send

- Run the full supported browser/desktop/mobile matrix.
- Verify MIME fallbacks, narrow layouts, minimum Lumiverse version, permissions, and reconnect.
- Stress double clicks, retry, reconnect during send, chat switch, and delayed acknowledgment.
- Guarantee one confirmed submission produces exactly one message.

### Deliverables

- Release-candidate build.
- Privacy/security review.
- Accessibility checklist.
- Platform matrix and performance report.
- Failure-injection suite.

### Exit gate

- No critical/high security, privacy, accessibility, data-loss, or duplicate-send defect.
- Safe-send scenario passes across supported platforms.
- Package installs on the minimum Lumiverse version.

---

## Phase 8: Beta validation, packaging, and general availability

### Objective

Validate real usage, finalize operational documentation and migrations, and publish a supportable release.

### Detailed specifications

#### Controlled beta

- Include short dictation, long composition, accessibility, specialized vocabulary, and mobile users.
- Provide a feedback channel and privacy-safe diagnostic export.
- Evaluate accuracy, edit success, ambiguity, undo, glossary learning, latency, abandonment, and send reliability.
- Add no telemetry without separate approval and disclosure.

#### Evaluation corpus

- Maintain privacy-safe punctuation, spelling, glossary, homophone, paragraph, semantic, casing, structural, and multi-operation cases.
- Add synthetic or anonymized regressions for beta failures.
- Set semantic-fidelity and target-accuracy thresholds.

#### Documentation

- Publish installation, permissions, provider setup, microphone troubleshooting, privacy, glossary, editing examples, and recovery.
- Publish platforms, languages, providers, audio limits, context settings, and known limitations.
- Document privacy-safe unsafe-edit reporting.

#### Packaging and migration

- Validate manifest, version, minimum Lumiverse version, assets, install, and update.
- Version storage schemas for drafts, settings, and glossary.
- Test upgrade, supported downgrade, disable, uninstall, and reinstall.
- Document uninstall and data-retention behavior.

#### Release gate

- Review beta evidence against PRD success measures.
- Classify remaining issues as blockers, documented constraints, or later work.
- Tag and publish a reproducible release.
- Create post-release backlog without silently expanding initial scope.

### Deliverables

- Beta findings report and regression corpus.
- User/developer documentation.
- Storage migrations and packaging checks.
- General-availability artifact and release notes.

### Exit gate

- Beta users complete record–edit–confirm–send without developer help.
- No release blocker remains.
- Installation, upgrade, privacy, and recovery docs are published.
- Release is tagged and reproducible from source.

---

## 6. Requirement traceability

| Requirement group | Primary phase | Hardening |
| --- | --- | --- |
| Draft composition (`FR-DRAFT-*`) | 2–3 | 7 |
| Context (`FR-CTX-*`) | 4 | 7 |
| Transcription display (`FR-STT-*`) | 3 | 7 |
| Paragraph numbering (`FR-PARA-*`) | 2 | 6–7 |
| Conversational editing (`FR-EDIT-*`) | 5 | 6–7 |
| Diff/history (`FR-DIFF-*`) | 2 and 5 | 7 |
| Punctuation (`FR-PUNC-*`) | 4 | 7 |
| Explicit spelling (`FR-SPELL-*`) | 4 | 6–7 |
| Capitalization (`FR-CASE-*`) | 5–6 | 7 |
| Personal glossary (`FR-GLOSS-*`) | 4 | 7 |
| Referential wording (`FR-REF-*`) | 6 | 7 |
| Sending (`FR-SEND-*`) | 2 | 7 |
| Privacy (`PRIV-*`) | Begins 1–4 | 7 audit |
| Success measures | 8 | Post-release |

## 7. Deferred candidates

These require a PRD revision before promotion:

- Always-on continuous microphone streaming.
- Dedicated **Record Insert** control.
- Undocumented native-composer manipulation.
- Editing already-sent messages.
- Collaborative drafts.
- Background recording.
- Audio archival or voice-note library.
- Additional STT providers beyond the initial adapter.
- Formatting commands beyond the PRD operation set.
- Send-without-generation if Phase 0 excludes it.

## 8. Change control

- Product behavior changes update the PRD first.
- Resequencing requires dependency and traceability review.
- Phases may split, but exit gates may not weaken silently.
- Moving a requirement requires updated dependencies, checkpoint promises, and tests.
- Deferred work remains visible rather than disappearing from documentation.
- Every revision updates status and last-updated date.
