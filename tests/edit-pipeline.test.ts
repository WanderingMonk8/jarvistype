import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAutomatedEdit,
  createDraftSession,
  applyManualEdit,
} from '../src/domain/draft-session'
import { executeEditPlan, executeSequentialEditPlan, parseEditPlan, type EditPlan } from '../src/domain/edit-pipeline'

function fixture() {
  const empty = createDraftSession('chat', '2026-01-01T00:00:00.000Z')
  return applyManualEdit(empty, 'First mountain sentence.\n\nSecond paragraph here.', {
    expectedVersion: 0,
    editGroupId: 'seed',
    createId: (() => {
      let index = 0
      return () => `id-${++index}`
    })(),
  }).session
}

test('accepts a closed supported schema and rejects unknown or oversized operations', () => {
  assert.ok(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'replace phrase',
      operations: [
        {
          id: 'one',
          type: 'replace',
          target: { paragraphOrdinal: 1, exactText: 'mountain' },
          text: 'hill',
        },
      ],
    }),
  )
  assert.ok(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete a sentence by position',
      operations: [
        {
          id: 'sentence-one',
          type: 'delete',
          target: { paragraphOrdinal: 1, sentenceOrdinal: 1 },
          includeTrailingPunctuation: true,
        },
      ],
    }),
  )
  assert.equal(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: '',
      operations: [{ id: 'one', type: 'execute_code', target: { paragraphOrdinal: 1 } }],
    }),
    null,
  )
  assert.equal(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'conflicting punctuation selectors',
      operations: [
        {
          id: 'one',
          type: 'delete',
          target: { punctuation: 'period', occurrence: 2, occurrenceFromEnd: 1 },
        },
      ],
    }),
    null,
  )
  assert.equal(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'conflicting sentence selectors',
      operations: [
        {
          id: 'one',
          type: 'delete',
          target: { sentenceOrdinal: 1, sentenceFromEnd: 1 },
        },
      ],
    }),
    null,
  )
})

test('resolves a unique paragraph-scoped replacement deterministically', () => {
  const session = fixture()
  const plan: EditPlan = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace the mountain phrase',
    operations: [
      {
        id: 'one',
        type: 'replace',
        target: { paragraphOrdinal: 1, exactText: 'mountain' },
        text: 'hiking',
      },
    ],
  }
  const first = executeEditPlan(session.cleanText, session.paragraphs, 1, plan)
  const second = executeEditPlan(session.cleanText, session.paragraphs, 1, plan)
  assert.deepEqual(first, second)
  assert.equal(first.ok && first.afterText, 'First hiking sentence.\n\nSecond paragraph here.')
})

test('deletes a whole paragraph together with its adjacent separator', () => {
  const session = fixture()
  const firstDeleted = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete the first paragraph',
    operations: [{ id: 'delete-first', type: 'delete', target: { paragraphOrdinal: 1 } }],
  })
  assert.equal(firstDeleted.ok && firstDeleted.afterText, 'Second paragraph here.')
  assert.deepEqual(firstDeleted.ok && firstDeleted.resultingParagraphIds, [
    session.paragraphs[1]!.id,
  ])

  const lastDeleted = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete the last paragraph',
    operations: [{ id: 'delete-last', type: 'delete', target: { paragraphOrdinal: 2 } }],
  })
  assert.equal(lastDeleted.ok && lastDeleted.afterText, 'First mountain sentence.')
})

test('capitalizes replacement text only when it begins a sentence', () => {
  const opening = executeEditPlan('Keyboard recording test.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace the opening word',
    operations: [
      { id: 'opening', type: 'replace', target: { exactText: 'Keyboard' }, text: 'accessible' },
    ],
  })
  assert.equal(opening.ok && opening.afterText, 'Accessible recording test.')

  const middle = executeEditPlan('A keyboard recording test.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace a word inside the sentence',
    operations: [
      { id: 'middle', type: 'replace', target: { exactText: 'keyboard' }, text: 'accessible' },
    ],
  })
  assert.equal(middle.ok && middle.afterText, 'A accessible recording test.')

  const providerCapitalizedMiddle = executeEditPlan('She said my answer was ready.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'match the lowercase target opening in the middle of a sentence',
    operations: [
      {
        id: 'provider-capitalized-middle',
        type: 'replace',
        target: { exactText: 'my answer' },
        text: 'My response',
      },
    ],
  })
  assert.equal(
    providerCapitalizedMiddle.ok && providerCapitalizedMiddle.afterText,
    'She said my response was ready.',
  )

  const singleCapitalizedWord = executeEditPlan('I turned towards erwin.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'keep a capitalized name after a lowercase target',
    operations: [
      { id: 'single-name', type: 'replace', target: { exactText: 'erwin' }, text: 'Erica' },
    ],
  })
  assert.equal(
    singleCapitalizedWord.ok && singleCapitalizedWord.afterText,
    'I turned towards Erica.',
  )

  const protectedMiddle = executeEditPlan(
    'She greeted the new arrival.',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'preserve a protected proper noun in the middle of a sentence',
      operations: [
        {
          id: 'protected-middle',
          type: 'replace',
          target: { exactText: 'the new arrival' },
          text: 'Alice Morgan',
        },
      ],
    },
    ['Alice Morgan'],
  )
  assert.equal(protectedMiddle.ok && protectedMiddle.afterText, 'She greeted Alice Morgan.')

  const establishedCase = executeEditPlan('Keyboard recording test.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'preserve established mixed case',
    operations: [
      { id: 'mixed-case', type: 'replace', target: { exactText: 'Keyboard' }, text: 'eBay' },
    ],
  })
  assert.equal(establishedCase.ok && establishedCase.afterText, 'eBay recording test.')

  const sentenceCase = executeEditPlan('Opening phrase continues.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'preserve sentence case across a phrase',
    operations: [
      {
        id: 'sentence-case',
        type: 'replace',
        target: { exactText: 'Opening phrase' },
        text: 'replacement words',
      },
    ],
  })
  assert.equal(sentenceCase.ok && sentenceCase.afterText, 'Replacement words continues.')

  const titleCase = executeEditPlan('Proper Name arrived.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'do not infer title case from the target phrase',
    operations: [
      {
        id: 'title-case',
        type: 'replace',
        target: { exactText: 'Proper Name' },
        text: 'new person',
      },
    ],
  })
  assert.equal(titleCase.ok && titleCase.afterText, 'New person arrived.')

  const uppercase = executeEditPlan('The LOUD WORDS remain.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'do not infer uppercase from the target phrase',
    operations: [
      {
        id: 'uppercase',
        type: 'replace',
        target: { exactText: 'LOUD WORDS' },
        text: 'quiet phrase',
      },
    ],
  })
  assert.equal(uppercase.ok && uppercase.afterText, 'The quiet phrase remain.')
})

test('rejects missing, duplicate, stale, and overlapping targets atomically', () => {
  const duplicate = applyManualEdit(createDraftSession('chat'), 'same same', {
    expectedVersion: 0,
    editGroupId: 'seed',
  }).session
  const base = {
    schemaVersion: 2 as const,
    draftVersion: 1,
    explanation: '',
  }
  assert.equal(
    executeEditPlan(duplicate.cleanText, duplicate.paragraphs, 1, {
      ...base,
      operations: [{ id: 'one', type: 'delete', target: { exactText: 'same' } }],
    }).ok,
    false,
  )
  assert.equal(
    executeEditPlan(duplicate.cleanText, duplicate.paragraphs, 2, {
      ...base,
      operations: [{ id: 'one', type: 'delete', target: { exactText: 'missing' } }],
    }).ok,
    false,
  )
  const session = fixture()
  assert.equal(
    executeEditPlan(session.cleanText, session.paragraphs, 1, {
      ...base,
      operations: [
        { id: 'one', type: 'replace', target: { exactText: 'mountain' }, text: 'hill' },
        { id: 'two', type: 'delete', target: { exactText: 'mountain sentence' } },
      ],
    }).ok,
    false,
  )
})

test('formats insertion and append against preceding punctuation edits in a multi-command plan', () => {
  const text = 'First.\n\nSecond.'
  const paragraphs = [
    { id: 'p1', ordinal: 1, lineIndex: 0, text: 'First.' },
    { id: 'p2', ordinal: 2, lineIndex: 2, text: 'Second.' },
  ]
  const result = executeSequentialEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Change periods and insert continuations.',
    operations: [
      { id: 'comma-first', type: 'replace', target: { paragraphOrdinal: 1, exactText: '.' }, text: ',' },
      { id: 'insert-first', type: 'insert_after', target: { paragraphOrdinal: 1, exactText: 'First.' }, text: 'continued.' },
      { id: 'comma-second', type: 'replace', target: { paragraphOrdinal: 2, exactText: '.' }, text: ',' },
      { id: 'append-second', type: 'append', target: { paragraphOrdinal: 2 }, text: 'continued' },
    ],
  })
  assert.equal(result.ok && result.afterText, 'First, continued.\n\nSecond, continued')
})

