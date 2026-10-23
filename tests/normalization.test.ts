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

test('capitalizes ordinary message and paragraph openings without changing established casing', () => {
  assert.equal(
    normalizeDeterministically('we drift into sleep, holding each other through the night.', [])
      .text,
    'We drift into sleep, holding each other through the night.',
  )
  assert.equal(
    normalizeDeterministically('first thought new paragraph second thought period', []).text,
    'First thought\n\nSecond thought.',
  )
  assert.equal(normalizeDeterministically('eBay is ready.', []).text, 'eBay is ready.')
  assert.equal(
    normalizeDeterministically('lowercase remains lowercase', [], { capitalizeOpening: false })
      .text,
    'lowercase remains lowercase',
  )
  assert.equal(
    normalizeDeterministically('continuation new paragraph fresh thought', [], {
      capitalizeOpening: false,
    }).text,
    'continuation\n\nFresh thought',
  )
})

test('restores a missing sentence boundary after an opening My God interjection', () => {
  const result = normalizeDeterministically(
    'quotation My God Three mouths working on me period quotation',
    [],
  )

  assert.equal(result.text, '“My God. Three mouths working on me.”')
  assert.ok(result.reasons.includes('missing sentence boundary'))
  assert.ok(result.authoritativePunctuationMarks.includes('.'))

  assert.equal(
    normalizeDeterministically('She described My God Apollo as a marble statue.', []).text,
    'She described My God Apollo as a marble statue.',
  )
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
    'The semicolon is optional. An exclamation mark followed. A question mark appeared. The ellipsis means omission. The open parenthesis is unmatched. The close bracket is missing. A new line of products launched. The new paragraph discusses history. The Oxford comma was debated. The possessive apostrophe is required. Please quote the source and quote from the report. The quotation from the book was memorable. A single quotation is also discussed. A difficult period ended.'
  assert.equal(normalizeDeterministically(natural, []).text, natural)
  assert.equal(
    normalizeDeterministically('A lone quote remains literal.', []).text,
    'A lone quote remains literal.',
  )
  assert.equal(
    normalizeDeterministically('Quote one, quote two, and quote three.', []).text,
    'Quote one, quote two, and quote three.',
  )
  assert.equal(
    normalizeDeterministically('A lone quotation remains literal.', []).text,
    'A lone quotation remains literal.',
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
    normalizeDeterministically('Alpha begin bracket beta end bracket.', []).text,
    'Alpha <beta>.',
  )
  assert.equal(
    normalizeDeterministically('Alpha command begin bracket beta command end bracket', []).text,
    'Alpha <beta>',
  )
  assert.equal(
    normalizeDeterministically('The begin bracket play starts today period', []).text,
    'The begin bracket play starts today.',
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
    normalizeDeterministically('She said quotation proceed carefully quotation period', []).text,
    'She said “Proceed carefully”.',
  )
  assert.equal(
    normalizeDeterministically('Mark it single quotation provisional single quotation period', [])
      .text,
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
  assert.equal(
    normalizeDeterministically('Write the word quotation and literal single quotation period', [])
      .text,
    'Write quotation and single quotation.',
  )
  assert.equal(
    normalizeDeterministically('Alpha punctuation quotation beta punctuation single quotation', [])
      .text,
    'Alpha” beta’',
  )
  const authoritative = normalizeDeterministically('Alpha comma beta question mark', [])
  assert.deepEqual([...authoritative.authoritativePunctuationMarks].sort(), [',', '?'])
})

test('supports guarded speech quotation aliases without consuming natural usage', () => {
  assert.equal(
    normalizeDeterministically('begin speech hello there end speech period', []).text,
    '“Hello there”.',
  )
  assert.equal(
    normalizeDeterministically('begin single a private thought end single period', []).text,
    '‘A private thought’.',
  )
  assert.equal(
    normalizeDeterministically(
      'We begin speech therapy today and end speech therapy next week.',
      [],
    ).text,
    'We begin speech therapy today and end speech therapy next week.',
  )
  assert.equal(
    normalizeDeterministically('A lone begin speech remains literal.', []).text,
    'A lone begin speech remains literal.',
  )
  assert.equal(
    normalizeDeterministically('Say the phrase begin speech and the phrase end speech.', []).text,
    'Say begin speech and end speech.',
  )
})

test('recovers a closing end speech alias mistranscribed as and speech', () => {
  const repaired = normalizeDeterministically(
    'Begin speech. Hello there. Name your price and speech.',
    [],
  )
  assert.equal(repaired.text, '“Hello there. Name your price”.')
  assert.ok(repaired.reasons.includes('fuzzy spoken command recovery'))

  assert.equal(
    normalizeDeterministically('begin speech hello there and speech period', []).text,
    '“Hello there”.',
  )
  assert.equal(
    normalizeDeterministically('begin single a private thought and single period', []).text,
    '‘A private thought’.',
  )
  assert.equal(
    normalizeDeterministically('Begin speech. Hello there. Name your price and speech period', [])
      .text,
    '“Hello there. Name your price”.',
  )
})

test('accepts an article in the begin speech alias and keeps natural usage literal', () => {
  assert.equal(
    normalizeDeterministically('Begin the speech. Well, there you go. You know. End speech.', [])
      .text,
    '“Well, there you go. You know.”',
  )
  assert.equal(
    normalizeDeterministically(
      'We begin the speech therapy today and end speech therapy next week.',
      [],
    ).text,
    'We begin the speech therapy today and end speech therapy next week.',
  )
})

test('leaves and speech literal without an unmatched opening alias', () => {
  const literal = [
    'I made a toast and speech.',
    'We begin speech therapy today and speech practice tomorrow.',
    'Begin speech. The phrase price and speech costs money.',
  ]
  for (const text of literal) {
    assert.equal(normalizeDeterministically(text, []).text, text)
  }
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

test('drops a provider period attached to a closing quote command after terminal punctuation', () => {
  assert.equal(normalizeDeterministically('quote Good morning. quote.', []).text, '“Good morning.”')
  assert.equal(normalizeDeterministically('open quote Really? close quote.', []).text, '“Really?”')
  assert.equal(normalizeDeterministically('quote Good morning quote.', []).text, '“Good morning”.')
  assert.equal(
    normalizeDeterministically('quote You knew my coffee order, quote. I repeat her words.', [])
      .text,
    '“You knew my coffee order,” I repeat her words.',
  )
  assert.equal(
    normalizeDeterministically(
      'quote You knew my coffee order comma quote. I repeat her words.',
      [],
    ).text,
    '“You knew my coffee order,” I repeat her words.',
  )
})

test('does not duplicate provider-rendered quotation marks beside spoken quote commands', () => {
  assert.equal(
    normalizeDeterministically(
      'I listen to her confession. Quote, "You knew my coffee order." Quote, I repeat her words. Quote, “So I guess we are even.” Quote.',
      [],
    ).text,
    'I listen to her confession. “You knew my coffee order.” I repeat her words. “So I guess we are even.”',
  )
  assert.equal(
    normalizeDeterministically('She said single quote, ‘Hello.’ single quote.', []).text,
    'She said ‘Hello.’',
  )
  assert.equal(
    normalizeDeterministically(
      'I listen. Quote, "You knew my coffee order," Quote. I repeat her words.',
      [],
    ).text,
    'I listen. “You knew my coffee order,” I repeat her words.',
  )
  assert.equal(
    normalizeDeterministically('She preserved "literal straight quotes" without commands.', [])
      .text,
    'She preserved "literal straight quotes" without commands.',
  )
  assert.equal(
    normalizeDeterministically(
      'I listen. Quotation, “You knew my coffee order.” Quotation, and respond.',
      [],
    ).text,
    'I listen. “You knew my coffee order.” and respond.',
  )
})

test('prunes provider punctuation attached to every spoken command family', () => {
  assert.equal(normalizeDeterministically('Hello comma.', []).text, 'Hello,')
  assert.equal(normalizeDeterministically('Ready question mark.', []).text, 'Ready?')
  assert.equal(
    normalizeDeterministically('First period. new paragraph. Second period.', []).text,
    'First.\n\nSecond.',
  )
  assert.equal(
    normalizeDeterministically('Alpha open parenthesis. aside period close parenthesis.', []).text,
    'Alpha (aside.)',
  )
  assert.equal(
    normalizeDeterministically('Alpha open bracket. beta close bracket.', []).text,
    'Alpha [beta].',
  )
  assert.equal(normalizeDeterministically('Use punctuation colon.', []).text, 'Use:')
  assert.equal(normalizeDeterministically('Use punctuation open quote.', []).text, 'Use “')
  assert.equal(
    normalizeDeterministically('quote Hello quote, and then we left period', []).text,
    '“Hello” and then we left.',
  )
  assert.equal(
    normalizeDeterministically(
      'Alpha open parenthesis, aside period close parenthesis, beta period',
      [],
    ).text,
    'Alpha (aside.) beta.',
  )
  assert.equal(
    normalizeDeterministically('quote Ready to leave quote? and then we left period', []).text,
    '“Ready to leave”? and then we left.',
  )
  assert.equal(normalizeDeterministically('Hello comma, world period', []).text, 'Hello, world.')
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
  const defaultCasing = normalizeDeterministically('Use C-O-O-L-E-Y period', [])
  assert.equal(defaultCasing.text, 'Use cooley.')
  assert.deepEqual(defaultCasing.learningCandidates, [
    { canonical: 'cooley', spokenVariant: 'C-O-O-L-E-Y' },
  ])
  assert.deepEqual(defaultCasing.ambiguities, [])
  assert.equal(
    normalizeDeterministically('Use capitalized C-O-O-L-E-Y period', []).text,
    'Use Cooley.',
  )
  assert.equal(
    normalizeDeterministically('Use uppercase C-O-O-L-E-Y period', []).text,
    'Use COOLEY.',
  )
  assert.equal(
    normalizeDeterministically('Use lowercase C-O-O-L-E-Y period', []).text,
    'Use cooley.',
  )
  assert.equal(normalizeDeterministically('Use C-O-O-L-E-Y, Cooley period', []).text, 'Use Cooley.')

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
  assert.equal(
    normalizeDeterministically('Use capitalized K-A-T-apostrophe-S period', []).text,
    'Use Kat’s.',
  )
  assert.equal(
    normalizeDeterministically('Use capitalized O-apostrophe-C-O-N-N-O-R period', []).text,
    'Use O’Connor.',
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
