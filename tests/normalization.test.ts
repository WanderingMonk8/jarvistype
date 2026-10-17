import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeDeterministically,
  recoverHighConfidenceContextualCommands,
} from '../src/domain/normalization'

test('supports spoken punctuation and paragraph commands', () => {
  const result = normalizeDeterministically(
    'Hello comma world question mark new paragraph Next period',
    [],
  )
  assert.equal(result.text, 'Hello, world?\n\nNext.')
  assert.equal(result.changed, true)
})

test('does not append a bare terminal command after provider terminal punctuation', () => {
  assert.equal(normalizeDeterministically('Is this working? period', []).text, 'Is this working?')
  assert.equal(normalizeDeterministically('Really! full stop.', []).text, 'Really!')
  assert.equal(normalizeDeterministically('Done. period.', []).text, 'Done.')
  assert.equal(normalizeDeterministically('Wait… period', []).text, 'Wait…')
  assert.equal(normalizeDeterministically('How is that? ."', []).text, 'How is that?"')
  assert.equal(normalizeDeterministically('Really? question mark', []).text, 'Really?')
  assert.equal(normalizeDeterministically('Really! exclamation mark', []).text, 'Really!')
  assert.equal(normalizeDeterministically('Wait… ellipsis', []).text, 'Wait…')
  assert.equal(normalizeDeterministically('Really? exclamation mark', []).text, 'Really?!')
  assert.equal(normalizeDeterministically('Really! question mark', []).text, 'Really!?')
  assert.equal(
    normalizeDeterministically('This happened (really?) period', []).text,
    'This happened (really?).',
  )
  assert.equal(
    normalizeDeterministically('Is this working? insert period', []).text,
    'Is this working?.',
  )
})

test('preserves a paragraph command at the start of a recording segment', () => {
  const result = normalizeDeterministically(
    'New paragraph. It is often assumed that those who work harder tend to be more successful. Period.',
    [],
  )

  assert.equal(
    result.text,
    '\n\nIt is often assumed that those who work harder tend to be more successful.',
  )
  assert.equal(result.reasons.includes('new paragraph'), true)
})

test('preserves explicitly literal punctuation words', () => {
  assert.equal(
    normalizeDeterministically('Use the word period here period', []).text,
    'Use period here.',
  )
  assert.equal(
    normalizeDeterministically('Use the word period here, period.', []).text,
    'Use period here.',
  )
  assert.equal(
    normalizeDeterministically('The period of time is challenging for many period', []).text,
    'The period of time is challenging for many.',
  )
  assert.equal(
    normalizeDeterministically('Add a dash of salt comma then stir period', []).text,
    'Add a dash of salt, then stir.',
  )
  assert.equal(
    normalizeDeterministically('The colon cancer screening period ended period', []).text,
    'The colon cancer screening period ended.',
  )
  assert.equal(
    normalizeDeterministically(
      'Discuss the phrase new paragraph comma literal open parenthesis comma and the words question mark period',
      [],
    ).text,
    'Discuss new paragraph, open parenthesis, and question mark.',
  )
})

test('preserves punctuation vocabulary in ordinary noun and verb contexts', () => {
  const natural =
    'The semicolon is optional. An exclamation mark followed. A question mark appeared. The ellipsis means omission. The open parenthesis is unmatched. The close bracket is missing. A new line of products launched. The new paragraph discusses history. The Oxford comma was debated. The possessive apostrophe is required. Please quote the source and quote from the report. A difficult period ended.'
  assert.equal(normalizeDeterministically(natural, []).text, natural)
  assert.equal(
    normalizeDeterministically('A lone quote remains literal.', []).text,
    'A lone quote remains literal.',
  )
  assert.equal(
    normalizeDeterministically('Quote one, quote two, and quote three.', []).text,
    'Quote one, quote two, and quote three.',
  )
})