test('lowercases ordinary provider-capitalized continuations after a comma while protecting names', () => {
  for (const [insertion, expected] of [
    ['She looks at me.', 'she looks at me.'],
    ['I look at her.', 'I look at her.'],
    ['Erbold looks at me.', 'Erbold looks at me.'],
    ['“She looks at me.”', '“She looks at me.”'],
  ] as const) {
    const text = 'She makes no effort to hide it.'
    const result = executeSequentialEditPlan(text, [{ id: 'p', ordinal: 1, lineIndex: 0, text }], 1, {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'Change punctuation and append.',
      operations: [
        { id: 'punctuation', type: 'replace', target: { paragraphOrdinal: 1, exactText: '.' }, text: ',' },
        { id: 'append', type: 'append', target: { paragraphOrdinal: 1 }, text: insertion },
      ],
    }, ['Erbold'])
    assert.equal(result.ok && result.afterText, `She makes no effort to hide it, ${expected}`)
  }
})

test('sequential edits stop at the first failure and preserve earlier changes', () => {
  const text = 'Alpha beta gamma.'
  const paragraphs = [{ id: 'p1', ordinal: 1, lineIndex: 0, text }]
  const result = executeSequentialEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Replace, fail, then stop.',
    operations: [
      { id: 'first', type: 'replace', target: { exactText: 'Alpha' }, text: 'Delta' },
      { id: 'missing', type: 'delete', target: { exactText: 'missing' } },
      { id: 'not-run', type: 'replace', target: { exactText: 'gamma' }, text: 'omega' },
    ],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.afterText, 'Delta beta gamma.')
  assert.equal(result.operations.length, 1)
  assert.equal(result.failedCommand?.index, 2)
  assert.equal(result.failedCommand?.operationId, 'missing')
})

test('sequential edits resolve targets after a paragraph split and retain paragraph identities', () => {
  const text = 'First sentence. Second sentence.'
  const result = executeSequentialEditPlan(text, [{ id: 'original', ordinal: 1, lineIndex: 0, text }], 1, {
    schemaVersion: 2, draftVersion: 1, explanation: 'Split and edit the new paragraph.',
    operations: [
      { id: 'split', type: 'split', target: { paragraphOrdinal: 1, exactText: 'First sentence.' } },
      { id: 'replace', type: 'replace', target: { paragraphOrdinal: 2, exactText: 'Second' }, text: 'Next' },
    ],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.afterText, 'First sentence.\n\nNext sentence.')
  assert.equal(result.failedCommand, undefined)
  assert.equal(result.resultingParagraphIds?.length, 2)
  assert.equal(result.resultingParagraphIds?.[0], 'original')
})

test('prepend and insert-before adjust displaced ordinary sentence openings only for continuations', () => {
  for (const [original, insertion, expected, protectedTerms] of [
    ['Kiss for a long time.', 'We', 'We kiss for a long time.', []],
    ['Kiss for a long time.', 'Hello.', 'Hello. Kiss for a long time.', []],
    ['Erbold waits.', 'Then', 'Then Erbold waits.', ['Erbold']],
    ['I wait.', 'Then', 'Then I wait.', []],
  ] as const) {
    const paragraphs = [{ id: 'p', ordinal: 1, lineIndex: 0, text: original }]
    for (const operation of [
      { id: 'prepend', type: 'prepend' as const, target: { paragraphOrdinal: 1 }, text: insertion },
      { id: 'insert', type: 'insert_before' as const, target: { exactText: original }, text: insertion },
    ]) {
      const result = executeEditPlan(original, paragraphs, 1, {
        schemaVersion: 2, draftVersion: 1, explanation: 'Insert before.', operations: [operation],
      }, protectedTerms)
      assert.equal(result.ok && result.afterText, expected)
    }
  }
})

test('preserves quoted speech openings after a dialogue tag', () => {
  for (const [open, close] of [['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]] as const) {
    const original = `She said, ${open}Hello there.${close}`
    const paragraphs = [{ id: 'p', ordinal: 1, lineIndex: 0, text: original }]
    for (const [operation, expected] of [
      [{ id: 'replace', type: 'replace' as const, target: { exactText: 'Hello' }, text: 'come' }, `She said, ${open}Come there.${close}`],
      [{ id: 'insert', type: 'insert_before' as const, target: { exactText: 'Hello' }, text: 'please' }, `She said, ${open}Please hello there.${close}`],
    ] as const) {
      const result = executeEditPlan(original, paragraphs, 1, { schemaVersion: 2, draftVersion: 1, explanation: 'Edit.', operations: [operation] })
      assert.equal(result.ok && result.afterText, expected, `${open} ${operation.type}`)
    }
    const incomplete = `She said, ${open}`
    const result = executeEditPlan(incomplete, [{ id: 'p', ordinal: 1, lineIndex: 0, text: incomplete }], 1, {
      schemaVersion: 2, draftVersion: 1, explanation: 'Append.', operations: [{ id: 'append', type: 'append', target: { paragraphOrdinal: 1 }, text: 'hello' }],
    })
    assert.equal(result.ok && result.afterText, `${incomplete}hello`, `${open} append without existing capitalized text`)
    const fragment = `She mentioned ${open}hello there${close} in passing.`
    const fragmentResult = executeEditPlan(fragment, [{ id: 'p', ordinal: 1, lineIndex: 0, text: fragment }], 1, {
      schemaVersion: 2, draftVersion: 1, explanation: 'Replace.', operations: [{ id: 'replace', type: 'replace', target: { exactText: 'hello' }, text: 'goodbye' }],
    })
    assert.equal(fragmentResult.ok && fragmentResult.afterText, `She mentioned ${open}goodbye there${close} in passing.`, `${open} lowercase fragment`)
    for (const [word, expectedWord, protectedTerms] of [['Hello', 'hello', []], ['Erbold', 'Erbold', ['Erbold']], ['I', 'I', []]] as const) {
      const quoted = `${open}${word} waits.${close}`
      const prepended = executeEditPlan(quoted, [{ id: 'p', ordinal: 1, lineIndex: 0, text: quoted }], 1, {
        schemaVersion: 2, draftVersion: 1, explanation: 'Prepend.', operations: [{ id: 'prepend', type: 'prepend', target: { paragraphOrdinal: 1 }, text: 'please' }],
      }, protectedTerms)
      assert.equal(prepended.ok && prepended.afterText, `${open}Please ${expectedWord} waits.${close}`, `${open} prepend ${word}`)
    }
  }
})

test('splices punctuation-ending replacements with the following sentence', () => {
  for (const [original, target, replacement, expected, protectedTerms] of [
    ['We walked, then rested.', 'walked,', 'stopped.', 'We stopped. Then rested.', []],
    ['We stopped. Then rested.', 'stopped.', 'walked,', 'We walked, then rested.', []],
    ['We stopped. Erbold rested.', 'stopped.', 'walked,', 'We walked, Erbold rested.', ['Erbold']],
    ['We stopped. I rested.', 'stopped.', 'walked,', 'We walked, I rested.', []],
  ] as const) {
    const result = executeEditPlan(original, [{ id: 'p', ordinal: 1, lineIndex: 0, text: original }], 1, {
      schemaVersion: 2, draftVersion: 1, explanation: 'Replace.', operations: [{ id: 'replace', type: 'replace', target: { exactText: target }, text: replacement }],
    }, protectedTerms)
    assert.equal(result.ok && result.afterText, expected)
  }
})

test('supports insert, append, prepend, delete, and casing through the same pipeline', () => {
  const session = fixture()
  const result = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'safe multi edit',
    operations: [
      { id: 'one', type: 'case', target: { exactText: 'First' }, caseMode: 'uppercase' },
      { id: 'two', type: 'append', target: { paragraphOrdinal: 2 }, text: ' Appended.' },
    ],
  })
  assert.equal(
    result.ok && result.afterText,
    'FIRST mountain sentence.\n\nSecond paragraph here. Appended.',
  )
})

test('capitalizes every word in a targeted phrase', () => {
  const result = executeEditPlan('I watch the hawk-eyed scout.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'capitalize the phrase',
    operations: [
      {
        id: 'capitalize-phrase',
        type: 'case',
        target: { exactText: 'the hawk-eyed scout' },
        caseMode: 'capitalize',
      },
    ],
  })
  assert.equal(result.ok && result.afterText, 'I watch The Hawk-Eyed Scout.')
})

