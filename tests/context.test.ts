import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampContextMessageCount,
  correctEditTargetFromConversationReferences,
  correctFromConversationReferences,
  extractCardCharacterReferences,
  extractConversationReferences,
  selectRecentContext,
  selectRecentReferenceContext,
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

test('reference context retains the configured number of recent assistant messages', () => {
  const source = Array.from({ length: 6 }, (_, index) => [
    { role: 'assistant' as const, content: index === 1 ? 'Aiko appears here.' : `Assistant ${index}` },
    { role: 'user' as const, content: `User ${index}` },
  ]).flat()

  const result = selectRecentReferenceContext(source, 5)

  assert.ok(result.messages.some((message) => message.content.includes('Aiko')))
  assert.equal(result.messages.filter((message) => message.role === 'assistant').length, 5)
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

test('extracts the canonical name from a descriptive card title', () => {
  assert.deepEqual(
    extractConversationReferences([
      { role: 'assistant', content: 'Aiko the tired worker' },
    ]),
    ['Aiko'],
  )
})

test('extracts both first and full character names from the card', () => {
  const references = extractCardCharacterReferences(
    'Aiko - The Tired Worker',
    'Aiko Tanaka has worked the late shift for three years.',
  )
  assert.ok(references.includes('Aiko'))
  assert.ok(references.includes('Aiko Tanaka'))
})

test('extracts every named character from an ensemble card', () => {
  const references = extractCardCharacterReferences(
    'Night Shift Roommates',
    'Aiko Tanaka works beside Hana Sato. Later, Marcus joins Aiko and Hana for dinner.',
  )
  for (const expected of ['Aiko Tanaka', 'Aiko', 'Hana Sato', 'Hana', 'Marcus']) {
    assert.ok(references.includes(expected), `missing ${expected}`)
  }
})

test('falls back to title names when the card body never mentions them', () => {
  const references = extractCardCharacterReferences(
    'Carrie Fishborn',
    'A tired worker closes the pharmacy after the morning shift.',
  )
  for (const expected of ['Carrie Fishborn', 'Carrie', 'Fishborn']) {
    assert.ok(references.includes(expected), `missing ${expected}`)
  }
})

test('keeps only title references corroborated by the card body when available', () => {
  const references = extractCardCharacterReferences(
    'Aiko - The Tired Worker',
    'Aiko Tanaka works the late shift.',
  )
  assert.ok(references.includes('Aiko'))
  assert.equal(references.includes('Tired Worker'), false)
})

test('when the reference cap is reached, earlier input (the newest messages) keeps its terms', () => {
  assert.deepEqual(
    extractConversationReferences(
      [
        { role: 'user', content: 'Tessa Quill arrived.' },
        { role: 'assistant', content: 'Mara Velin waited.' },
      ],
      'Tessa Quill'.length + 2,
    ),
    ['Tessa Quill'],
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

test('corrects lowercase edit targets from one unique proper-name reference', () => {
  assert.deepEqual(correctEditTargetFromConversationReferences('herbode', ['Herbold']), {
    text: 'Herbold',
    correctedTerms: [{ heard: 'herbode', canonical: 'Herbold' }],
  })
  assert.equal(
    correctEditTargetFromConversationReferences('herbode', ['Herbold', 'Herbode']).text,
    'herbode',
  )
})

test('draft-extracted proper nouns can correct lowercase edit targets', () => {
  const references = extractConversationReferences([
    {
      role: 'assistant',
      content: "Ten paces back. I'll sooner trust you, Herbold, than the captain.",
    },
  ])
  assert.ok(references.includes('Herbold'))
  assert.equal(
    correctEditTargetFromConversationReferences('herbode', references).text,
    'Herbold',
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

test('corrects a two-character length difference after a stable name prefix', () => {
  assert.deepEqual(correctFromConversationReferences('Carrie Fishbourne', ['Fishborn']), {
    text: 'Carrie Fishborn',
    correctedTerms: [{ heard: 'Fishbourne', canonical: 'Fishborn' }],
  })
})

test('corrects a unique short phonetic name and preserves its possessive apostrophe', () => {
  assert.deepEqual(
    correctFromConversationReferences("Cat's coat matched Cat’s boots.", ['Kat’s']),
    {
      text: "Kat's coat matched Kat’s boots.",
      correctedTerms: [
        { heard: 'Cat', canonical: 'Kat' },
        { heard: 'Cat', canonical: 'Kat' },
      ],
    },
  )
  assert.equal(correctFromConversationReferences("cat's coat", ['Kat']).text, "cat's coat")
  assert.equal(correctFromConversationReferences("Cat's coat", ['Kat', 'Qat']).text, "Cat's coat")
})

test('corrects a short phonetically equivalent card name', () => {
  assert.deepEqual(correctFromConversationReferences('ICO', ['Aiko']), {
    text: 'Aiko',
    correctedTerms: [{ heard: 'ICO', canonical: 'Aiko' }],
  })
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
