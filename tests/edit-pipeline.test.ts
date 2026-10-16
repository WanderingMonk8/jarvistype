import assert from 'node:assert/strict'
import test from 'node:test'

import { createDraftSession, applyManualEdit } from '../src/domain/draft-session'
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
    schemaVersion: 1,
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
    schemaVersion: 1 as const,
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
    schemaVersion: 1,
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
