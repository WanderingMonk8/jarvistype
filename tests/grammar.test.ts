import assert from 'node:assert/strict'
import test from 'node:test'

import { hasAmbiguousArticleIssue, repairDeterministicGrammar } from '../src/domain/grammar'

test('repairs article agreement for unambiguous vowels and consonants', () => {
  const repaired = repairDeterministicGrammar(
    'This is a accessible entrance. Wait an house. A apple fell.',
  )
  assert.equal(repaired.text, 'This is an accessible entrance. Wait a house. An apple fell.')
  assert.deepEqual(repaired.changes, [
    'Changed “a” to “an” before “accessible”.',
    'Changed “an” to “a” before “house”.',
    'Changed “A” to “An” before “apple”.',
  ])
})

test('repairs silent-h and consonant-sound-u articles', () => {
  assert.equal(
    repairDeterministicGrammar('Wait a hour. This is an user. We saw a European.').text,
    'Wait an hour. This is a user. We saw a European.',
  )
  assert.equal(
    repairDeterministicGrammar('It was a unique and an historic building.').text,
    'It was a unique and an historic building.',
  )
})

test('leaves uncertain article sounds alone but reports them', () => {
  const text = 'This is a umbrella stand.'
  assert.equal(repairDeterministicGrammar(text).text, text)
  assert.equal(hasAmbiguousArticleIssue(text), true)
  assert.equal(hasAmbiguousArticleIssue('This is an umbrella stand.'), true)
  assert.equal(hasAmbiguousArticleIssue('This is a unique entrance.'), false)
  assert.equal(hasAmbiguousArticleIssue('This is an accessible entrance.'), false)
})

test('does not repair all-caps articles or article targets', () => {
  const text = 'AN apple. a an example.'
  assert.equal(repairDeterministicGrammar(text).text, text)
})

test('collapses repeated function words without touching valid repetition', () => {
  assert.equal(
    repairDeterministicGrammar('The the draft has has an issue.').text,
    'The draft has an issue.',
  )
  assert.equal(repairDeterministicGrammar('She had had enough.').text, 'She had had enough.')
})

test('collapses repeated spaces away from sentence boundaries', () => {
  assert.equal(repairDeterministicGrammar('One  two   three.').text, 'One two three.')
  assert.equal(
    repairDeterministicGrammar('First.  Second stays spaced.').text,
    'First.  Second stays spaced.',
  )
})

test('removes spaces before punctuation and collapses repeated separators', () => {
  assert.equal(
    repairDeterministicGrammar('He paused , then left ;; quietly.').text,
    'He paused, then left; quietly.',
  )
  assert.equal(repairDeterministicGrammar('Then he waited ...').text, 'Then he waited ...')
})

test('is idempotent and leaves clean text untouched', () => {
  const texts = [
    'This is a accessible entrance.',
    'The the draft has has an issue , really.',
    'Clean sentence, nothing wrong.',
    'This is a umbrella stand.',
  ]
  for (const text of texts) {
    const once = repairDeterministicGrammar(text)
    const twice = repairDeterministicGrammar(once.text)
    assert.equal(twice.text, once.text)
    assert.equal(twice.changes.length, 0)
  }
})
