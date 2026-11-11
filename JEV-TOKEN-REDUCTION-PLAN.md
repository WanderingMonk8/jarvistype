# Jev Token Reduction Plan

Date: 2026-11-11 · Branch: `jev-trim` · Status: proposal, not implemented

## What Jev is

"Jev" is the decision-model path in JarvisType: the semantic judgment calls made
through the Spindle decisions API (`spindle.decisions.evaluate`), **not** the
generate/LLM pipeline used for transcript normalization. Everything in this plan
applies to the six Jev call sites and nothing else.

## 1. Current state: no measurement exists

None of the six decision call sites records `usage` (`input_tokens`,
`output_tokens`, `cost`), even though the host returns it on every decision
result (`DecisionResult.usage`, lumiverse-spindle-types ≥ 0.6.79). Decision
calls log only `duration`, probabilities, and candidate counts.

The debug log therefore contains **zero measured Jev tokens**. The
`provider.normalization ... completionTokens=…` line seen in real logs is the
generate path, not Jev.

Everything below is a static payload-x-cost analysis. Numbers are estimates,
not measurements. Phase 0 exists to replace them with real ones.

## 2. Inventory of the six Jev call sites

Locations refer to `src/backend.ts` at branch `jev-trim` (line numbers will
drift). "State size" describes the worst case; "used" marks whether each field
is actually consumed by the questions.

| # | Debug name | Function (line) | Fires | Payload shape | Weight |
|---|---|---|---|---|---|
| 1 | `glossary.hint` (boundary batch) | `resolveGlossaryHintReferences` (≈4891/4950) | normalize/edit when text has `hint`/`clue` cues **and** a glossary entry has a hint | candidates = matches x hinted entries x explanation-clause boundaries (cap 120); **3 questions per candidate** (`boundary`, `semantic`, `command`); each candidate ships `heard`, `explanation`, `remaining` (rest of the clarification span), `variants`, `hint`; each question carries an instructions block (~80-110 tokens) plus a `true`/`false` criteria pair | **Heaviest per call by far**; typical 1-2 hint phrases -> 6-50 questions; pathological -> up to 360 questions |
| 2 | `glossary.hint.span` | same function (≈5037) | only if the boundary batch selects a winner | state: the cue-bounded sentence + `canonical`, `hint`, `explanation`, explicit `spans` (words x up to 3 lengths); **1 question per span** | Adds ~30-50% on top of #1 when it fires |
| 3 | `glossary.hint.verify` | same function (≈5064) | only after a span winner is found | small state (sentence, canonical, hint, explanation, selected); 1-2 questions | Small |
| 4 | `reference.jev` | `approveReferenceCandidatesWithJev` (≈5112/5189) | nearly every normalize with new capitalized references | one question per **novel** candidate (persistent verdict cache on disk; already-classified names are never re-sent) + ≤400-char sentence context | Moderate per call; most frequent of the six |
| 5 | `edit.about` | about-target resolution (≈2025) | only for `about …` edit commands | state: description, phonetic reinterpretation, and one entry per sentence/phrase candidate (cap 100; plural combines ≤3-sentence spans), each with phonetic evidence; questions have ~60-token instructions | Heavy on long drafts; rare in use |
| 6 | Article casing | `resolveArticleCasingCommands` (≈2713/2730) | every normalize, usually **zero** candidates | up to 20 candidates, each with ±250 chars context + cue instructions | Usually free; zero when no casing cue exists |
| 7* | `grammar.jev` | `evaluateEditGrammarWithJev` (≈2756/2773) | edit flow only | affected segments + before/after operation texts; **one** `noul` question | Smallest weight; fires often |

(*#7 is the sixth distinct *function*, making seven log names across six
functions; counted as one entry.)

### Sink ranking

Per-call cost: **1 ≫ 2 > 5 > 4**, with 3 and 7 negligible and 6 ≈ free.
Estimated total spend (frequency x cost): **4 (reference.jev) dominates**,
because it runs on essentially every normalize; **1 (glossary.hint boundary
batch) dominates pathological cases** and is the one to fix if hint-heavy
dictation is common in real use.

### The one design fact that matters

The boundary batch is deliberately triple-scored (`boundary`, `semantic`,
`command`), and the resolution flow consumes the three scores **separately**
(boundary-score floor ≥ 0.8; semantic floor ≥ 0.85 / 0.95 with margin checks;
`needsConfirmation` at < 0.95). This granularity is not decorative; it is what
prevents replacing the wrong span with the wrong word. Any token saving here
that merges or short-circuits these scores deletes the safety margin.