test('adds missing word boundaries for prepend and append operations', () => {
  const text = 'Existing sentence.'
  const paragraphs = [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text }]
  const result = executeEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'surround the paragraph with words',
    operations: [
      { id: 'prepend-word', type: 'prepend', target: { paragraphOrdinal: 1 }, text: 'before' },
      { id: 'append-word', type: 'append', target: { paragraphOrdinal: 1 }, text: 'after' },
    ],
  })

  assert.equal(result.ok && result.afterText, 'Before existing sentence. After')

  const continuation = executeEditPlan(
    'Existing fragment',
    [{ id: 'fragment', ordinal: 1, lineIndex: 0, text: 'Existing fragment' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'continue the current sentence',
      operations: [
        {
          id: 'append-continuation',
          type: 'append',
          target: { paragraphOrdinal: 1 },
          text: 'without capitalization',
        },
      ],
    },
  )
  assert.equal(
    continuation.ok && continuation.afterText,
    'Existing fragment without capitalization',
  )
})

test('adds deterministic paragraph boundaries for paragraph-targeted insertions', () => {
  const session = fixture()
  const after = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'insert a paragraph',
    operations: [
      {
        id: 'after-paragraph',
        type: 'insert_after',
        target: { paragraphOrdinal: 1 },
        text: 'inserted paragraph.',
      },
    ],
  })
  assert.equal(
    after.ok && after.afterText,
    'First mountain sentence.\n\nInserted paragraph.\n\nSecond paragraph here.',
  )

  const before = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'insert a paragraph',
    operations: [
      {
        id: 'before-paragraph',
        type: 'insert_before',
        target: { paragraphOrdinal: 1 },
        text: 'Opening paragraph.',
      },
    ],
  })
  assert.equal(
    before.ok && before.afterText,
    'Opening paragraph.\n\nFirst mountain sentence.\n\nSecond paragraph here.',
  )

  const afterFragment = executeEditPlan(
    'unfinished fragment\n\nSecond paragraph.',
    [
      { id: 'fragment', ordinal: 1, lineIndex: 0, text: 'unfinished fragment' },
      { id: 'second', ordinal: 2, lineIndex: 2, text: 'Second paragraph.' },
    ],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'insert after a non-terminal paragraph',
      operations: [
        {
          id: 'after-fragment',
          type: 'insert_after',
          target: { paragraphOrdinal: 1 },
          text: 'inserted paragraph.',
        },
      ],
    },
  )
  assert.equal(
    afterFragment.ok && afterFragment.afterText,
    'unfinished fragment\n\ninserted paragraph.\n\nSecond paragraph.',
  )
})

test('keeps insertion after the last sentence inside its paragraph', () => {
  const text = 'First sentence. You know?'
  const result = executeEditPlan(
    text,
    [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'Insert a sentence after the last sentence.',
      operations: [
        {
          id: 'after-last-sentence',
          type: 'insert_after',
          target: { paragraphOrdinal: 1, sentenceFromEnd: 1 },
          text: 'All right, I am going now.',
        },
      ],
    },
  )

  assert.equal(
    result.ok && result.afterText,
    'First sentence. You know? All right, I am going now.',
  )
})

test('keeps prepend and append inline and rejects inline selectors on them', () => {
  const text = 'First paragraph.\n\nSecond paragraph.'
  const paragraphs = [
    { id: 'first', ordinal: 1, lineIndex: 0, text: 'First paragraph.' },
    { id: 'second', ordinal: 2, lineIndex: 2, text: 'Second paragraph.' },
  ]
  const boundaryPlan: EditPlan = {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Keep both additions in their paragraphs.',
    operations: [
      {
        id: 'append-first',
        type: 'append',
        target: { paragraphOrdinal: 1 },
        text: 'Appended sentence.',
      },
      {
        id: 'prepend-second',
        type: 'prepend',
        target: { paragraphOrdinal: 2 },
        text: 'Prepended sentence.',
      },
    ],
  }
  const boundaryResult = executeEditPlan(text, paragraphs, 1, boundaryPlan)
  assert.equal(
    boundaryResult.ok && boundaryResult.afterText,
    'First paragraph. Appended sentence.\n\nPrepended sentence. Second paragraph.',
  )

  const invalid = executeEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'Do not silently ignore a sentence selector.',
    operations: [
      {
        id: 'invalid-append',
        type: 'append',
        target: { paragraphOrdinal: 1, sentenceFromEnd: 1 },
        text: 'Unsafe.',
      },
    ],
  })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.reason, 'append does not accept an inline target')
})

