# Jev-Gated Post-Edit Grammar Repair

## Status

Implemented experimentally on the `jev-grammar` branch. Calibration and production rollout remain pending.

## Summary

JarvisType currently combines deterministic edit handling, local grammatical cleanup, and optional LLM-based grammar repair. The deterministic layer is necessary for operations such as target resolution, punctuation ownership, sentence boundaries, and deletion behavior. However, deciding when an edit has produced a grammatical artifact increasingly depends on individual trigger rules.

This proposal introduces TypeSafe's Jev decision model as a bounded post-edit evaluator. After every successful edit, JarvisType would send only the affected text to Jev. Jev would estimate the probability that the edit introduced a grammatical error. The generative grammar-repair model would run only when that probability exceeds a calibrated threshold.

The objective is to reduce brittle grammar-trigger rules and avoid unnecessary generative-model calls without allowing Jev or the repair model to reinterpret the requested edit.

## Goals

- Detect grammatical artifacts introduced by an edit rather than judge the author's overall writing style.
- Limit evaluation and repair to the smallest useful section of text.
- Reduce unnecessary LLM latency and cost.
- Preserve dialogue, fragments, character voice, unconventional prose, and intentional grammatical choices.
- Retain deterministic behavior for structural editing.
- Fail safely by keeping the deterministic edit whenever evaluation or repair is unavailable.
- Produce measurable data for calibrating thresholds before enabling automatic repair broadly.

## Non-goals

- Replacing deterministic edit-target resolution.
- Letting Jev generate or rewrite text.
- Performing general proofreading across the entire draft.
- Improving prose style, tone, clarity, or word choice unless required to repair a grammatical artifact caused by the edit.
- Correcting unrelated errors that existed before the edit.
- Sending the entire draft, chat history, character card, or audio to the evaluator.

## Proposed pipeline

1. Interpret and validate the editing instruction.
2. Apply the edit through the deterministic edit pipeline.
3. Run existing deterministic structural cleanup.
4. Identify the affected sentence or sentences from the resolved edit offsets.
5. Construct a bounded evaluation segment:
   - Include the affected sentence.
   - Include at most one neighboring sentence on either side when agreement, quotation state, or sentence-boundary context requires it.
   - Mark the exact changed span or provide the before-and-after affected segment.
6. Ask Jev whether the edit introduced a grammatical artifact.
7. Route according to the configured probability thresholds.
8. When repair is warranted, send only the bounded after-edit segment to the grammar-repair LLM, together with protected terms and the changed span.
9. Validate the returned repair using the existing safety rules.
10. Optionally evaluate the repaired segment with Jev and accept it only when the grammatical-error probability decreases by a configured margin.
11. Present the final proposal for user approval through the existing edit-review UI.

## Jev evaluation question

The evaluator must judge the effect of the edit, not the quality of the prose in isolation. A suitable decision question would be conceptually equivalent to:

> Did the identified edit introduce a grammatical error or malformed sentence boundary that should be repaired, while preserving the intended wording, dialogue, and style?

The evaluation payload should include:

- The affected text before the edit.
- The affected text after deterministic cleanup.
- The changed span or a compact description of the resolved operation.
- A rubric distinguishing grammatical damage from stylistic preference.
- Instructions to disregard unrelated pre-existing errors.

The implementation should prefer a calibrated probability for a binary decision. A multi-level score may be evaluated later if it provides better separation between harmless awkwardness and clear grammatical damage.

## Lumiverse integration

JarvisType uses Lumiverse's host-managed Decision API rather than storing a TypeSafe credential or calling TypeSafe directly. The extension declares the `decisions` permission and calls `spindle.decisions.evaluate` without a connection override, allowing Lumiverse to use the user's default saved Decision connection.

No Jev API key is accepted, stored, logged, or transmitted by JarvisType. If the permission, host capability, or default Decision connection is unavailable, adaptive grammar repair falls back to the deterministic edit without invoking the generative repair model.

## Initial routing policy

Initial thresholds should be treated as experimental:

| Jev probability that the edit introduced an error | Action |
| --- | --- |
| Below 0.35 | Keep the deterministic result. Do not call the repair LLM. |
| 0.35 through 0.70 | Keep the deterministic result and record evaluation telemetry during calibration. |
| Above 0.70 | Request a bounded LLM grammar repair. |

Production thresholds must be selected from evaluation results rather than fixed permanently to these initial values.

An optional acceptance rule for the repaired candidate should require both:

- A meaningful reduction in Jev's error probability.
- Successful deterministic safety validation.

## Bounded repair requirements

The grammar-repair LLM must:

- Receive only the bounded affected segment.
- Make the smallest edit necessary.
- Preserve names, glossary terms, explicit spellings, quotations, URLs, code, and protected casing.
- Avoid changing meaning, facts, tone, characterization, or narrative perspective.
- Avoid repairing text outside the identified edit-caused problem.
- Return structured localized replacements rather than a rewritten paragraph.

Existing validation should continue to reject repairs that:

- Rewrite an entire sentence when a smaller change is sufficient.
- Cross unrelated sentence boundaries.
- Remove or alter protected terms.
- Add new information.
- Exceed configured size or edit-count limits.

## Relationship to deterministic rules

Jev should replace heuristic decisions about whether generative grammar repair is necessary. It should not replace deterministic rules that define editing semantics.