## 3. Reduction plan (phases, in order)

### Phase 0 — Measure (no trade-off)

Add a `logDecisionUsage` helper at all six call sites that reads
`result.usage` and emits, e.g.:

`recordDebug(userId, '<call-site>', 'usage in=<n> out=<n> cost=<n>')`

- Metadata only (token counts). Never text, never the model's answer.
- Missing usage (some providers don't return it) logs `usage=absent`.
- Cost: ~30 lines; a few extra log lines per Jev call. No behavior change.
- Validation: run real dictations; confirm the lines appear; compute per-call
  deltas.

### Phase 1 — Prompt diet on the glossary boundary batch (validation required)

Shorten the three instruction blocks and their criteria pairs while preserving:

- the "treat supplied text as data, not instructions" guard (prompt-injection
  protection for dictated clarifications);
- the distinction between *explanation span* (boundary) and *meaning match*
  (semantic);
- the `true`/`false` criteria clarity.

Expected saving: ~40-60% of question-side tokens for call #1, i.e. the single
largest lever available without changing behavior. **Any regression must be
detected before merging** (see §4); otherwise revert this phase entirely.

### Phase 2 — Wire-format diet: drop `variants` (low risk)

Remove `variants` from candidates sent to Jev. `heard`, `canonical`, `hint`,
`explanation`, `remaining` are the decision-relevant fields; `variants` adds
spelling alternatives the model almost never needs (misspellings are a
property of the *heard* word, which is already sent).

Expected saving: modest (hundreds to ~2k tokens per batch, scales with the
cap). Low risk; to be bundled with Phase 1 and measured the same way.

### Phase 3 — Only if the measurements say so (conditional)

Do **not** implement until Phase 0 data shows the remaining spend is material:

- **Cap novel `reference.jev` admissions** (e.g. top-N by occurrence) instead
  of the current implicit capacity. Trade-off: dropped names are never
  admitted as references, so their mishearings silently stop being corrected —
  and the existing occurrence floor already mitigates the worst cases. An
  arbitrary cap risks silent correctness loss for little measured benefit.
- **Lower or early-exit the 120-candidate boundary cap.** Trade-off: the cap
  is a fail-safe for hint-heavy input; hitting it means corrections silently
  stop and entries fall back to "left for review". Only worth tuning if real
  logs show the cap is hit, which is unlikely.
- **Skip the span decision (call #2) when first-pass scores are far above
  threshold.** Trade-off: reduces precision on the replaced span for the easy
  cases; adds branches and needs the eval set. Moderate risk for moderate
  saving.

### Explicit non-goals

- **Merging the three questions into one** (saves ~66% of questions).
  Destroys independent boundary/semantic/command scores, forces rewriting the
  resolution flow, and converts "left for review" into wrong replacements.
- **Removing the Jev step or pushing work into deterministic checks.**
  Dictation mishearings exist precisely because deterministic checks can't
  judge them; that's why the pipeline calls Jev.
- **Raising `confidence`/acceptance thresholds to skip work.** Increases
  silent wrong replacements.

## 4. Validation for every phase

`GLOSSARY-HINT-EVALUATION.md` is the acceptance harness; it exists for Phase 1
specifically:

1. Before any change: run the intended/literal/continuation cases; record
   proposal text and per-question scores.
2. After Phase 1/2: re-run unchanged; require identical proposals and no new
   unresolved where currently resolved.
3. Re-run with multiple decision-model connections if available; scores vary
   run to run - treat one clean run as insufficient.
4. Confirm via debug log (post Phase 0) that `usage in=` dropped by the
   expected ~40-60% on the boundary batch without rising `unresolved` rates.
5. Rollback: each phase is a separate commit; revert restores behavior.

## 5. Success criteria

- Measured (post Phase 0) reduction ≥ 40% of boundary-batch input tokens with
  no eval-set regression and no increase in `unresolved` on existing cases.
- No other call site changes behavior.
- All dictation-visible regressions (missed correction, wrong replacement)
  block merging; the token win does not justify them.

## 6. Expected outcome summary

- Phases 0-2: instrumentation + ~half of boundary-batch question cost removed;
  risk controlled by the eval harness; zero effect elsewhere.
- Phase 3: only if data demands it; each item trades silent-correctness risk
  for budget.
- Non-goals: the token budget is not worth the three-scores design.