test('keeps exact-text insertions inline and adds only missing boundary spacing', () => {
  const session = fixture()
  const after = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'insert inline',
    operations: [
      {
        id: 'inline',
        type: 'insert_after',
        target: { paragraphOrdinal: 1, exactText: 'First' },
        text: 'difficult',
      },
    ],
  })
  assert.equal(
    after.ok && after.afterText,
    'First difficult mountain sentence.\n\nSecond paragraph here.',
  )

  const before = executeEditPlan(
    'I fill the bucket.',
    [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text: 'I fill the bucket.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'insert before a word',
      operations: [
        {
          id: 'inline-before',
          type: 'insert_before',
          target: { paragraphOrdinal: 1, exactText: 'fill' },
          text: 'will',
        },
      ],
    },
  )
  assert.equal(before.ok && before.afterText, 'I will fill the bucket.')

  const beforeSentenceOpening = executeEditPlan(
    'Today we leave.',
    [{ id: 'opening', ordinal: 1, lineIndex: 0, text: 'Today we leave.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'insert before the sentence opening',
      operations: [
        {
          id: 'before-opening',
          type: 'insert_before',
          target: { paragraphOrdinal: 1, exactText: 'Today' },
          text: 'perhaps',
        },
      ],
    },
  )
  assert.equal(
    beforeSentenceOpening.ok && beforeSentenceOpening.afterText,
    'Perhaps today we leave.',
  )

  const beforeProperNoun = executeEditPlan(
    'New York waits.',
    [{ id: 'proper-name', ordinal: 1, lineIndex: 0, text: 'New York waits.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'insert before a proper noun at the sentence opening',
      operations: [
        {
          id: 'before-proper-name',
          type: 'insert_before',
          target: { paragraphOrdinal: 1, exactText: 'New York' },
          text: 'perhaps',
        },
      ],
    },
  )
  assert.equal(beforeProperNoun.ok && beforeProperNoun.afterText, 'Perhaps New York waits.')

  const beforeKnownName = executeEditPlan(
    'Cooley waits.',
    [{ id: 'known-name', ordinal: 1, lineIndex: 0, text: 'Cooley waits.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'insert before a known one-word name',
      operations: [
        {
          id: 'before-known-name',
          type: 'insert_before',
          target: { paragraphOrdinal: 1, exactText: 'Cooley' },
          text: 'perhaps',
        },
      ],
    },
    ['Cooley'],
  )
  assert.equal(beforeKnownName.ok && beforeKnownName.afterText, 'Perhaps Cooley waits.')

  for (const calendarWord of ['Monday', 'January']) {
    const text = `${calendarWord} works for us.`
    const beforeCalendarTerm = executeEditPlan(
      text,
      [{ id: 'calendar-term', ordinal: 1, lineIndex: 0, text }],
      1,
      {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'insert before a calendar proper noun',
        operations: [
          {
            id: `before-${calendarWord}`,
            type: 'insert_before',
            target: { paragraphOrdinal: 1, exactText: calendarWord },
            text: 'perhaps',
          },
        ],
      },
    )
    assert.equal(
      beforeCalendarTerm.ok && beforeCalendarTerm.afterText,
      `Perhaps ${calendarWord} works for us.`,
    )
  }

  const alreadySpaced = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'preserve supplied spacing',
    operations: [
      {
        id: 'inline-spaced',
        type: 'insert_after',
        target: { paragraphOrdinal: 1, exactText: 'First' },
        text: ' difficult ',
      },
    ],
  })
  assert.equal(
    alreadySpaced.ok && alreadySpaced.afterText,
    'First difficult mountain sentence.\n\nSecond paragraph here.',
  )

  const afterSentence = executeEditPlan(
    'Hello. Goodbye.',
    [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text: 'Hello. Goodbye.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'preserve dictated casing after a sentence',
      operations: [
        {
          id: 'inline-after-sentence',
          type: 'insert_after',
          target: { paragraphOrdinal: 1, exactText: 'Hello.' },
          text: 'quietly',
        },
      ],
    },
  )
  assert.equal(afterSentence.ok && afterSentence.afterText, 'Hello. Quietly Goodbye.')

  const afterPhraseAtSentenceEnd = executeEditPlan(
    'She answered, “So, yeah.”',
    [{ id: 'quoted', ordinal: 1, lineIndex: 0, text: 'She answered, “So, yeah.”' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'insert after a phrase immediately before sentence punctuation',
      operations: [
        {
          id: 'after-terminal-phrase',
          type: 'insert_after',
          target: { paragraphOrdinal: 1, exactText: 'So, yeah' },
          text: 'are you clocking out soon?',
        },
      ],
    },
  )
  assert.equal(
    afterPhraseAtSentenceEnd.ok && afterPhraseAtSentenceEnd.afterText,
    'She answered, “So, yeah.” Are you clocking out soon?',
  )

  const literalPhraseAfterTarget = executeEditPlan(
    'She answered, “So, yeah.”',
    [{ id: 'literal-phrase', ordinal: 1, lineIndex: 0, text: 'She answered, “So, yeah.”' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'insert a phrase literally after its target',
      operations: [
        {
          id: 'literal-after-target',
          type: 'insert_after',
          target: { paragraphOrdinal: 1, exactText: 'So, yeah' },
          text: 'for now',
        },
      ],
    },
  )
  assert.equal(
    literalPhraseAfterTarget.ok && literalPhraseAfterTarget.afterText,
    'She answered, “So, yeah for now.”',
  )

  const punctuationOnlyAfterPhrase = executeEditPlan(
    'This is very good.',
    [{ id: 'punctuation', ordinal: 1, lineIndex: 0, text: 'This is very good.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'retain the exact attachment point for punctuation-only insertions',
      operations: [
        {
          id: 'closing-quote',
          type: 'insert_after',
          target: { paragraphOrdinal: 1, exactText: 'This is very good' },
          text: '”',
        },
      ],
    },
  )
  assert.equal(
    punctuationOnlyAfterPhrase.ok && punctuationOnlyAfterPhrase.afterText,
    'This is very good”.',
  )

  const appendAfterQuotedSentence = executeEditPlan(
    'She answered, “So, yeah.”',
    [{ id: 'append-quoted', ordinal: 1, lineIndex: 0, text: 'She answered, “So, yeah.”' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'append after the complete sentence ending',
      operations: [
        {
          id: 'append-after-terminal',
          type: 'append',
          target: { paragraphOrdinal: 1 },
          text: 'are you clocking out soon?',
        },
      ],
    },
  )
  assert.equal(
    appendAfterQuotedSentence.ok && appendAfterQuotedSentence.afterText,
    'She answered, “So, yeah.” Are you clocking out soon?',
  )

  for (const target of ['Ready?', 'Stop!', 'Wait…', 'She said "go."']) {
    const afterTerminalMark = executeEditPlan(
      target,
      [{ id: 'terminal', ordinal: 1, lineIndex: 0, text: target }],
      1,
      {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'capitalize after terminal punctuation',
        operations: [
          {
            id: 'after-terminal-mark',
            type: 'insert_after',
            target: { paragraphOrdinal: 1, exactText: target },
            text: 'continue',
          },
        ],
      },
    )
    assert.equal(afterTerminalMark.ok && afterTerminalMark.afterText, `${target} Continue`)
  }
})

test('attaches inserted quotation marks directly to an exact sentence target', () => {
  const text = 'She paused. This is very good. Then she continued.'
  const paragraphs = [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text }]

  for (const mark of ['"', "'"]) {
    const quoted = executeEditPlan(text, paragraphs, 1, {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'put quotations around the sentence',
      operations: [
        {
          id: `opening-${mark}`,
          type: 'insert_before',
          target: { paragraphOrdinal: 1, exactText: 'This is very good.' },
          text: mark,
        },
        {
          id: `closing-${mark}`,
          type: 'insert_after',
          target: { paragraphOrdinal: 1, exactText: 'This is very good.' },
          text: mark,
        },
      ],
    })

    assert.equal(
      quoted.ok && quoted.afterText,
      `She paused. ${mark}This is very good.${mark} Then she continued.`,
    )
  }
})

test('deletes an inclusive range across paragraphs and joins the remaining text safely', () => {
  const text = 'Before. I remember the time we met.\n\nMore words nearly in an instant she returned.'
  const plan = {
    schemaVersion: 2 as const, draftVersion: 1, explanation: 'Delete a passage.',
    operations: [{ id: 'range', type: 'delete_range' as const,
      target: { exactText: 'I remember the time' }, destination: { exactText: 'nearly in an instant' } }],
  }
  const result = executeEditPlan(text, [], 1, plan)
  assert.equal(result.ok && result.afterText, 'Before. She returned.')
  const comma = executeEditPlan('Before, start one.\n\nlast She returned.', [], 1, {
    ...plan, operations: [{ ...plan.operations[0]!, target: { exactText: 'start' }, destination: { exactText: 'last' } }],
  })
  assert.equal(comma.ok && comma.afterText, 'Before, she returned.')
  const reversed = executeEditPlan(text, [], 1, {
    ...plan, operations: [{ ...plan.operations[0]!, target: { exactText: 'nearly in an instant' }, destination: { exactText: 'I remember the time' } }],
  })
  assert.equal(reversed.ok, false)
  const ambiguous = executeEditPlan('start start end.', [], 1, {
    ...plan, operations: [{ ...plan.operations[0]!, target: { exactText: 'start' }, destination: { exactText: 'end' } }],
  })
  assert.equal(ambiguous.ok, false)
  for (const mark of ['.', '?', '!', '…', '...']) {
    const terminal = executeEditPlan(`Before, start words end${mark} She returned.`, [], 1, {
      ...plan, operations: [{ ...plan.operations[0]!, target: { exactText: 'start' }, destination: { exactText: 'end' } }],
    })
    assert.equal(terminal.ok && terminal.afterText, 'Before, she returned.')
    if (terminal.ok) assert.equal(terminal.operations[0]?.beforeText, `start words end${mark}`)
  }
  const inner = executeEditPlan('Before, start words end, she returned.', [], 1, {
    ...plan, operations: [{ ...plan.operations[0]!, target: { exactText: 'start' }, destination: { exactText: 'end' } }],
  })
  assert.equal(inner.ok && inner.afterText, 'Before, she returned.')
  for (const [before, after] of [
    [' ', ' '],
    ['   ', '  '],
    ['\t', '\t\t'],
    ['\n\n', '\n\n'],
    ['\n  ', '  \n'],
  ] as const) {
    const spaced = executeEditPlan(`Left${before}start removed end${after}right.`, [], 1, {
      ...plan, operations: [{ ...plan.operations[0]!, target: { exactText: 'start' }, destination: { exactText: 'end' } }],
    })
    assert.equal(spaced.ok && spaced.afterText, 'Left right.')
  }
  const attachedPunctuation = executeEditPlan('Left start words end, right.', [], 1, {
    ...plan, operations: [{ ...plan.operations[0]!, target: { exactText: 'start' }, destination: { exactText: 'end' } }],
  })
  assert.equal(attachedPunctuation.ok && attachedPunctuation.afterText, 'Left, right.')
})

test('deletion consumes one adjacent horizontal separator without touching other text', () => {
  const text = 'Keep this sentence. Remove this sentence.\n\nAnother paragraph.'
  const seeded = applyManualEdit(createDraftSession('delete-chat'), text, {
    expectedVersion: 0,
    editGroupId: 'seed-delete',
  })
  const trailingSentence = executeEditPlan(seeded.session.cleanText, seeded.session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete sentence',
    operations: [
      {
        id: 'delete-sentence',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: 'Remove this sentence.' },
      },
    ],
  })
  assert.equal(
    trailingSentence.ok && trailingSentence.afterText,
    'Keep this sentence.\n\nAnother paragraph.',
  )

  const middleWord = executeEditPlan(
    'Keep temporary wording.',
    [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text: 'Keep temporary wording.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete word',
      operations: [
        {
          id: 'delete-word',
          type: 'delete',
          target: { paragraphOrdinal: 1, exactText: 'temporary' },
        },
      ],
    },
  )
  assert.equal(middleWord.ok && middleWord.afterText, 'Keep wording.')

  const openingPhrase = executeEditPlan(
    'Digging a hole, it can disrupt the bugs living there.',
    [
      {
        id: 'opening-phrase-paragraph',
        ordinal: 1,
        lineIndex: 0,
        text: 'Digging a hole, it can disrupt the bugs living there.',
      },
    ],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete an opening phrase and its orphaned separator',
      operations: [
        {
          id: 'delete-opening-phrase',
          type: 'delete',
          target: { paragraphOrdinal: 1, exactText: 'Digging a hole' },
        },
      ],
    },
  )
  assert.equal(openingPhrase.ok && openingPhrase.afterText, 'it can disrupt the bugs living there.')

  const introductoryPhrase = executeEditPlan(
    'Most of the time, I feel quite happy.',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete an introductory phrase and its attached separator',
      operations: [
        {
          id: 'delete-introductory-phrase',
          type: 'delete',
          target: { exactText: 'Most of the time' },
        },
      ],
    },
  )
  assert.equal(introductoryPhrase.ok && introductoryPhrase.afterText, 'I feel quite happy.')

  for (const [punctuation, expected] of [
    ['.', 'I feel quite happy.'],
    ['?', 'I feel quite happy.'],
    ['!', 'I feel quite happy.'],
    ['…', 'I feel quite happy.'],
    ['—', 'I feel quite happy.'],
  ] as const) {
    const punctuatedPart = executeEditPlan(
      `Most of the time${punctuation} I feel quite happy.`,
      [],
      1,
      {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'delete a complete sentence part with attached punctuation',
        operations: [
          {
            id: `delete-punctuated-part-${punctuation}`,
            type: 'delete',
            target: { exactText: 'Most of the time' },
          },
        ],
      },
    )
    assert.equal(punctuatedPart.ok && punctuatedPart.afterText, expected)
  }

  for (const [opening, closing] of [
    ['"', '"'],
    ['‘', '’'],
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['<', '>'],
    ['`', '`'],
    ['*', '*'],
    ['**', '**'],
  ] as const) {
    const wrappedPhrase = executeEditPlan(
      `This is the ${opening}who's who${closing} of staff.`,
      [],
      1,
      {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'delete a phrase occupying an entire paired wrapper',
        operations: [
          {
            id: `delete-wrapped-phrase-${opening}`,
            type: 'delete',
            target: { exactText: "who's who" },
          },
        ],
      },
    )
    assert.equal(wrappedPhrase.ok && wrappedPhrase.afterText, 'This is the of staff.')
  }

  const partiallyWrappedPhrase = executeEditPlan(
    "This is the [who's who of staff] roster.",
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete only part of wrapped content',
      operations: [
        {
          id: 'delete-partially-wrapped-phrase',
          type: 'delete',
          target: { exactText: "who's who" },
        },
      ],
    },
  )
  assert.equal(
    partiallyWrappedPhrase.ok && partiallyWrappedPhrase.afterText,
    'This is the [of staff] roster.',
  )

  const finalQuotedSentence = executeEditPlan(
    '“I swear if I have to deal with these smug bastards again. Commonwealth.”',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete the final sentence inside a surrounding quotation',
      operations: [
        {
          id: 'delete-final-quoted-sentence',
          type: 'delete',
          target: { exactText: 'Commonwealth' },
        },
      ],
    },
  )
  assert.equal(
    finalQuotedSentence.ok && finalQuotedSentence.afterText,
    '“I swear if I have to deal with these smug bastards again.”',
  )

  for (const separator of [':', ';'] as const) {
    const quotedSentencePart = executeEditPlan(
      `"I swear if I have to deal with these smug bastards again. Commonwealth${separator}” I shake my head as I let out my snort.`,
      [],
      1,
      {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'delete an entire quoted sentence part and its attached separator',
        operations: [
          {
            id: `delete-quoted-part-${separator}`,
            type: 'delete',
            target: { exactText: 'Commonwealth' },
          },
        ],
      },
    )
    assert.equal(
      quotedSentencePart.ok && quotedSentencePart.afterText,
      '"I swear if I have to deal with these smug bastards again.” I shake my head as I let out my snort.',
    )
  }

  const middlePhraseBeforeComma = executeEditPlan(
    'Everyday they are digging a hole, despite the rain.',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'preserve punctuation after a phrase within a sentence',
      operations: [
        {
          id: 'delete-middle-phrase-before-comma',
          type: 'delete',
          target: { exactText: 'digging a hole' },
        },
      ],
    },
  )
  assert.equal(
    middlePhraseBeforeComma.ok && middlePhraseBeforeComma.afterText,
    'Everyday they are , despite the rain.',
  )

  const delimitedMiddlePhrase = executeEditPlan(
    'And I say to the sergeant, beginning speech, I have two full sheaves here.',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete a complete comma-delimited middle phrase',
      operations: [
        {
          id: 'delete-delimited-middle-phrase',
          type: 'delete',
          target: { exactText: 'beginning speech' },
        },
      ],
    },
  )
  assert.equal(
    delimitedMiddlePhrase.ok && delimitedMiddlePhrase.afterText,
    'And I say to the sergeant, I have two full sheaves here.',
  )
})

