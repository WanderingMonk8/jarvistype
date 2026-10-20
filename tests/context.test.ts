import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampContextMessageCount,
  correctFromConversationReferences,
  extractConversationReferences,
  selectRecentContext,
} from '../src/domain/context'

test('defaults and bounds the user-configurable context count', () => {
  assert.equal(clampContextMessageCount(undefined), 5)
  assert.equal(clampContextMessageCount(-4), 0)
  assert.equal(clampContextMessageCount(99), 20)
  assert.equal(clampContextMessageCount(7.8), 7)
})

test('selects newest eligible visible user and assistant text within a hard ceiling', () => {
  const result = selectRecentContext(
    [
      { role: 'system', content: 'secret system text' },
      { role: 'user', content: 'old user' },
      { role: 'assistant', content: 'hidden', metadata: { hidden: true } },
      { role: 'assistant', content: 'recent assistant' },
      { role: 'user', content: 'newest user' },
    ],
    3,
    20,
  )
  assert.deepEqual(result.messages, [
    { role: 'assistant', content: 'assistant' },
    { role: 'user', content: 'newest user' },
  ])
  assert.equal(result.characterCount, 20)
  assert.equal(result.truncated, true)
})

test('zero excludes chat history entirely', () => {
  const result = selectRecentContext([{ role: 'user', content: 'hello' }], 0)
  assert.deepEqual(result.messages, [])
  assert.equal(result.omittedCount, 1)
})

test('extracts compact proper-name and specialized-term references from conversation context', () => {
  assert.deepEqual(
    extractConversationReferences([
      { role: 'assistant', content: 'The expedition is led by Captain Caelora Venn.' },
      { role: 'user', content: 'Her Pip-Boy connects to Vault-Tec Relay 7.' },
    ]),
    [
      'Captain Caelora Venn',
      'Captain',
      'Caelora',
      'Venn',
      'Pip-Boy',
      'Vault-Tec Relay',
      'Vault-Tec',
      'Relay',
    ],
  )
  assert.deepEqual(
    extractConversationReferences([{ role: 'user', content: 'Ordinary sentence.' }], 0),
    [],
  )
})

test('corrects only a unique one-character proper-name match from conversation references', () => {
  assert.deepEqual(
    correctFromConversationReferences('Yanniko waved while Kensai picked up Kensai’s plate.', [
      'Yaniko',
      'Kansai',
      'Kenji',
      'Northern Survey',
    ]),
    {
      text: 'Yaniko waved while Kansai picked up Kansai’s plate.',
      correctedTerms: [
        { heard: 'Yanniko', canonical: 'Yaniko' },
        { heard: 'Kensai', canonical: 'Kansai' },
        { heard: 'Kensai', canonical: 'Kansai' },
      ],
    },
  )
})

test('corrects a unique two-character name ending only after a stable prefix', () => {
  assert.deepEqual(correctFromConversationReferences('Willie carried the lamp.', ['Willum']), {
    text: 'Willum carried the lamp.',
    correctedTerms: [{ heard: 'Willie', canonical: 'Willum' }],
  })
  assert.equal(
    correctFromConversationReferences('Willie carried the lamp.', ['Willum', 'Willem']).text,
    'Willie carried the lamp.',
  )
  assert.equal(
    correctFromConversationReferences('Kensay carried the lamp.', ['Kansai']).text,
    'Kensay carried the lamp.',
  )
})

test('corrects a unique short phonetic name and preserves its possessive apostrophe', () => {
  assert.deepEqual(correctFromConversationReferences("Cat's coat matched Cat’s boots.", ['Kat’s']), {
    text: "Kat's coat matched Kat’s boots.",
    correctedTerms: [
      { heard: 'Cat', canonical: 'Kat' },
      { heard: 'Cat', canonical: 'Kat' },
    ],
  })
  assert.equal(correctFromConversationReferences("cat's coat", ['Kat']).text, "cat's coat")
  assert.equal(correctFromConversationReferences("Cat's coat", ['Kat', 'Qat']).text, "Cat's coat")
})

test('leaves ambiguous, lowercase, and protected wording unchanged', () => {
  assert.equal(
    correctFromConversationReferences(
      'Kensai met kansai and Yaneko.',
      ['Kansai', 'Kensai', 'Yaniko'],
      ['Yaneko'],
    ).text,
    'Kensai met kansai and Yaneko.',
  )
})
