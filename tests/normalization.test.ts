import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasUnresolvedCommandSignal,
  normalizeDeterministically,
  normalizeQualifiedAsInReferences,
  recoverHighConfidenceContextualCommands,
} from '../src/domain/normalization'

test('uses qualified as-in spelling references in recording text', () => {
  assert.equal(
    normalizeQualifiedAsInReferences(
      'I move slowly to pick up the sheaf, as in sheaf of arrows and the bow from the water, shaking them slightly.',
    ).text,
    'I move slowly to pick up the sheaf and the bow from the water, shaking them slightly.',
  )
  assert.equal(
    normalizeQualifiedAsInReferences('I put the sheath, as in sheaf of arrows, on the cart.').text,
    'I put the sheaf on the cart.',
  )
})

test('keeps ordinary as-in prose literal', () => {
  for (const text of [
    'The arrangement stayed as in previous years.',
    'I worked as in the example.',
    'I described the building, as in the structure beside us.',
  ]) {
    assert.equal(normalizeQualifiedAsInReferences(text).text, text)
  }
})

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

test('consumes a capitalized phrase command even when the provider already title-cased it', () => {
  const result = normalizeDeterministically(
    'I turn to watch the man of capitalized White Hawk.',
    [],
  )
  assert.equal(result.text, 'I turn to watch the man of White Hawk.')
  assert.ok(result.reasons.includes('spoken casing'))
  assert.equal(
    normalizeDeterministically('We discussed the use of capitalized words.', []).text,
    'We discussed the use of capitalized words.',
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
  assert.equal(normalizeDeterministically('Really! exclamation', []).text, 'Really!')
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

test('deduplicates a provider-rendered exclamation before a speech-closing command', () => {
  assert.equal(
    normalizeDeterministically('Begin speech. That is close enough! Exclamation. End speech.', [])
      .text,
    '“That is close enough!”',
  )
  assert.equal(
    normalizeDeterministically('Begin speech that is close enough exclamation end speech', []).text,
    '“That is close enough!”',
  )
  assert.equal(
    normalizeDeterministically('His exclamation startled everyone period', []).text,
    'His exclamation startled everyone.',
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

test('flags unresolved spoken command words without flagging ordinary prose', () => {
  assert.equal(hasUnresolvedCommandSignal('We went to the store and bought milk.'), false)
  assert.equal(hasUnresolvedCommandSignal('Coffee at the shop tomorrow.'), false)
  assert.equal(hasUnresolvedCommandSignal('Begin the speach here.'), true)
  assert.equal(hasUnresolvedCommandSignal('She said period.'), true)
  assert.equal(hasUnresolvedCommandSignal('Another dash here'), true)
})

test('a dash the provider already rendered is not doubled by a spoken dash', () => {
  assert.equal(
    normalizeDeterministically("Can, that's — dash you're here.", []).text,
    "Can, that's — you're here.",
  )
  assert.equal(
    normalizeDeterministically("Can, that's — — you're here.", []).text,
    "Can, that's — you're here.",
  )
  assert.equal(normalizeDeterministically('Wait — dash. Next.', []).text, 'Wait — Next.')
})

test('boundary punctuation commands replace the sentence punctuation before them', () => {
  assert.equal(
    normalizeDeterministically('She was laughing. Dash. Him, loud.', []).text,
    'She was laughing — Him, loud.',
  )
  assert.equal(normalizeDeterministically('Are you sure. Question mark', []).text, 'Are you sure?')
  assert.equal(normalizeDeterministically('Wow. Exclamation mark', []).text, 'Wow!')
  assert.equal(
    normalizeDeterministically('Let me think. Comma and then go.', []).text,
    'Let me think, and then go.',
  )
  assert.equal(normalizeDeterministically('Hello. Period', []).text, 'Hello.')
  assert.equal(
    normalizeDeterministically('Look at the word dash here.', []).text,
    'Look at dash here.',
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
    normalizeDeterministically(
      'beginning speech I have two full sheaves here ending speech period',
      [],
    ).text,
    '“I have two full sheaves here”.',
  )
  assert.equal(
    normalizeDeterministically('beginning speech mixed aliases work end speech period', []).text,
    '“Mixed aliases work”.',
  )
  assert.equal(
    normalizeDeterministically('begins speech this alias works too ends speech period', []).text,
    '“This alias works too”.',
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
    normalizeDeterministically(
      'We are beginning speech therapy today and ending speech therapy next week.',
      [],
    ).text,
    'We are beginning speech therapy today and ending speech therapy next week.',
  )
  assert.equal(
    normalizeDeterministically(
      'The class begins speech therapy today and ends speech therapy next week.',
      [],
    ).text,
    'The class begins speech therapy today and ends speech therapy next week.',
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

test('recovers a closing end speech alias misheard as and a speech', () => {
  assert.equal(
    normalizeDeterministically('Begin the speech. Well, you know. And a speech.', []).text,
    '“Well, you know.”',
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
  assert.equal(normalizeDeterministically('Use capitalized ERBOLD period', []).text, 'Use Erbold.')
  assert.equal(normalizeDeterministically('Use lowercase ERBOLD period', []).text, 'Use erbold.')
  assert.equal(normalizeDeterministically('Use uppercase ERBOLD period', []).text, 'Use ERBOLD.')
  assert.equal(normalizeDeterministically('Use NASA period', []).text, 'Use NASA.')
  const compactEditSpelling = normalizeDeterministically('Replace SHEATH with SHEAF.', [], {
    compactUppercaseSpelling: true,
  })
  assert.equal(compactEditSpelling.text, 'Replace sheath with sheaf.')
  assert.deepEqual(compactEditSpelling.learningCandidates, [
    { canonical: 'sheath', spokenVariant: 'SHEATH' },
    { canonical: 'sheaf', spokenVariant: 'SHEAF' },
  ])
  assert.equal(
    normalizeDeterministically('NASA launched capitalized ERBOLD period', []).text,
    'NASA launched Erbold.',
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

test('applies only the strict casing words as dictation casing commands', () => {
  assert.equal(
    normalizeDeterministically('I look to the capitalized white hawk.', []).text,
    'I look to the White Hawk.',
  )
  assert.equal(
    normalizeDeterministically('I look to the lowercase white hawk.', []).text,
    'I look to the white hawk.',
  )
  assert.equal(
    normalizeDeterministically('I look to the uppercase white hawk.', []).text,
    'I look to the WHITE HAWK.',
  )
  assert.equal(
    normalizeDeterministically('I look to the all caps white hawk.', []).text,
    'I look to the WHITE HAWK.',
  )
  assert.equal(normalizeDeterministically('Capitalize the hawk.', []).text, 'Capitalize the hawk.')
  assert.equal(
    normalizeDeterministically('I believe uppercase, the white hawk.', []).text,
    'I believe THE WHITE HAWK.',
  )
  for (const prose of [
    'Lowercase remains lowercase.',
    'They capitalized the company.',
    'Use a lowercase letter here.',
    'The word uppercase is a verb.',
    'It is in all caps for the title.',
    'I look to the lowercase white hawk and the gull.',
  ]) {
    assert.equal(normalizeDeterministically(prose, []).text, prose)
  }
})