test('supports expanded punctuation commands and explicit fallbacks', () => {
  assert.equal(
    normalizeDeterministically(
      'Label semi colon value colon open single quote ready close single quote ellipsis',
      [],
    ).text,
    'Label; value: ‘Ready’…',
  )
  assert.equal(
    normalizeDeterministically('First dash second em dash third en dash fourth period', []).text,
    'First — second — third – fourth.',
  )
  assert.equal(
    normalizeDeterministically('Wait dot dot dot what question mark', []).text,
    'Wait… what?',
  )
  assert.equal(
    normalizeDeterministically('Use punctuation colon then insert period', []).text,
    'Use: then.',
  )
  assert.equal(
    normalizeDeterministically(
      'Alpha command open parenthesis beta command close parenthesis command new line gamma command open bracket delta command close bracket',
      [],
    ).text,
    'Alpha (beta)\ngamma [delta]',
  )
  assert.equal(
    normalizeDeterministically('Alpha punctuation quote beta punctuation single quote', []).text,
    'Alpha” beta’',
  )
  assert.equal(
    normalizeDeterministically('Write the word dash and the word ellipsis period', []).text,
    'Write dash and ellipsis.',
  )
  assert.equal(
    normalizeDeterministically('She said quote proceed carefully quote period', []).text,
    'She said “Proceed carefully”.',
  )
  assert.equal(
    normalizeDeterministically('Mark it single quote provisional single quote period', []).text,
    'Mark it ‘Provisional’.',
  )
  assert.equal(
    normalizeDeterministically('The quote from the book was memorable period', []).text,
    'The quote from the book was memorable.',
  )
  assert.equal(
    normalizeDeterministically('Write the word quote and literal single quote period', []).text,
    'Write quote and single quote.',
  )
  const authoritative = normalizeDeterministically('Alpha comma beta question mark', [])
  assert.deepEqual([...authoritative.authoritativePunctuationMarks].sort(), [',', '?'])
})

test('formats voice-generated quotation openings without changing intentional leading punctuation', () => {
  assert.equal(
    normalizeDeterministically('quote, and I am not going anywhere quote.', []).text,
    '“And I am not going anywhere”.',
  )
  assert.equal(normalizeDeterministically('open quote, hello close quote.', []).text, '“Hello”.')
  assert.equal(
    normalizeDeterministically('quote eBay is ready quote.', []).text,
    '“eBay is ready”.',
  )
  assert.equal(
    normalizeDeterministically('quote punctuation ellipsis and then quote.', []).text,
    '“… and then”.',
  )
  assert.equal(
    normalizeDeterministically('“and I am not going anywhere.”', []).text,
    '“and I am not going anywhere.”',
  )
})

test('recovers a standalone phonetic new-paragraph command without changing natural prose', () => {
  assert.equal(
    recoverHighConfidenceContextualCommands(
      'That completes the introduction. New pair of graph. Our second concern is cost.',
    ).text,
    'That completes the introduction.\n\nOur second concern is cost.',
  )
  assert.equal(
    recoverHighConfidenceContextualCommands('I compared a new pair of graphs.').text,
    'I compared a new pair of graphs.',
  )
})

test('collapses explicit spelling, obeys casing, and creates a learning candidate', () => {
  const result = normalizeDeterministically('Write capitalized C-A-E-S-A-R Caesar period', [])
  assert.equal(result.text, 'Write Caesar.')
  assert.deepEqual(result.learningCandidates, [
    { canonical: 'Caesar', spokenVariant: 'C-A-E-S-A-R' },
  ])
  assert.equal(
    normalizeDeterministically('Write capitalized C A E S A R, Caesar period', []).text,
    'Write Caesar.',
  )
  assert.equal(
    normalizeDeterministically('Write capitalized P-I-P dash B-O-Y Pip-Boy period', []).text,
    'Write Pip-Boy.',
  )
})

test('collapses guarded compact spelling emitted by speech-to-text', () => {
  const result = normalizeDeterministically('Write, capitalize PIP-Boy, Pip-Boy, period.', [])
  assert.equal(result.text, 'Write Pip-Boy.')
  assert.deepEqual(result.learningCandidates, [{ canonical: 'Pip-Boy', spokenVariant: 'PIP-Boy' }])
  assert.equal(
    normalizeDeterministically('Please use API-client without a spelling command', []).text,
    'Please use API-client without a spelling command',
  )
  assert.equal(normalizeDeterministically('Write, capitalize PIP-BOY.', []).text, 'Write Pip-Boy.')
  assert.equal(
    normalizeDeterministically('Write, capitalized P. I. P. dash B. O. Y, Pip-Boy, period.', [])
      .text,
    'Write Pip-Boy.',
  )
})

test('uses glossary variants without paraphrasing surrounding content', () => {
  const result = normalizeDeterministically('My pip boy is ready', [
    {
      id: 'entry-1',
      canonical: 'Pip-Boy',
      variants: ['pip boy'],
      hint: 'Fallout device',
      source: 'manual',
      useCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ])
  assert.equal(result.text, 'My Pip-Boy is ready')
})