test('sentence-part deletion consumes adjacent terminal punctuation', () => {
  for (const [text, target, expected] of [
    ['Enough! Continue.', 'Enough', 'Continue.'],
    ['Not today? Continue.', 'Not today', 'Continue.'],
    ['Perhaps… Continue.', 'Perhaps', 'Continue.'],
    ['Wait... Continue.', 'Wait', 'Continue.'],
  ] as const) {
    const result = executeEditPlan(text, [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text }], 1, {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete a short sentence',
      operations: [
        {
          id: 'delete-short-sentence',
          type: 'delete',
          target: { paragraphOrdinal: 1, exactText: target },
          includeTrailingPunctuation: true,
        },
      ],
    })
    assert.equal(result.ok && result.afterText, expected)
  }

  const wordOnly = executeEditPlan(
    'Enough! Continue.',
    [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text: 'Enough! Continue.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete a word',
      operations: [
        {
          id: 'delete-word-only',
          type: 'delete',
          target: { paragraphOrdinal: 1, exactText: 'Enough' },
        },
      ],
    },
  )
  assert.equal(wordOnly.ok && wordOnly.afterText, 'Continue.')
})

test('deleting a whole sentence without a flag removes its period, but not a word inside a sentence', () => {
  const paragraphs = [
    { id: 'paragraph', ordinal: 1, lineIndex: 0, text: 'Keep this. End speech. Middle line.' },
  ]
  const whole = executeEditPlan('Keep this. End speech. Middle line.', paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete a whole sentence',
    operations: [
      { id: 'whole', type: 'delete', target: { paragraphOrdinal: 1, exactText: 'End speech' } },
    ],
  })
  assert.equal(whole.ok && whole.afterText, 'Keep this. Middle line.')

  const inside = executeEditPlan(
    'I said end speech. Done.',
    [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text: 'I said end speech. Done.' }],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'delete a phrase inside a sentence',
      operations: [
        { id: 'inside', type: 'delete', target: { paragraphOrdinal: 1, exactText: 'end speech' } },
      ],
    },
  )
  assert.equal(inside.ok && inside.afterText, 'I said . Done.')
})

test('a target that begins with the previous sentence punctuation never deletes that punctuation', () => {
  const text = 'I register those details. Begin speech. All right, there goes my first byte.'
  const plan = parseEditPlan({
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete the begin speech sentence',
    operations: [
      {
        id: 'delete-begin',
        type: 'delete',
        target: { paragraphOrdinal: 1, exactText: '. Begin speech' },
        includeTrailingPunctuation: true,
      },
    ],
  })
  assert.ok(plan)
  if (!plan) return
  const result = executeEditPlan(text, [{ id: 'p', ordinal: 1, lineIndex: 0, text }], 1, plan)
  assert.equal(
    result.ok && result.afterText,
    'I register those details. All right, there goes my first byte.',
  )
})

test('splits and joins paragraphs with controlled whitespace', () => {
  const seeded = applyManualEdit(
    createDraftSession('structure-chat'),
    'First sentence. Second sentence.\n\nClosing paragraph.',
    { expectedVersion: 0, editGroupId: 'seed-structure' },
  ).session
  const split = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'split paragraph',
    operations: [
      {
        id: 'split-one',
        type: 'split',
        target: { paragraphOrdinal: 1, exactText: 'First sentence.' },
      },
    ],
  })
  assert.equal(
    split.ok && split.afterText,
    'First sentence.\n\nSecond sentence.\n\nClosing paragraph.',
  )
  const join = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'join paragraphs',
    operations: [{ id: 'join-one', type: 'join_next', target: { paragraphOrdinal: 1 } }],
  })
  assert.equal(join.ok && join.afterText, 'First sentence. Second sentence. Closing paragraph.')
})

test('splits a sentence target after its terminal punctuation rather than an internal comma', () => {
  const text =
    'Opening sentence. The brief eruption of discussion seemed to die down once more, and the general passivity returned to campus. Friday arrived.'
  const seeded = applyManualEdit(createDraftSession('sentence-split-chat'), text, {
    expectedVersion: 0,
    editGroupId: 'seed-sentence-split',
  }).session
  const split = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'split after the sentence about the discussion',
    operations: [
      {
        id: 'split-sentence-at-terminal',
        type: 'split',
        target: {
          paragraphOrdinal: 1,
          exactText: 'The brief eruption of discussion seemed to die down once more,',
        },
        includeTrailingPunctuation: true,
      },
    ],
  })
  assert.equal(
    split.ok && split.afterText,
    'Opening sentence. The brief eruption of discussion seemed to die down once more, and the general passivity returned to campus.\n\nFriday arrived.',
  )
})

