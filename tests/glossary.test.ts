import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGlossaryState,
  glossaryEntriesForChat,
  learnExplicitSpelling,
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

test('keeps local glossary entries in their chat while global entries appear everywhere', () => {
  const local = upsertGlossaryEntry(
    createGlossaryState(),
    { canonical: 'Erbold', source: 'manual', scope: 'local', chatId: 'chat-a' },
    undefined,
    () => 'local-erbold',
  )
  const global = upsertGlossaryEntry(
    local.state,
    { canonical: 'Watt', source: 'manual', scope: 'global' },
    undefined,
    () => 'global-watt',
  )

  assert.deepEqual(
    glossaryEntriesForChat(global.state, 'chat-a').map((entry) => entry.canonical),
    ['Erbold', 'Watt'],
  )
  assert.deepEqual(
    glossaryEntriesForChat(global.state, 'chat-b').map((entry) => entry.canonical),
    ['Watt'],
  )
})

test('allows the same glossary spelling in different local chats', () => {
  const first = upsertGlossaryEntry(
    createGlossaryState(),
    { canonical: 'Aiko', source: 'manual', scope: 'local', chatId: 'chat-a' },
  )
  const second = upsertGlossaryEntry(first.state, {
    canonical: 'Aiko',
    source: 'manual',
    scope: 'local',
    chatId: 'chat-b',
  })
  assert.equal(second.changed, true)
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
