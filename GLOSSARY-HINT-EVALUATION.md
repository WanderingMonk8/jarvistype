# Glossary hint evaluation

Run these cases through the deployed application with debug logging enabled and the same decision connection. Review the proposed text and the anonymous `glossary.hint.candidate` scores. These cases are an evaluation set, not a request to change thresholds based on one result. Model scores can vary; repeat runs before drawing conclusions.

Create chat-local glossary entries `chirurgeon` with hint `a medieval battlefield doctor` and `Tudor` with hint `Midland's enemy`. Use the same hints for the entire set. Check that entries are visible in the active chat.

| Type | Dictate | Expected behavior |
| --- | --- | --- |
| Intended | I need a surgeon, as in a medieval battlefield doctor. | Propose “I need a chirurgeon.” |
| Intended | I need a surgeon, as in a battlefield doctor. | Propose “I need a chirurgeon.” |
| Intended | We are facing Tudor, as in Midland's enemy. | Propose “We are facing Tudor.” |
| Intended with continuation | I found a surgeon, as in a medieval battlefield doctor, near the gate. | Propose “I found a chirurgeon near the gate.” |
| Literal | I described a surgeon, as in a medieval battlefield doctor. | Preserve the explanation if intended as prose. |
| Literal | The historian said Tudor, as in Midland's enemy, was a misleading label. | Preserve the quoted explanation if intended as prose. |
| Literal, unrelated | I worked as in the previous example. | Preserve the text. |

The first intended and literal examples deliberately overlap in wording: a text-only model cannot always infer whether an identical explanatory phrase was intended as an instruction. Record both false positives and false negatives; when the distinction cannot be made safely, a user choice or an explicit cue is preferable to silently removing text.

For each case, record the actual raw transcript, proposal, and anonymous scores separately and securely; the timing log itself must remain metadata-only. Include the decision-model connection and whether other visible glossary entries were present. Do not infer calibration from mocked unit tests.
