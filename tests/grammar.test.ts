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
  assert.equal(repairDeterministicGrammar(text, { capitalizeSentenceStarts: false }).text, text)
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

test('capitalizes sentence openings without touching abbreviations or domains', () => {
  assert.equal(
    repairDeterministicGrammar('this is a test. it continues. another one.').text,
    'This is a test. It continues. Another one.',
  )
  assert.equal(
    repairDeterministicGrammar('Mr.Smith met Dr.Jones. U.S.Army arrived.').text,
    'Mr.Smith met Dr.Jones. U.S.Army arrived.',
  )
  assert.equal(
    repairDeterministicGrammar('example.com is here. another one.').text,
    'example.com is here. Another one.',
  )
  assert.equal(repairDeterministicGrammar('the the cat').text, 'The cat')
})

test('does not capitalize inside quotations or protected terms', () => {
  assert.equal(
    repairDeterministicGrammar('He said. “hello there” and left.').text,
    'He said. “hello there” and left.',
  )
  assert.equal(
    repairDeterministicGrammar('“this starts inside”', { insideQuoteAtStart: true }).text,
    '“this starts inside”',
  )
  assert.equal(
    repairDeterministicGrammar('ebay is here', { protectedTerms: ['ebay'] }).text,
    'ebay is here',
  )
  assert.equal(
    repairDeterministicGrammar('this is a test', { capitalizeSentenceStarts: false }).text,
    'this is a test',
  )
})

test('normalizes errant punctuation left behind by edits', () => {
  assert.equal(
    repairDeterministicGrammar('This is fine., Next one.').text,
    'This is fine. Next one.',
  )
  assert.equal(repairDeterministicGrammar('What?.').text, 'What?')
  assert.equal(repairDeterministicGrammar('Really.! Next.').text, 'Really! Next.')
  assert.equal(repairDeterministicGrammar('word,.').text, 'Word.')
  assert.equal(repairDeterministicGrammar('word..').text, 'Word.')
  assert.equal(repairDeterministicGrammar('word;;.').text, 'Word.')
  assert.equal(repairDeterministicGrammar('Wait...?').text, 'Wait...?')
  assert.equal(repairDeterministicGrammar('word!?').text, 'Word!?')
  assert.equal(repairDeterministicGrammar('“Stop!”, she shouted.').text, '“Stop!”, she shouted.')
})

test('inserts missing spaces after punctuation without breaking numbers or URLs', () => {
  assert.equal(repairDeterministicGrammar('Hello.World').text, 'Hello. World')
  assert.equal(repairDeterministicGrammar('a,b').text, 'A, b')
  assert.equal(repairDeterministicGrammar('key:value').text, 'Key: value')
  assert.equal(repairDeterministicGrammar('10,000 items').text, '10,000 items')
  assert.equal(repairDeterministicGrammar('10:30 start').text, '10:30 start')
  assert.equal(repairDeterministicGrammar('example.com is here').text, 'example.com is here')
})

test('removes spaces inside quotation marks and brackets', () => {
  assert.equal(repairDeterministicGrammar('He said “ hello ”.').text, 'He said “hello”.')
  assert.equal(repairDeterministicGrammar('See ( note ).').text, 'See (note).')
})

test('leaves speech tags, file names, domains, and URLs intact', () => {
  assert.equal(
    repairDeterministicGrammar('He said “Stop.” she left.').text,
    'He said “Stop.” she left.',
  )
  assert.equal(repairDeterministicGrammar('file.Txt').text, 'file.Txt')
  assert.equal(repairDeterministicGrammar('example.com is here').text, 'example.com is here')
  assert.equal(
    repairDeterministicGrammar('https://example.com/?a=b').text,
    'https://example.com/?a=b',
  )
})