test('targets identical sentences by their ordinal position', () => {
  const text = 'Quotation. The middle sentence remains. Quotation.'
  const paragraphs = [{ id: 'paragraph', ordinal: 1, lineIndex: 0, text }]
  const first = executeEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete the first sentence',
    operations: [
      {
        id: 'delete-first-identical-sentence',
        type: 'delete',
        target: { paragraphOrdinal: 1, sentenceOrdinal: 1 },
        includeTrailingPunctuation: true,
      },
    ],
  })
  assert.equal(first.ok && first.afterText, 'The middle sentence remains. Quotation.')

  const last = executeEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete the last sentence',
    operations: [
      {
        id: 'delete-last-identical-sentence',
        type: 'delete',
        target: { paragraphOrdinal: 1, sentenceFromEnd: 1 },
        includeTrailingPunctuation: true,
      },
    ],
  })
  assert.equal(last.ok && last.afterText, 'Quotation. The middle sentence remains.')
})

test('moves paragraphs by captured identity and supports full-draft casing', () => {
  const seeded = applyManualEdit(createDraftSession('move-chat'), 'One.\n\nTwo.\n\nThree.', {
    expectedVersion: 0,
    editGroupId: 'seed-move',
  }).session
  const moved = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'move paragraph',
    operations: [
      {
        id: 'move-three',
        type: 'move_before',
        target: { paragraphId: seeded.paragraphs[2]!.id, paragraphOrdinal: 3 },
        destination: { paragraphId: seeded.paragraphs[0]!.id, paragraphOrdinal: 1 },
      },
    ],
  })
  assert.equal(moved.ok && moved.afterText, 'Three.\n\nOne.\n\nTwo.')
  if (moved.ok) {
    const committed = applyAutomatedEdit(seeded, moved.afterText, {
      expectedVersion: 1,
      operationId: 'move-commit',
      paragraphIdOrder: moved.resultingParagraphIds,
    }).session
    assert.deepEqual(
      committed.paragraphs.map((paragraph) => paragraph.id),
      [seeded.paragraphs[2]!.id, seeded.paragraphs[0]!.id, seeded.paragraphs[1]!.id],
    )
  }

  const cased = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'uppercase draft',
    operations: [
      { id: 'case-draft', type: 'case', target: { scope: 'draft' }, caseMode: 'uppercase' },
    ],
  })
  assert.equal(cased.ok && cased.afterText, 'ONE.\n\nTWO.\n\nTHREE.')
})

test('adjusts moved sentence casing after non-terminal punctuation but protects names and quoted speech', () => {
  for (const [moved, expected, protectedTerms] of [
    ['She looks back', 'she looks back', []],
    ['I look back', 'I look back', []],
    ['Erbold looks back', 'Erbold looks back', ['Erbold']],
    ['“She looks back”', '“She looks back”', []],
  ] as const) {
    for (const mark of [',', '—', ';', ':']) {
      const text = `${moved}. We wait${mark} today.`
      const result = executeEditPlan(text, [], 1, {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'Move text after punctuation.',
        operations: [{
          id: 'move', type: 'move_after', target: { exactText: moved },
          destination: { exactText: `wait${mark}` },
        }],
      }, protectedTerms)
      assert.equal(result.ok && result.afterText.includes(`wait${mark} ${expected}`), true)
    }
  }
})

test('moves an exact word or phrase before or after another text target', () => {
  const seeded = applyManualEdit(
    createDraftSession('inline-move-chat'),
    'Alpha beta gamma delta.\n\nEcho foxtrot golf.',
    { expectedVersion: 0, editGroupId: 'seed-inline-move' },
  ).session
  const movedAfter = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'move beta after gamma',
    operations: [
      {
        id: 'move-beta',
        type: 'move_after',
        target: { paragraphOrdinal: 1, exactText: 'beta' },
        destination: { paragraphOrdinal: 1, exactText: 'gamma' },
      },
    ],
  })
  assert.equal(
    movedAfter.ok && movedAfter.afterText,
    'Alpha gamma beta delta.\n\nEcho foxtrot golf.',
  )

  const movedAcrossParagraphs = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'move beta before golf',
    operations: [
      {
        id: 'move-beta-across',
        type: 'move_before',
        target: { paragraphOrdinal: 1, exactText: 'beta' },
        destination: { paragraphOrdinal: 2, exactText: 'golf' },
      },
    ],
  })
  assert.equal(
    movedAcrossParagraphs.ok && movedAcrossParagraphs.afterText,
    'Alpha gamma delta.\n\nEcho foxtrot beta golf.',
  )
  assert.deepEqual(
    movedAcrossParagraphs.ok && movedAcrossParagraphs.affectedParagraphOrdinals,
    [1, 2],
  )

  const sentenceTransition = applyManualEdit(
    createDraftSession('sentence-transition-move-chat'),
    'Quietly we leave. Tomorrow we rest.',
    { expectedVersion: 0, editGroupId: 'seed-sentence-transition' },
  ).session
  const movedToSentenceOpening = executeEditPlan(
    sentenceTransition.cleanText,
    sentenceTransition.paragraphs,
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'move the opening word before the next sentence',
      operations: [
        {
          id: 'move-to-opening',
          type: 'move_before',
          target: { exactText: 'Quietly' },
          destination: { exactText: 'Tomorrow' },
        },
      ],
    },
  )
  assert.equal(
    movedToSentenceOpening.ok && movedToSentenceOpening.afterText,
    'We leave. Quietly tomorrow we rest.',
  )

  const properNounTransition = applyManualEdit(
    createDraftSession('proper-name-move-chat'),
    'We leave soon. New York waits.',
    { expectedVersion: 0, editGroupId: 'seed-proper-name-transition' },
  ).session
  const movedBeforeProperNoun = executeEditPlan(
    properNounTransition.cleanText,
    properNounTransition.paragraphs,
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'move a word before a proper noun at a sentence opening',
      operations: [
        {
          id: 'move-before-proper-name',
          type: 'move_before',
          target: { exactText: 'soon' },
          destination: { exactText: 'New York' },
        },
      ],
    },
  )
  assert.equal(
    movedBeforeProperNoun.ok && movedBeforeProperNoun.afterText,
    'We leave. Soon New York waits.',
  )

  for (const calendarWord of ['Tuesday', 'March']) {
    const calendarTransition = applyManualEdit(
      createDraftSession(`calendar-${calendarWord}-move-chat`),
      `We leave soon. ${calendarWord} works for us.`,
      { expectedVersion: 0, editGroupId: `seed-calendar-${calendarWord}` },
    ).session
    const movedBeforeCalendarTerm = executeEditPlan(
      calendarTransition.cleanText,
      calendarTransition.paragraphs,
      1,
      {
        schemaVersion: 2,
        draftVersion: 1,
        explanation: 'move a word before a calendar proper noun',
        operations: [
          {
            id: `move-before-${calendarWord}`,
            type: 'move_before',
            target: { exactText: 'soon' },
            destination: { exactText: calendarWord },
          },
        ],
      },
    )
    assert.equal(
      movedBeforeCalendarTerm.ok && movedBeforeCalendarTerm.afterText,
      `We leave. Soon ${calendarWord} works for us.`,
    )
  }

  assert.ok(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'valid inline move',
      operations: [
        {
          id: 'valid-inline-move',
          type: 'move_before',
          target: { exactText: 'beta' },
          destination: { exactText: 'gamma' },
        },
      ],
    }),
  )
  assert.equal(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'invalid mixed move targets',
      operations: [
        {
          id: 'invalid-inline-move',
          type: 'move_before',
          target: { exactText: 'beta' },
          destination: { paragraphOrdinal: 2 },
        },
      ],
    }),
    null,
  )
})

