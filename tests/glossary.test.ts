import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGlossaryState,
  learnExplicitSpelling,
  MAX_GLOSSARY_ENTRIES,
  toggleGlossaryPerformanceFixture,
  undoGlossaryMutation,
  upsertGlossaryEntry,
} from '../src/domain/glossary'

test('learns confirmed explicit spelling immediately and supports undo', () => {
  const learned = learnExplicitSpelling(
    createGlossaryState(),
    'Caesar',
    'C-A-E-S-A-R',
    '2026-01-01T00:00:00.000Z',
    () => 'caesar',
  )
  assert.equal(learned.entry?.canonical, 'Caesar')
  assert.equal(learned.state.entries[0]?.useCount, 1)
  assert.deepEqual(undoGlossaryMutation(learned.state).state.entries, [])
})

test('does not overwrite a conflicting canonical or variant', () => {
  const first = upsertGlossaryEntry(
    createGlossaryState(),
    { canonical: 'Ken', variants: ['can'], source: 'manual' },
    undefined,
    () => 'ken',
  )
  const conflict = upsertGlossaryEntry(
    first.state,
    { canonical: 'Can', variants: [], source: 'manual' },
    undefined,
    () => 'can',
  )
  assert.equal(conflict.changed, false)
  assert.equal(conflict.conflict?.canonical, 'Ken')
})

test('loads and removes a maximum-size performance fixture as atomic glossary changes', () => {
  const personal = upsertGlossaryEntry(
    createGlossaryState(),
    { canonical: 'Aurelia', variants: ['oh really uh'], source: 'manual' },
    '2026-01-01T00:00:00.000Z',
    () => 'personal-entry',
  ).state
  const seeded = toggleGlossaryPerformanceFixture(personal, '2026-01-02T00:00:00.000Z')
  assert.equal(seeded.changed, true)
  assert.equal(seeded.state.entries.length, MAX_GLOSSARY_ENTRIES)
  assert.equal(seeded.state.entries[0]?.canonical, 'Aurelia')
  assert.deepEqual(undoGlossaryMutation(seeded.state).state.entries, personal.entries)

  const removed = toggleGlossaryPerformanceFixture(seeded.state)
  assert.equal(removed.state.entries.length, 1)
  assert.equal(removed.state.entries[0]?.canonical, 'Aurelia')
})
