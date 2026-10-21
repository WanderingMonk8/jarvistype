import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeEditPlan,
  parseEditPlan,
  type EditPlan,
  type EditPipelineResult,
} from '../src/domain/edit-pipeline'
import { repairDeterministicGrammar } from '../src/domain/grammar'

function plan(value: unknown): EditPlan {
  const parsed = parseEditPlan(value)
  assert.ok(parsed)
  return parsed
}

function execute(
  cleanText: string,
  operation: unknown,
  skipOperationFormatting: boolean,
): Extract<EditPipelineResult, { ok: true }> {
  const result = executeEditPlan(
    cleanText,
    [],
    1,
    plan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'cleanup isolation fixture',
      operations: [operation],
    }),
    [],
    { skipOperationFormatting },
  )
  if (!result.ok) assert.fail(result.reason)
  return result
}

/**
 * Characterization of the two cleanup layers. The "raw" column is an edit that
 * skips per-operation casing, boundary spacing, and separator trimming; the
 * universal column is what the deterministic cleanup can recover on its own.
 */
test('universal cleanup alone repairs text-level artifacts from raw edits', () => {
  const cases: Array<{ name: string; text: string; operation: unknown; expected: string }> = [
    {
      name: 'article agreement after a replacement',
      text: 'This is a wide entrance.',
      operation: {
        id: 'article',
        type: 'replace',
        target: { exactText: 'wide' },
        text: 'accessible',
      },
      expected: 'This is an accessible entrance.',
    },
    {
      name: 'errant punctuation and sentence casing after a replacement',
      text: 'First sentence. Second sentence.',
      operation: {
        id: 'errant',
        type: 'replace',
        target: { exactText: 'Second sentence.' },
        text: 'second sentence.,',
      },
      expected: 'First sentence. Second sentence.',
    },
    {
      name: 'separator whitespace after a deletion',
      text: 'One two three.',
      operation: { id: 'delete-word', type: 'delete', target: { exactText: 'two' } },
      expected: 'One three.',
    },
    {
      name: 'missing space after an inserted sentence ending',
      text: 'First sentence. Second sentence.',
      operation: {
        id: 'insert-after',
        type: 'insert_after',
        target: { exactText: 'First sentence.' },
        text: 'Next',
      },
      expected: 'First sentence. Next Second sentence.',
    },
  ]

  for (const testCase of cases) {
    const raw = execute(testCase.text, testCase.operation, true).afterText
    const universal = repairDeterministicGrammar(raw).text
    assert.equal(universal, testCase.expected, testCase.name)
  }
})

test('operation formatting is still required for insertion-boundary intent', () => {
  // Universal cleanup cannot invent a word boundary that the patch never had.
  const gluedInsertion = execute(
    'First sentence. Second sentence.',
    {
      id: 'glued-insert',
      type: 'insert_before',
      target: { exactText: 'Second' },
      text: 'New',
    },
    true,
  ).afterText
  assert.equal(gluedInsertion, 'First sentence. NewSecond sentence.')
  assert.equal(repairDeterministicGrammar(gluedInsertion).text, gluedInsertion)

  // Replacement casing at a sentence opening is intent, not a grammar artifact:
  // universal cleanup capitalizes but never lowercases.
  const capitalizedReplacement = execute(
    'She said my answer was ready.',
    {
      id: 'casing',
      type: 'replace',
      target: { exactText: 'my answer' },
      text: 'My response',
    },
    true,
  ).afterText
  assert.equal(capitalizedReplacement, 'She said My response was ready.')
  assert.equal(repairDeterministicGrammar(capitalizedReplacement).text, capitalizedReplacement)

  // Appending a lowercase word relies on boundary spacing; the conservative
  // period rule only inserts a space before an uppercase sentence opening.
  const appendedLowercase = execute(
    'First sentence.',
    {
      id: 'append-lowercase',
      type: 'insert_after',
      target: { exactText: 'First sentence.' },
      text: 'more',
    },
    true,
  ).afterText
  assert.equal(appendedLowercase, 'First sentence.more')
  assert.equal(repairDeterministicGrammar(appendedLowercase).text, appendedLowercase)
})