test('moves terminal punctuation with a short sentence only when explicitly requested', () => {
  const text = 'Enough! Continue now.\n\nLater.'
  const paragraphs = [
    { id: 'first', ordinal: 1, lineIndex: 0, text: 'Enough! Continue now.' },
    { id: 'second', ordinal: 2, lineIndex: 2, text: 'Later.' },
  ]
  const sentenceMove = executeEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'move the sentence Enough after Later',
    operations: [
      {
        id: 'move-short-sentence',
        type: 'move_after',
        target: { paragraphOrdinal: 1, exactText: 'Enough' },
        destination: { paragraphOrdinal: 2, exactText: 'Later.' },
        includeTrailingPunctuation: true,
      },
    ],
  })
  assert.equal(sentenceMove.ok && sentenceMove.afterText, 'Continue now.\n\nLater. Enough!')
  assert.equal(sentenceMove.ok && sentenceMove.operations[0]?.beforeText, 'Enough!')

  const wordMove = executeEditPlan(text, paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'move the word Enough after Later',
    operations: [
      {
        id: 'move-word',
        type: 'move_after',
        target: { paragraphOrdinal: 1, exactText: 'Enough' },
        destination: { paragraphOrdinal: 2, exactText: 'Later.' },
      },
    ],
  })
  assert.equal(wordMove.ok && wordMove.afterText, '! Continue now.\n\nLater. Enough')
})

test('rejects ambiguous, overlapping, and unchanged inline moves atomically', () => {
  const seeded = applyManualEdit(createDraftSession('unsafe-inline-move'), 'red blue red green', {
    expectedVersion: 0,
    editGroupId: 'seed-unsafe-inline-move',
  }).session
  const basePlan = {
    schemaVersion: 2 as const,
    draftVersion: 1,
    explanation: 'unsafe inline move',
  }
  assert.deepEqual(
    executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
      ...basePlan,
      operations: [
        {
          id: 'ambiguous-source',
          type: 'move_before',
          target: { exactText: 'red' },
          destination: { exactText: 'green' },
        },
      ],
    }),
    { ok: false, reason: 'move source is ambiguous' },
  )
  assert.deepEqual(
    executeEditPlan('red blue green blue', seeded.paragraphs, 1, {
      ...basePlan,
      operations: [
        {
          id: 'ambiguous-destination',
          type: 'move_before',
          target: { exactText: 'red' },
          destination: { exactText: 'blue' },
        },
      ],
    }),
    { ok: false, reason: 'move destination is ambiguous' },
  )
  assert.deepEqual(
    executeEditPlan('alpha beta gamma', seeded.paragraphs, 1, {
      ...basePlan,
      operations: [
        {
          id: 'overlapping-move',
          type: 'move_after',
          target: { exactText: 'beta gamma' },
          destination: { exactText: 'gamma' },
        },
      ],
    }),
    { ok: false, reason: 'move source and destination overlap' },
  )
  assert.deepEqual(
    executeEditPlan('alpha beta gamma', seeded.paragraphs, 1, {
      ...basePlan,
      operations: [
        {
          id: 'unchanged-move',
          type: 'move_before',
          target: { exactText: 'beta' },
          destination: { exactText: 'gamma' },
        },
      ],
    }),
    { ok: false, reason: 'edit would not change the draft' },
  )
})

test('addresses punctuation by occurrence or its position relative to an anchor phrase', () => {
  const quoted = applyManualEdit(
    createDraftSession('punctuation-target-chat'),
    'He called it “good”, then said “this is very good”.',
    { expectedVersion: 0, editGroupId: 'seed-punctuation-target' },
  ).session
  const replaced = executeEditPlan(quoted.cleanText, quoted.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace the second quote',
    operations: [
      {
        id: 'replace-second-quote',
        type: 'replace',
        target: { paragraphOrdinal: 1, punctuation: 'quote', occurrence: 2 },
        text: '"',
      },
    ],
  })
  assert.equal(
    replaced.ok && replaced.afterText,
    'He called it “good", then said “this is very good”.',
  )

  const deleted = executeEditPlan(quoted.cleanText, quoted.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete the quote after the phrase',
    operations: [
      {
        id: 'delete-relative-quote',
        type: 'delete',
        target: {
          punctuation: 'quote',
          relativePosition: 'after',
          relativeToText: 'this is very good',
        },
      },
    ],
  })
  assert.equal(
    deleted.ok && deleted.afterText,
    'He called it “good”, then said “this is very good.',
  )

  const inserted = executeEditPlan(quoted.cleanText, quoted.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'insert before the comma',
    operations: [
      {
        id: 'insert-before-comma',
        type: 'insert_before',
        target: { punctuation: 'comma', occurrence: 1 },
        text: ' exactly',
      },
    ],
  })
  assert.equal(
    inserted.ok && inserted.afterText,
    'He called it “good” exactly, then said “this is very good”.',
  )

  const movable = applyManualEdit(
    createDraftSession('punctuation-move-chat'),
    'Alpha, beta gamma.',
    {
      expectedVersion: 0,
      editGroupId: 'seed-punctuation-move',
    },
  ).session
  const moved = executeEditPlan(movable.cleanText, movable.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'move the comma after beta',
    operations: [
      {
        id: 'move-comma',
        type: 'move_after',
        target: { punctuation: 'comma' },
        destination: { exactText: 'beta' },
      },
    ],
  })
  assert.equal(moved.ok && moved.afterText, 'Alpha beta, gamma.')

  const lastPeriod = executeEditPlan('One. “Two. Three. Four”.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete the last period',
    operations: [
      {
        id: 'delete-last-period',
        type: 'delete',
        target: { punctuation: 'period', occurrenceFromEnd: 1 },
      },
    ],
  })
  assert.equal(lastPeriod.ok && lastPeriod.afterText, 'One. “Two. Three. Four”')

  assert.deepEqual(
    executeEditPlan(quoted.cleanText, quoted.paragraphs, 1, {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'ambiguous quote',
      operations: [{ id: 'delete-quote', type: 'delete', target: { punctuation: 'quote' } }],
    }),
    { ok: false, reason: 'punctuation target is ambiguous' },
  )
})

test('rejects incompatible structural and inline operation groups atomically', () => {
  const session = fixture()
  const result = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'unsafe mixed group',
    operations: [
      { id: 'join', type: 'join_next', target: { paragraphOrdinal: 1 } },
      { id: 'replace', type: 'replace', target: { exactText: 'First' }, text: 'Opening' },
    ],
  })
  assert.deepEqual(result, {
    ok: false,
    reason: 'structural and inline operations cannot be mixed',
  })
})

test('allows an insertion at the start of a replaced range but not two insertions at one point', () => {
  const adjacent = executeEditPlan('Alpha beta gamma.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'insert before a replaced phrase',
    operations: [
      { id: 'open', type: 'insert_before', target: { exactText: 'Alpha' }, text: '“' },
      { id: 'replace', type: 'replace', target: { exactText: 'Alpha' }, text: 'Omega' },
    ],
  })
  assert.equal(adjacent.ok, true)
  if (adjacent.ok) assert.equal(adjacent.afterText, '“Omega beta gamma.')

  const tied = executeEditPlan('Alpha beta gamma.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'two insertions at one point',
    operations: [
      { id: 'open', type: 'insert_before', target: { exactText: 'Alpha' }, text: '“' },
      { id: 'single', type: 'insert_before', target: { exactText: 'Alpha' }, text: '‘' },
    ],
  })
  assert.deepEqual(tied, { ok: false, reason: 'edit operations overlap' })
})

test('never leaves a quotation mark floating outside paragraph text', () => {
  const floating = executeEditPlan('Alpha beta gamma.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'floating closing quote',
    operations: [
      {
        id: 'floating',
        type: 'replace',
        target: { exactText: 'gamma.' },
        text: 'gamma.\n\n”',
      },
    ],
  })
  assert.deepEqual(floating, {
    ok: false,
    reason: 'quotation mark would fall outside the paragraph',
  })

  const attached = executeEditPlan('Alpha beta gamma.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'attached quotes',
    operations: [
      { id: 'open', type: 'insert_before', target: { exactText: 'Alpha' }, text: '“' },
      { id: 'close', type: 'insert_after', target: { exactText: 'gamma.' }, text: '”' },
    ],
  })
  assert.equal(attached.ok, true)
  if (attached.ok) assert.equal(attached.afterText, '“Alpha beta gamma.”')
})

test('resolves one high-confidence approximate phrase and rejects equal candidates', () => {
  const seeded = applyManualEdit(
    createDraftSession('approximate-chat'),
    'We were coughing up a stomp near the summit.\n\nCamp was quiet.',
    { expectedVersion: 0, editGroupId: 'seed-approximate' },
  ).session
  const resolved = executeEditPlan(seeded.cleanText, seeded.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'correct approximate phrase',
    operations: [
      {
        id: 'approximate-replace',
        type: 'replace',
        target: { paragraphOrdinal: 1, approximateText: 'coughing up a storm' },
        text: 'coughing up a storm',
      },
    ],
  })
  assert.equal(
    resolved.ok && resolved.afterText,
    'We were coughing up a storm near the summit.\n\nCamp was quiet.',
  )

  const ambiguous = applyManualEdit(
    createDraftSession('approximate-duplicate'),
    'alpha betta alpha beta',
    {
      expectedVersion: 0,
      editGroupId: 'seed-duplicate',
    },
  ).session
  const rejected = executeEditPlan(ambiguous.cleanText, ambiguous.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'ambiguous approximate phrase',
    operations: [
      {
        id: 'approximate-ambiguous',
        type: 'replace',
        target: { approximateText: 'alpha beta' },
        text: 'gamma',
      },
    ],
  })
  assert.deepEqual(rejected, { ok: false, reason: 'approximate text target is ambiguous' })
})