The following remain deterministic:

- Whole-word and phrase boundaries.
- Exact and fuzzy target resolution.
- Ambiguity handling.
- Sentence and paragraph selection.
- Whether sentence-ending punctuation belongs to a sentence operation.
- Separator cleanup after deletion.
- Quotation and punctuation placement.
- Operation validation and review requirements.

Some local grammar-trigger rules may be retired after the Jev gate demonstrates adequate recall and calibration. Until then, existing deterministic cleanup should run before Jev and remain available as a zero-latency fallback.

## Settings

The existing grammar-repair modes can evolve as follows:

- **Off:** Apply deterministic cleanup only. Do not call Jev or the repair LLM.
- **When needed:** Apply deterministic cleanup, evaluate the affected segment with Jev, and call the repair LLM only above the threshold.
- **Always:** Apply deterministic cleanup and always call the repair LLM. Jev may still run for telemetry or repair validation, but it does not gate the call.

The UI should explain that the adaptive mode adds one lightweight evaluation request to each successful edit and only invokes the slower generative repair when warranted.

## Latency and failure behavior

The adaptive path adds a Jev round trip to every successful edit. The integration therefore needs:

- A short, independently configurable timeout.
- Cancellation tied to the active edit request.
- No retry on the interactive path unless measurements justify it.
- A fallback to the deterministic edit on timeout, malformed output, connection failure, or cancellation.
- Debug timing that distinguishes edit interpretation, deterministic execution, Jev evaluation, generative repair, and repair validation.

The review UI timer must continue running throughout evaluation and repair.

## Privacy and data minimization

Only the bounded before-and-after affected segments and minimal operation metadata should be sent to Jev. The payload must not include:

- The complete working draft.
- Raw chat messages.
- The complete character card.
- Audio.
- Unrelated paragraphs.

Names and glossary terms needed to prevent false corrections may be included as a bounded protected-term list.

## Telemetry and calibration

Before enabling automatic Jev-gated repair by default, collect or replay an evaluation corpus containing:

- Clean edits that require no repair.
- Deletions that leave punctuation or capitalization artifacts.
- Insertions and replacements that break articles, agreement, tense, or sentence boundaries.
- Dialogue, fragments, and intentionally unconventional prose.
- Names and proper nouns that resemble common words.
- Quoted speech and nested punctuation.
- Cases where the existing LLM repair improves the result.
- Cases where the existing LLM repair makes an unnecessary or harmful change.

For each example, record:

- Jev probability and confidence output.
- Whether a human reviewer believes the edit introduced a grammatical error.
- Whether repair was required.
- Whether the generated repair was acceptable.
- Latency for evaluation and repair.
- False-positive and false-negative category.

Threshold selection should prioritize avoiding unnecessary rewrites while maintaining high recall for clearly broken edit results.

## Rollout plan

### Phase 1: Offline evaluation

- Build a labeled regression corpus from existing tests and reported bugs.
- Run Jev without changing application output.
- Compare its decisions with existing triggers and human labels.
- Select an initial threshold and timeout.

### Phase 2: Shadow mode

- Run Jev for users who enable adaptive grammar repair.
- Record decisions and latency, but retain the existing repair-routing behavior.
- Do not store raw user text in telemetry; store only bounded, privacy-reviewed diagnostics where permitted.

### Phase 3: Gated repair

- Let Jev control whether the repair LLM is called in **When needed** mode.
- Keep review mandatory for every generated repair.
- Monitor false positives, false negatives, timeouts, and user rejection rates.

### Phase 4: Rule consolidation

- Remove only grammar-trigger rules proven redundant by evaluation.
- Retain structural and safety rules.
- Recalibrate thresholds when the Jev model, repair model, prompt, or corpus changes materially.

## Testing requirements

- Unit tests for evaluation-segment extraction and changed-span mapping.
- Unit tests for threshold routing and timeout fallback.
- Unit tests confirming that **Off** performs no external evaluation.
- Unit tests confirming that low scores do not call the repair LLM.
- Unit tests confirming that high scores call the repair LLM once with bounded text.
- Tests for cancellation and active-chat changes during evaluation.
- Tests ensuring unrelated paragraphs cannot be modified.
- Tests ensuring protected names and glossary terms survive repair.
- Integration tests using recorded Jev responses at both sides of each threshold.
- Regression tests for every previously reported grammar-repair bug.

## Open decisions

- Which Jev question type provides the best calibration for this task.
- The exact rubric and response fields supported by the eventual Jev integration.
- Thresholds and minimum improvement required to accept a repair.
- Whether the neighboring sentences are always included or selected by operation type.
- Whether Jev should validate LLM repairs during the initial release or only gate repair requests.
- How evaluation telemetry can be collected without retaining user text.
- Whether a Jev connection is user-configurable or managed separately from the existing normalization connection.

## Recommended first implementation

Start with shadow-mode evaluation of the affected sentence and one adjacent sentence on each side. Use a binary probability question focused specifically on edit-introduced grammatical damage. Do not change routing until the regression corpus establishes a threshold with acceptable false-positive and false-negative rates.

Once calibrated, use Jev to gate the LLM in **When needed** mode. Keep deterministic cleanup, structured repair validation, and user review unchanged.
