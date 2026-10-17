import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDeterministically } from '../src/domain/normalization'

test('supports spoken punctuation and paragraph commands', () => {
  const result = normalizeDeterministically(
    'Hello comma world question mark new paragraph Next period',
    [],
  )
  assert.equal(result.text, 'Hello, world?\n\nNext.')
  assert.equal(result.changed, true)
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
})

test('supports expanded punctuation commands and explicit fallbacks', () => {
  assert.equal(
    normalizeDeterministically(
      'Label semi colon value colon open single quote ready close single quote ellipsis',
      [],
    ).text,
    'Label; value: ‘ready’…',
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
    normalizeDeterministically('Write the word dash and the word ellipsis period', []).text,
    'Write dash and ellipsis.',
  )
  assert.equal(
    normalizeDeterministically('She said quote proceed carefully quote period', []).text,
    'She said “proceed carefully”.',
  )
  assert.equal(
    normalizeDeterministically('Mark it single quote provisional single quote period', []).text,
    'Mark it ‘provisional’.',
  )
  assert.equal(
    normalizeDeterministically('The quote from the book was memorable period', []).text,
    'The quote from the book was memorable.',
  )
  assert.equal(
    normalizeDeterministically('Write the word quote and literal single quote period', []).text,
    'Write quote and single quote.',
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