test('falls back from a missing exact target to one unique fuzzy phrase', () => {
  const text = 'I look at her. Mao let her in return and step off the bed.'
  const resolved = executeEditPlan(text, [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace the uniquely similar spoken phrase',
    operations: [
      {
        id: 'fuzzy-exact-fallback',
        type: 'replace',
        target: { exactText: 'mauled her in return' },
        text: 'welcomed her back',
      },
    ],
  })
  assert.equal(
    resolved.ok && resolved.afterText,
    'I look at her. Welcomed her back and step off the bed.',
  )

  const providerCompound = executeEditPlan('I look at her. Mao let her in return.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace a provider-compounded spoken target',
    operations: [
      {
        id: 'provider-compound-fuzzy-fallback',
        type: 'replace',
        target: { exactText: 'mouthlet' },
        text: 'I smile at',
      },
    ],
  })
  assert.equal(
    providerCompound.ok && providerCompound.afterText,
    'I look at her. I smile at her in return.',
  )

  const shortWord = executeEditPlan('The form is ready.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace one unique short typo',
    operations: [
      {
        id: 'short-word-fuzzy-fallback',
        type: 'replace',
        target: { exactText: 'farm' },
        text: 'document',
      },
    ],
  })
  assert.equal(shortWord.ok && shortWord.afterText, 'The document is ready.')

  const prefixOfLongerWord = executeEditPlan('A precious sack rests nearby.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'replace a spoken near-match without leaving a word suffix behind',
    operations: [
      {
        id: 'whole-word-fuzzy-fallback',
        type: 'replace',
        target: { exactText: 'sac' },
        text: 'jewels',
      },
    ],
  })
  assert.equal(
    prefixOfLongerWord.ok && prefixOfLongerWord.afterText,
    'A precious jewels rests nearby.',
  )

  const deletedPrefixOfLongerWord = executeEditPlan('A precious sack rests nearby.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'delete a spoken near-match without leaving a word suffix behind',
    operations: [
      {
        id: 'whole-word-delete-fuzzy-fallback',
        type: 'delete',
        target: { exactText: 'sac' },
      },
    ],
  })
  assert.equal(
    deletedPrefixOfLongerWord.ok && deletedPrefixOfLongerWord.afterText,
    'A precious rests nearby.',
  )

  const ambiguous = executeEditPlan('Mao let one pass. Mao let two pass.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'do not guess between equal fuzzy targets',
    operations: [
      {
        id: 'ambiguous-fuzzy-exact-fallback',
        type: 'delete',
        target: { exactText: 'mouthlet' },
      },
    ],
  })
  assert.deepEqual(ambiguous, { ok: false, reason: 'fuzzy text target is ambiguous' })
})

test('fuzzy target matching tolerates similar-sounding consonants', () => {
  const result = executeEditPlan(
    'Erbold checks the road.',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'replace a provider-misheard name',
      operations: [
        {
          id: 'phonetic-consonants',
          type: 'replace',
          target: { exactText: 'Ervode' },
          text: 'the captain',
        },
      ],
    },
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.afterText, 'The captain checks the road.')
})

test('fuzzy target matching rejects short words with different consonant structures', () => {
  const result = executeEditPlan('Watt checks the road.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'do not conflate distinct short names',
    operations: [
      {
        id: 'distinct-short-name',
        type: 'replace',
        target: { exactText: 'Walt' },
        text: 'the scout',
      },
    ],
  })
  assert.deepEqual(result, { ok: false, reason: 'fuzzy text target was not found' })
})

test('ignores punctuation for unique text targets and uses it only to resolve lexical ties', () => {
  const unique = executeEditPlan('She answered, “So, yeah.”', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'match a uniquely worded target without requiring spoken punctuation',
    operations: [
      {
        id: 'punctuation-insensitive-unique',
        type: 'insert_after',
        target: { exactText: 'so yeah' },
        text: 'Are you clocking out soon?',
      },
    ],
  })
  assert.equal(
    unique.ok && unique.afterText,
    'She answered, “So, yeah.” Are you clocking out soon?',
  )

  const tieBroken = executeEditPlan('Wait here. Wait, here.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'use internal punctuation only to distinguish otherwise equal targets',
    operations: [
      {
        id: 'punctuation-tiebreaker',
        type: 'replace',
        target: { exactText: 'wait, here' },
        text: 'stay',
      },
    ],
  })
  assert.equal(tieBroken.ok && tieBroken.afterText, 'Wait here. Stay.')

  const ambiguous = executeEditPlan('Wait here. Wait here.', [], 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'do not guess when wording and punctuation are both identical',
    operations: [
      {
        id: 'punctuation-still-ambiguous',
        type: 'delete',
        target: { exactText: 'wait here' },
      },
    ],
  })
  assert.deepEqual(ambiguous, {
    ok: false,
    reason: 'punctuation-insensitive text target is ambiguous',
  })
})

test('matches spoken possessives as whole tokens and rejects repeated or unrelated candidates', () => {
  for (const [text, target, expected] of [
    ["Max's book is here.", 'Maxis', 'Meg’s book is here.'],
    ['Max’s book is here.', 'Maxis', 'Meg’s book is here.'],
    ['Erbold’s book is here.', 'Erbolds', 'Meg’s book is here.'],
    ['Lucas’s book is here.', 'Lucases', 'Meg’s book is here.'],
    ["Max's book is here.", 'Maxes', 'Meg’s book is here.'],
  ] as const) {
    const result = executeEditPlan(text, [], 1, {
      schemaVersion: 2, draftVersion: 1, explanation: 'Replace possessive.',
      operations: [{ id: 'replace', type: 'replace', target: { exactText: target }, text: 'Meg’s' }],
    })
    assert.equal(result.ok && result.afterText, expected)
  }
  const repeated = executeEditPlan("Max's book and Max’s coat.", [], 1, {
    schemaVersion: 2, draftVersion: 1, explanation: 'Replace possessive.',
    operations: [{ id: 'replace', type: 'replace', target: { exactText: 'Maxis' }, text: 'Meg’s' }],
  })
  assert.deepEqual(repeated, { ok: false, reason: 'possessive text target is ambiguous' })
  const unrelated = executeEditPlan("Maxwell's book.", [], 1, {
    schemaVersion: 2, draftVersion: 1, explanation: 'Replace possessive.',
    operations: [{ id: 'replace', type: 'replace', target: { exactText: 'Maxis' }, text: 'Meg’s' }],
  })
  assert.equal(unrelated.ok, false)
})

test('matches an expanded contraction against contracted draft text', () => {
  const expanded = executeEditPlan(
    "I set the groceries down, and before turning on the light, we're viewing an apartment that is modest.",
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'match an expanded contraction',
      operations: [
        {
          id: 'expanded-contraction',
          type: 'replace',
          target: { exactText: 'We are viewing an apartment' },
          text: 'reviewing an apartment',
        },
      ],
    },
  )
  assert.equal(
    expanded.ok && expanded.afterText,
    'I set the groceries down, and before turning on the light, reviewing an apartment that is modest.',
  )

  const contracted = executeEditPlan(
    'Before turning on the light, We are viewing an apartment.',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'match a contracted target',
      operations: [
        {
          id: 'contracted-target',
          type: 'replace',
          target: { exactText: "we're viewing an apartment" },
          text: 'reviewing an apartment',
        },
      ],
    },
  )
  assert.equal(
    contracted.ok && contracted.afterText,
    'Before turning on the light, reviewing an apartment.',
  )

  const colloquial = executeEditPlan(
    'We gotta wait until most of those are trapped in the funnel before they let loose the arrows.',
    [],
    1,
    {
      schemaVersion: 2,
      draftVersion: 1,
      explanation: 'match a colloquial contraction against its expanded target',
      operations: [
        {
          id: 'expanded-colloquial-contraction',
          type: 'replace',
          target: { exactText: 'we got to wait' },
          text: 'they are gonna wait',
        },
      ],
    },
  )
  assert.equal(
    colloquial.ok && colloquial.afterText,
    'They are gonna wait until most of those are trapped in the funnel before they let loose the arrows.',
  )
})
