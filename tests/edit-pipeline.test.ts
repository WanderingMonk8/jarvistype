import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAutomatedEdit,
  createDraftSession,
  applyManualEdit,
} from '../src/domain/draft-session'
import { executeEditPlan, parseEditPlan, type EditPlan } from '../src/domain/edit-pipeline'

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
  assert.equal(
    parseEditPlan({
      schemaVersion: 2,
      draftVersion: 1,
      explanation: '',
      operations: [{ id: 'one', type: 'execute_code', target: { paragraphOrdinal: 1 } }],
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
        text: 'Inserted paragraph.',
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
})

test('keeps exact-text insertions inline', () => {
  const session = fixture()
  const result = executeEditPlan(session.cleanText, session.paragraphs, 1, {
    schemaVersion: 2,
    draftVersion: 1,
    explanation: 'insert inline',
    operations: [
      {
        id: 'inline',
        type: 'insert_after',
        target: { paragraphOrdinal: 1, exactText: 'First' },
        text: ' difficult',
      },
    ],
  })
  assert.equal(
    result.ok && result.afterText,
    'First difficult mountain sentence.\n\nSecond paragraph here.',
  )
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
