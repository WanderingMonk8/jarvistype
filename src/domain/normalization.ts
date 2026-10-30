import type { GlossaryEntry } from './glossary'
import { areSpeechPhoneticNeighbors } from './phonetics'

export interface SpellingLearningCandidate {
  canonical: string
  spokenVariant: string
}

export interface DeterministicNormalization {
  text: string
  changed: boolean
  reasons: string[]
  learningCandidates: SpellingLearningCandidate[]
  ambiguities: string[]
  authoritativePunctuationLiterals: string[]
  authoritativePunctuationMarks: string[]
}

export interface ContextualCommandRecovery {
  text: string
  reasons: string[]
}

export interface QualifiedAsInNormalization {
  text: string
  changed: boolean
}

export const SPOKEN_PUNCTUATION_COMMAND_PHRASES = [
  'new paragraph',
  'new line',
  'open parenthesis',
  'open paren',
  'close parenthesis',
  'close paren',
  'open bracket',
  'close bracket',
  'begin bracket',
  'end bracket',
  'question mark',
  'exclamation',
  'exclamation mark',
  'exclamation point',
  'semicolon',
  'semi colon',
  'semi-colon',
  'comma',
  'colon',
  'full stop',
  'period',
  'ellipsis',
  'dot dot dot',
  'three dots',
  'em dash',
  'en dash',
  'hyphen',
  'dash',
  'apostrophe',
  'asterisk',
  'open quote',
  'close quote',
  'quote',
  'quotation',
  'open single quote',
  'close single quote',
  'single quote',
  'single quotation',
  'begin speech',
  'end speech',
  'beginning speech',
  'ending speech',
  'begins speech',
  'ends speech',
  'begin single',
  'end single',
] as const

const PUNCTUATION: Array<[RegExp, string, string]> = [
  [/\bnew paragraph\b([.,;:!?…—–-]*)/gi, '\n\n', 'new paragraph'],
  [/\bnew line\b([.,;:!?…—–-]*)/gi, '\n', 'new line'],
  [/\bopen (?:parenthesis|paren)\b([.,;:!?…—–-]*)/gi, '(', 'open parenthesis'],
  [/\bclose (?:parenthesis|paren)\b([.,;:!?…—–-]*)/gi, ')', 'close parenthesis'],
  [/\bopen bracket\b([.,;:!?…—–-]*)/gi, '[', 'open bracket'],
  [/\bclose bracket\b([.,;:!?…—–-]*)/gi, ']', 'close bracket'],
  [/\bbegin bracket\b([.,;:!?…—–-]*)/gi, '<', 'begin bracket'],
  [/\bend bracket\b([.,;:!?…—–-]*)/gi, '>', 'end bracket'],
  [/\bquestion mark\b([.,;:!?…—–-]*)/gi, '?', 'question mark'],
  [/\bexclamation(?: (?:mark|point))?\b([.,;:!?…—–-]*)/gi, '!', 'exclamation mark'],
  [/\bsemi[ -]?colon\b([.,;:!?…—–-]*)/gi, ';', 'semicolon'],
  [/\bcolon\b([.,;:!?…—–-]*)/gi, ':', 'colon'],
  [/\bcomma\b([.,;:!?…—–-]*)/gi, ',', 'comma'],
  [/\bfull stop\b([.,;:!?…—–-]*)/gi, '.', 'period'],
  [/\bperiod\b([.,;:!?…—–-]*)/gi, '.', 'period'],
  [/\b(?:ellipsis|dot dot dot|three dots)\b([.,;:!?…—–-]*)/gi, '…', 'ellipsis'],
  [/\bem dash\b([.,;:!?…—–-]*)/gi, '—', 'em dash'],
  [/\ben dash\b([.,;:!?…—–-]*)/gi, '–', 'en dash'],
  [/\bhyphen\b([.,;:!?…—–-]*)/gi, '-', 'hyphen'],
  [/\bdash\b([.,;:!?…—–-]*)/gi, '—', 'em dash'],
  [/\bapostrophe\b([.,;:!?…—–-]*)/gi, '’', 'apostrophe'],
  [/\basterisk\b([.,;:!?…—–-]*)/gi, '*', 'asterisk'],
]

/**
 * A spoken mark that replaces the boundary (“dash”, “question mark”, “comma”, …)
 * replaces the period that speech-to-text placed before it. Other terminal marks
 * stay, since combinations such as “?!” are explicit and intentional.
 */
const TERMINAL_BEFORE_BOUNDARY_COMMAND = new RegExp(
  '\\.+(?=\\s*\\b(?:question mark|exclamation(?: (?:mark|point))?|ellipsis|dot dot dot|three dots|em dash|en dash|hyphen|dash|semi[ -]?colon|colon|comma)\\b)',
  'giu',
)

const SPOKEN_PUNCTUATION_TERM_SOURCE =
  'open single quote|close single quote|open quote|close quote|single quotation|single quote|beginning speech|ending speech|begins speech|ends speech|begin speech|end speech|begin single|end single|quotation|quote|new paragraph|new line|open (?:parenthesis|paren)|close (?:parenthesis|paren)|open bracket|close bracket|begin bracket|end bracket|question mark|exclamation(?: (?:mark|point))?(?!\\s+(?:mark|point)\\b)|semi[ -]?colon|colon|comma|full stop|period|ellipsis|dot dot dot|three dots|em dash|en dash|hyphen|dash|apostrophe|asterisk'

const LITERAL_PUNCTUATION_CONTEXTS: RegExp[] = [
  /\bperiod(?=\s+(?:of|piece|drama|costume|between|during|when|where|in|was|is|lasted|ended|began)\b)/gi,
  /\btime\s+period\b/gi,
  /\bdash(?=\s+(?:of|to|for|toward|through|across)\b)/gi,
  /\b(?:mad|quick|hundred-meter)\s+dash\b/gi,
  /\bcolon(?=\s+(?:cancer|health|screening|surgery|disease|pain|care)\b)/gi,
  /\b(?:begin|end)\s+bracket\b(?=\s+(?:play|tournament|competition|round|stage|season|game|match|format|system|structure)\b)/gi,
  /\b(?:quote|quotation)(?=\s+(?:from|by|about|of)\b)/gi,
  /\b(?:please|to|I|we|you|they|he|she|and)\s+(?:quote|quotation)\b/gi,
  /\b(?:brief|long|short|difficult|historical|modern|colonial|same|previous|current)\s+period\b/gi,
  /\b(?:Oxford|serial)\s+comma\b/gi,
  /\bpossessive\s+apostrophe\b/gi,
  new RegExp(
    `\\b(?:a|an|the|this|that|these|those|my|your|his|her|our|their|its|another|each|every)\\s+(?:${SPOKEN_PUNCTUATION_TERM_SOURCE})\\b`,
    'gi',
  ),
  new RegExp(
    `\\b(?:${SPOKEN_PUNCTUATION_TERM_SOURCE})\\b(?=\\s+(?:word|words|phrase|term|command|symbol|character|punctuation|mark|is|are|was|were|means|refers|appears|appeared|follows|followed|begins|starts|ends|contains|discusses|describes|explains|has|looks|seems|should|must|can|of|in|from|by|about|notation|key|item|range|products|code|text|separated)\\b)`,
    'gi',
  ),
]

const COMMAND_SIGNAL_WORDS = [
  'period',
  'comma',
  'colon',
  'semicolon',
  'question',
  'exclamation',
  'ellipsis',
  'dash',
  'hyphen',
  'quotation',
  'quote',
  'paragraph',
  'speech',
  'apostrophe',
  'asterisk',
  'parenthesis',
  'bracket',
]

function withinEditDistance(left: string, right: string, maximum: number): boolean {
  if (Math.abs(left.length - right.length) > maximum) return false
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length]! <= maximum
}

/**
 * True when text still contains a word that looks like an unresolved spoken command,
 * either exactly or with a small transcription error. Used to decide whether the
 * contextual provider pass can add anything; false positives only cost time.
 */
export function hasUnresolvedCommandSignal(text: string): boolean {
  // Known mishearing of “new paragraph”, which the provider prompt also documents.
  if (/\bpair\s+of\s+graphs?\b/iu.test(text)) return true
  // Common split-word recognition of “asterisk”; contextual classification still
  // decides whether it is a command or ordinary prose.
  if (/\baster\s+risk\b/iu.test(text)) return true
  for (const match of text.matchAll(/\p{L}+/gu)) {
    const word = match[0].toLocaleLowerCase()
    if (COMMAND_SIGNAL_WORDS.includes(word)) return true
    if (word.length < 5) continue
    const maximum = word.length >= 8 ? 2 : 1
    if (COMMAND_SIGNAL_WORDS.some((command) => withinEditDistance(word, command, maximum)))
      return true
  }
  return false
}

// Only these four casing words are dictation casing commands. The phrase after the word is the
// target: "I look to the capitalized white hawk" → "I look to the White Hawk".
const CASING_COMMAND_PATTERN =
  /\b(capitalized|lowercase|uppercase|all caps)[ \t]*[,:]?[ \t]+((?:[\p{L}\p{M}\d'’-]+[ \t]*){1,4}?)(?=[.!?,;:]|\n|$)/giu

function titleCaseWords(value: string): string {
  return value.replace(/\p{L}[\p{L}\p{M}]*(?:['’]\p{L}+)*/gu, (word) => {
    const index = word.search(/\p{L}/u)
    return `${word.slice(0, index)}${word[index]!.toLocaleUpperCase()}${word.slice(index + 1)}`
  })
}

// Words that make a casing word prose rather than a command: "a lowercase letter", "in all caps",
// "the word uppercase", "they capitalized the company".
const CASING_PROSE_PRECEDERS = new Set([
  'a',
  'an',
  'in',
  'as',
  'word',
  'words',
  'phrase',
  'term',
  'command',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'it',
])
// Function words that cannot appear in a casing target phrase; their presence means the phrase
// runs into the rest of a sentence.
const CASING_TARGET_STOPWORDS = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'and',
  'or',
  'but',
  'so',
  'if',
  'then',
  'that',
  'which',
  'who',
  'when',
  'where',
  'while',
  'because',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'as',
  'it',
  'they',
  'them',
  'he',
  'she',
  'we',
  'us',
  'you',
  'i',
  'me',
  'letter',
  'letters',
  'word',
  'words',
  'text',
  'phrase',
  'phrases',
  'type',
])

function applySpokenCasingCommands(text: string): string {
  return text.replace(
    CASING_COMMAND_PATTERN,
    (whole: string, cue: string, phrase: string, offset: number, source: string) => {
      const before = source.slice(0, offset)
      // A casing word that opens a sentence is ordinary prose ("Lowercase remains lowercase").
      if (/(?:^|[.!?]["'”’]?|\n)\s*$/u.test(before)) return whole
      const previous = before.match(/(\p{L}[\p{L}\p{M}'’-]*)[ \t]*$/u)?.[1]?.toLocaleLowerCase()
      if (previous && CASING_PROSE_PRECEDERS.has(previous)) return whole
      const target = phrase.trim()
      const words = target.split(/\s+/u).map((word) => word.toLocaleLowerCase())
      if (words.some((word) => CASING_TARGET_STOPWORDS.has(word))) return whole
      const command = cue.toLocaleLowerCase()
      if (command === 'uppercase' || command === 'all caps') return target.toLocaleUpperCase()
      if (command === 'lowercase') return target.toLocaleLowerCase()
      return titleCaseWords(target)
    },
  )
}
export function normalizeDeterministically(
  raw: string,
  glossary: readonly GlossaryEntry[],
  options: { capitalizeOpening?: boolean; compactUppercaseSpelling?: boolean } = {},
): DeterministicNormalization {
  const protectedLiterals: string[] = []
  let text = raw.replace(
    new RegExp(
      `\\b(?:literal|the\\s+(?:word|words|phrase))\\s+(${SPOKEN_PUNCTUATION_TERM_SOURCE})\\b`,
      'gi',
    ),
    (_, word: string) => {
      const normalizedWord = word.toLowerCase().replace(/^semi[ -]?colon$/, 'semicolon')
      const index = protectedLiterals.push(normalizedWord) - 1
      return `\uE000${index}\uE001`
    },
  )
  const reasons: string[] = []
  const authoritativePunctuationMarks: string[] = []
  const deduplicatedTerminalMarks = removeRedundantProviderTerminalMarks(text)
  if (deduplicatedTerminalMarks !== text) reasons.push('provider terminal punctuation')
  text = deduplicatedTerminalMarks
  const deduplicatedTerminalPunctuation = removeRedundantTerminalPunctuationCommands(text)
  if (deduplicatedTerminalPunctuation !== text) reasons.push('provider terminal punctuation')
  text = deduplicatedTerminalPunctuation
  const deduplicatedDashes = removeRedundantProviderDashes(text)
  if (deduplicatedDashes !== text) reasons.push('provider dash')
  text = deduplicatedDashes
  text = normalizeApostrophesInsideExplicitSpelling(text)
  const explicitPunctuation = replaceExplicitPunctuationCommands(text)
  text = explicitPunctuation.text
  reasons.push(...explicitPunctuation.reasons)
  authoritativePunctuationMarks.push(...explicitPunctuation.marks)
  for (const pattern of LITERAL_PUNCTUATION_CONTEXTS) {
    text = text.replace(pattern, (literal: string) => {
      const index = protectedLiterals.push(literal) - 1
      return `\uE000${index}\uE001`
    })
  }
  const learningCandidates: SpellingLearningCandidate[] = []
  const spelling = replaceExplicitSpelling(text, options.compactUppercaseSpelling === true)
  text = spelling.text
  if (spelling.learningCandidates.length) reasons.push('explicit spelling')
  learningCandidates.push(...spelling.learningCandidates)

  const quotation = replaceSpokenQuotationCommands(
    text,
    protectedLiterals.some((literal) =>
      /\b(?:(?:single\s+)?(?:quote|quotation)|begin(?:ning|s)?\s+speech|end(?:ing|s)?\s+speech|begin\s+single|end\s+single)\b/iu.test(
        literal,
      ),
    ),
  )
  text = quotation.text
  if (quotation.marks.length) reasons.push(...quotation.reasons)
  authoritativePunctuationMarks.push(...quotation.marks)

  const restoredSentenceBoundaries = restoreHighConfidenceSentenceBoundaries(text)
  if (restoredSentenceBoundaries.count) reasons.push('missing sentence boundary')
  for (let index = 0; index < restoredSentenceBoundaries.count; index += 1)
    authoritativePunctuationMarks.push('.')
  text = restoredSentenceBoundaries.text

  text = text.replace(TERMINAL_BEFORE_BOUNDARY_COMMAND, '')
  for (const [pattern, replacement, reason] of PUNCTUATION) {
    const count = text.match(pattern)?.length ?? 0
    const next = text.replace(
      pattern,
      (_whole: string, attachedPunctuation: string, offset: number) =>
        `${replacement}${punctuationAfterSpokenCommand(text, offset, reason, attachedPunctuation)}`,
    )
    if (next !== text) reasons.push(reason)
    for (let index = 0; index < count; index += 1) authoritativePunctuationMarks.push(replacement)
    text = next
  }
  text = text.replace(
    /\uE000(\d+)\uE001/g,
    (_, index: string) => protectedLiterals[Number(index)] ?? '',
  )

  for (const entry of glossary) {
    for (const variant of entry.variants) {
      if (
        !variant.trim() ||
        variant.localeCompare(entry.canonical, undefined, { sensitivity: 'accent' }) === 0
      )
        continue
      const pattern = new RegExp(`\\b${escapeRegExp(variant)}\\b`, 'gi')
      const next = text.replace(pattern, entry.canonical)
      if (next !== text) reasons.push(`glossary: ${entry.canonical}`)
      text = next
    }
  }

  const cased = applySpokenCasingCommands(text)
  if (cased !== text) reasons.push('spoken casing')
  text = spaceEmDashes(cleanupPunctuationSpacing(cased))
  const capitalized = capitalizeMessageOpenings(
    text,
    [
      ...glossary.map((entry) => entry.canonical),
      ...learningCandidates.map((candidate) => candidate.canonical),
    ],
    options.capitalizeOpening !== false,
  )
  if (capitalized !== text) reasons.push('message opening capitalization')
  text = capitalized
  return {
    text,
    changed: text !== raw,
    reasons: [...new Set(reasons)],
    learningCandidates,
    ambiguities: spelling.ambiguities,
    authoritativePunctuationLiterals: [...new Set(protectedLiterals)],
    authoritativePunctuationMarks,
  }
}

/**
 * Resolves a recording-only spelling reference such as
 * "the sheath, as in sheaf of arrows and the bow". The comma, an immediately
 * adjacent reference word, and a strong lexical/phonetic relationship are all
 * required so ordinary prose containing "as in" remains literal.
 *
 * This intentionally runs after contextual recognition: the explanatory words
 * remain available to the provider to infer the spelling, then are removed from
 * the accepted candidate without trusting the provider to classify commands.
 */
export function normalizeQualifiedAsInReferences(input: string): QualifiedAsInNormalization {
  const pattern = /([\p{L}\p{M}][\p{L}\p{M}'’-]*)\s*,\s*as\s+in\s+([\p{L}\p{M}][\p{L}\p{M}'’-]*)/giu
  let text = input
  let searchFrom = 0
  let changed = false

  while (searchFrom < text.length) {
    pattern.lastIndex = searchFrom
    const match = pattern.exec(text)
    if (!match || match.index === undefined) break
    const heard = match[1]!
    const reference = match[2]!
    const heardKey = heard.toLocaleLowerCase()
    const referenceKey = reference.toLocaleLowerCase()
    const related =
      heardKey === referenceKey ||
      areSpeechPhoneticNeighbors(heard, reference) ||
      (Math.min(heardKey.length, referenceKey.length) >= 4 &&
        heardKey.slice(0, 2) === referenceKey.slice(0, 2) &&
        withinEditDistance(heardKey, referenceKey, 2))
    if (!related) {
      searchFrom = match.index + match[0].length
      continue
    }

    const suffixStart = match.index + match[0].length
    const suffix = text.slice(suffixStart)
    // A repeated pronoun in ordinary prose ("her, as in her opinion") is not a
    // spelling reference. Require either an explanation cue or a closed command.
    if (!/^\s*(?:(?:of|for|like|meaning)\b|[,.;:!?]|$)/iu.test(suffix)) {
      searchFrom = suffixStart
      continue
    }
    const sentenceBoundary = suffix.search(/[.!?\n]/u)
    const clauseLimit = sentenceBoundary < 0 ? suffix.length : sentenceBoundary
    const clause = suffix.slice(0, clauseLimit)
    const continuation = clause.search(
      /\s+(?:and|but|so|then)\s+(?=(?:the|a|an|my|your|his|her|its|our|their|this|that|these|those|I|we|you|he|she|it|they)\b)/iu,
    )
    const commaBoundary = clause.indexOf(',')
    const explanationEnd =
      continuation >= 0
        ? suffixStart + continuation
        : commaBoundary >= 0
          ? suffixStart + commaBoundary + 1
          : suffixStart + clauseLimit
    const replacement = reference
    text = `${text.slice(0, match.index)}${replacement}${text.slice(explanationEnd)}`
    changed = true
    searchFrom = match.index + replacement.length
  }

  return { text, changed }
}

function restoreHighConfidenceSentenceBoundaries(input: string): { text: string; count: number } {
  let count = 0
  const text = input.replace(
    /(^|[.!?\u2026][\u201d\u2019"']?(?:[ \t]+)|[\u201c\u2018"'([{][ \t]*)(My God)([ \t]+)(?=[\p{Lu}][\p{Ll}\p{M}'\u2019-]*\b)/gu,
    (_whole, boundary: string, interjection: string, spacing: string) => {
      count += 1
      return `${boundary}${interjection}.${spacing}`
    },
  )
  return { text, count }
}

function capitalizeMessageOpenings(
  input: string,
  protectedTerms: readonly string[],
  capitalizeInitialOpening: boolean,
): string {
  const protectedWords = new Set(
    protectedTerms.flatMap((term) => {
      const firstWord = term.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/u)?.[0]
      return firstWord ? [firstWord.toLocaleLowerCase()] : []
    }),
  )
  return input.replace(
    /(^|\n{2,})([ \t]*)([\p{Ll}][\p{L}\p{M}'’-]*)/gu,
    (whole, boundary: string, spacing: string, word: string) => {
      if (!boundary && !capitalizeInitialOpening) return whole
      if (protectedWords.has(word.toLocaleLowerCase()) || /\p{Lu}/u.test(word.slice(1)))
        return whole
      return `${boundary}${spacing}${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`
    },
  )
}

export function recoverHighConfidenceContextualCommands(input: string): ContextualCommandRecovery {
  const reasons: string[] = []
  const text = input.replace(
    /\bnew pair of graphs?\b[.,;:!?]?/giu,
    (match: string, offset: number, source: string) => {
      const before = source.slice(0, offset)
      const after = source.slice(offset + match.length)
      const followsSentenceBoundary = !before.trim() || /[.!?][\s”’"']*$/u.test(before)
      const precedesSentenceText = /^\s*[“‘"'(]*\p{Lu}/u.test(after)
      const hasLiteralDeterminer =
        /\b(?:a|an|the|this|that|these|those|my|your|our|its|another|each|every)\s+$/iu.test(before)
      if (!followsSentenceBoundary || !precedesSentenceText || hasLiteralDeterminer) return match
      reasons.push('contextual recovery: new paragraph')
      return '\n\n'
    },
  )
  return { text: cleanupPunctuationSpacing(text), reasons }
}

function removeRedundantProviderTerminalMarks(input: string): string {
  return input.replace(/([.?!…][”’"']?)\s+\.(?=\s|[”’"']|$)/gu, '$1')
}

/** An em dash between words always has a space on each side, within its line. */
function spaceEmDashes(input: string): string {
  return input.replace(/([^\s—])[ \t]*—[ \t]*(?=[^\s—])/gu, '$1 — ')
}

/** A dash already rendered by the provider keeps its mark when the spoken “dash” follows it. */
function removeRedundantProviderDashes(input: string): string {
  return input.replace(/—\s*(?:em\s+)?dash\b[.,]?/giu, '—').replace(/—\s*—/gu, '—')
}

function removeRedundantTerminalPunctuationCommands(input: string): string {
  return input
    .replace(/([.?!…][”’"']?)\s+(?:period|full stop)\b[.,]?/giu, '$1')
    .replace(/(\?[”’"']?)\s+question mark\b[.,]?/giu, '$1')
    .replace(/(![”’"']?)\s+exclamation (?:mark|point)\b[.,]?/giu, '$1')
    .replace(
      /(![”’"']?)\s+exclamation\b[.,]?(?=\s*(?:end(?:ing|s)?\s+speech|end\s+single|[”’"']|$))/giu,
      '$1',
    )
    .replace(/(…[”’"']?)\s+(?:ellipsis|dot dot dot|three dots)\b[.,]?/giu, '$1')
}

function replaceExplicitPunctuationCommands(input: string): {
  text: string
  marks: string[]
  reasons: string[]
} {
  const marks: string[] = []
  const reasons: string[] = []
  const pattern = new RegExp(
    `\\b(?:insert|punctuation|command)\\s+(${SPOKEN_PUNCTUATION_TERM_SOURCE})\\b`,
    'gi',
  )
  const text = input.replace(
    new RegExp(`${pattern.source}([.,;:!?…—–-]*)`, pattern.flags),
    (_whole: string, phrase: string, attachedPunctuation: string, offset: number) => {
      const command = punctuationCommand(phrase)
      if (!command) return phrase
      marks.push(command.mark)
      reasons.push(command.reason)
      const normalizedPhrase = phrase.toLocaleLowerCase().replace(/^semi[ -]?colon$/, 'semicolon')
      const closingReason =
        /^(?:close (?:parenthesis|paren|bracket|quote|single quote)|quote|quotation|single quote|single quotation)$/u.test(
          normalizedPhrase,
        )
          ? command.reason
          : ''
      return `${command.mark}${punctuationAfterSpokenCommand(
        input,
        offset,
        closingReason,
        attachedPunctuation,
      )}`
    },
  )
  return { text, marks, reasons }
}

function punctuationCommand(phrase: string): { mark: string; reason: string } | null {
  const normalized = phrase.toLocaleLowerCase().replace(/^semi[ -]?colon$/, 'semicolon')
  if (normalized === 'new paragraph') return { mark: '\n\n', reason: 'new paragraph' }
  if (normalized === 'new line') return { mark: '\n', reason: 'new line' }
  if (normalized === 'open parenthesis' || normalized === 'open paren')
    return { mark: '(', reason: 'open parenthesis' }
  if (normalized === 'close parenthesis' || normalized === 'close paren')
    return { mark: ')', reason: 'close parenthesis' }
  if (normalized === 'open bracket') return { mark: '[', reason: 'open bracket' }
  if (normalized === 'close bracket') return { mark: ']', reason: 'close bracket' }
  if (normalized === 'begin bracket') return { mark: '<', reason: 'begin bracket' }
  if (normalized === 'end bracket') return { mark: '>', reason: 'end bracket' }
  if (normalized === 'question mark') return { mark: '?', reason: 'question mark' }
  if (
    normalized === 'exclamation' ||
    normalized === 'exclamation mark' ||
    normalized === 'exclamation point'
  )
    return { mark: '!', reason: 'exclamation mark' }
  if (normalized === 'semicolon') return { mark: ';', reason: 'semicolon' }
  if (normalized === 'colon') return { mark: ':', reason: 'colon' }
  if (normalized === 'comma') return { mark: ',', reason: 'comma' }
  if (normalized === 'full stop' || normalized === 'period') return { mark: '.', reason: 'period' }
  if (normalized === 'ellipsis' || normalized === 'dot dot dot' || normalized === 'three dots')
    return { mark: '…', reason: 'ellipsis' }
  if (normalized === 'em dash' || normalized === 'dash') return { mark: '—', reason: 'em dash' }
  if (normalized === 'en dash') return { mark: '–', reason: 'en dash' }
  if (normalized === 'hyphen') return { mark: '-', reason: 'hyphen' }
  if (normalized === 'apostrophe') return { mark: '’', reason: 'apostrophe' }
  if (normalized === 'asterisk') return { mark: '*', reason: 'asterisk' }
  if (normalized === 'open quote') return { mark: '“', reason: 'quote' }
  if (normalized === 'close quote' || normalized === 'quote' || normalized === 'quotation')
    return { mark: '”', reason: 'quote' }
  if (normalized === 'open single quote') return { mark: '‘', reason: 'single quote' }
  if (
    normalized === 'close single quote' ||
    normalized === 'single quote' ||
    normalized === 'single quotation'
  )
    return { mark: '’', reason: 'single quote' }
  return null
}

function replaceSpokenQuotationCommands(
  input: string,
  hasLiteralQuoteContext: boolean,
): {
  text: string
  marks: string[]
  reasons: string[]
} {
  const marks: string[] = []
  const reasons: string[] = []
  const generatedOpeningMarker = '\uE002'
  let text = input
    .replace(/(\bopen quote\b[.,;:!?…—–-]*)[ \t]*["“”]/gi, '$1')
    .replace(/["“”][ \t]*(\bclose quote\b)/gi, '$1')
    .replace(/(\bopen single quote\b[.,;:!?…—–-]*)[ \t]*['‘’]/gi, '$1')
    .replace(/['‘’][ \t]*(\bclose single quote\b)/gi, '$1')

  const replaceGuardedAliasPair = (
    beginPhrase: string,
    endPhrase: string,
    opening: string,
    closing: string,
    reason: 'quote' | 'single quote',
  ) => {
    if (hasLiteralQuoteContext) return
    const recoveredClosing = recoverMistranscribedClosingAlias(text, beginPhrase, endPhrase)
    if (recoveredClosing !== null) {
      text = recoveredClosing
      reasons.push('fuzzy spoken command recovery')
    }
    const beginPattern = new RegExp(`\\b${beginPhrase}\\b([.,;:!?…—–-]*)`, 'giu')
    const endPattern = new RegExp(`\\b${endPhrase}\\b([.,;:!?…—–-]*)`, 'giu')
    const tokenPattern = new RegExp(`\\b(${beginPhrase}|${endPhrase})\\b`, 'giu')
    const tokens = [...text.matchAll(tokenPattern)]
    if (!tokens.length || tokens.length % 2 !== 0) return
    if (
      tokens.some((token, index) => {
        const phrase = index % 2 === 0 ? beginPhrase : endPhrase
        return !new RegExp(`^${phrase}$`, 'iu').test(token[1] ?? '')
      })
    )
      return
    if (hasNaturalAliasUsage(text)) return
    for (let index = 0; index < tokens.length; index += 2) {
      const contentStart = (tokens[index]!.index ?? 0) + tokens[index]![0].length
      const contentEnd = tokens[index + 1]!.index ?? contentStart
      if (!/[\p{L}\p{N}]/u.test(text.slice(contentStart, contentEnd))) return
    }
    text = text.replace(beginPattern, () => {
      marks.push(opening)
      reasons.push(reason)
      return `${generatedOpeningMarker}${opening}`
    })
    text = text.replace(
      endPattern,
      (_whole: string, attachedPunctuation: string, offset: number) => {
        marks.push(closing)
        reasons.push(reason)
        return `${closing}${punctuationAfterSpokenCommand(text, offset, reason, attachedPunctuation)}`
      },
    )
  }

  replaceGuardedAliasPair(
    'begin(?:ning|s)?(?:\\s+the)?\\s+speech',
    'end(?:ing|s)? speech',
    '“',
    '”',
    'quote',
  )
  replaceGuardedAliasPair('begin single', 'end single', '‘', '’', 'single quote')

  const replaceFixed = (pattern: RegExp, mark: string, reason: string, opening = false) => {
    text = text.replace(pattern, (_whole: string, attachedPunctuation: string, offset: number) => {
      marks.push(mark)
      reasons.push(reason)
      if (opening) return `${generatedOpeningMarker}${mark}`
      return `${mark}${punctuationAfterSpokenCommand(text, offset, reason, attachedPunctuation)}`
    })
  }
  replaceFixed(/\bopen single quote\b([.,;:!?…—–-]*)/gi, '‘', 'single quote', true)
  replaceFixed(/\bclose single quote\b([.,;:!?…—–-]*)/gi, '’', 'single quote')
  replaceFixed(/\bopen quote\b([.,;:!?…—–-]*)/gi, '“', 'quote', true)
  replaceFixed(/\bclose quote\b([.,;:!?…—–-]*)/gi, '”', 'quote')

  const replacePaired = (
    pattern: RegExp,
    opening: string,
    closing: string,
    reason: 'quote' | 'single quote',
  ) => {
    if (hasLiteralQuoteContext) return
    const count = text.match(pattern)?.length ?? 0
    if (count < 2 || count % 2 !== 0) return
    text = stripProviderRenderedQuotesBesidePairedCommands(text, reason)
    let occurrence = 0
    text = text.replace(pattern, (_whole: string, attachedPunctuation: string, offset: number) => {
      const isOpening = occurrence % 2 === 0
      const mark = isOpening ? opening : closing
      occurrence += 1
      marks.push(mark)
      reasons.push(reason)
      return isOpening
        ? `${generatedOpeningMarker}${mark}`
        : `${mark}${punctuationAfterSpokenCommand(text, offset, reason, attachedPunctuation)}`
    })
  }
  replacePaired(/\bsingle (?:quote|quotation)\b([.,;:!?…—–-]*)/gi, '‘', '’', 'single quote')
  replacePaired(/\b(?<!single\s)(?:quote|quotation)\b([.,;:!?…—–-]*)/gi, '“', '”', 'quote')

  text = formatGeneratedQuotationOpenings(text, generatedOpeningMarker)

  return { text, marks, reasons }
}

function hasNaturalAliasUsage(text: string): boolean {
  return /\b(?:begin(?:ning|s)?|end(?:ing|s)?)\s+(?:speech|single)\s+(?:therapy|recognition|synthesis|training|class|course|pathology|development|delay|disorder|exercise|practice|section|segment|act)\b/iu.test(
    text,
  )
}

/**
 * Speech-to-text often hears a closing “end speech” as “and speech”. When the
 * transcript contains exactly one unmatched opening alias and ends on that
 * misheard closing phrase, restore the closing alias so the guarded pair can
 * run. Natural “and speech” prose and natural alias usage stay untouched.
 */
function recoverMistranscribedClosingAlias(
  text: string,
  beginPhrase: string,
  endPhrase: string,
): string | null {
  if (hasNaturalAliasUsage(text)) return null
  const beginCount = text.match(new RegExp(`\\b${beginPhrase}\\b`, 'giu'))?.length ?? 0
  const endCount = text.match(new RegExp(`\\b${endPhrase}\\b`, 'giu'))?.length ?? 0
  if (beginCount !== 1 || endCount !== 0) return null
  const kind = endPhrase.slice(endPhrase.indexOf(' ') + 1)
  const closingAliasPattern = new RegExp(
    `\\b(and)(?:\\s+(?:a|the))?\\s+(${kind})\\b([.,;:!?…—–-]*)(?=\\s*(?:(?:period|full stop)\\b\\s*)?$)`,
    'iu',
  )
  if (!closingAliasPattern.test(text)) return null
  return text.replace(
    closingAliasPattern,
    (_match: string, conjunction: string, word: string, punctuation: string) => {
      const replacement = conjunction === 'AND' ? 'END' : conjunction[0] === 'A' ? 'End' : 'end'
      return `${replacement} ${word}${punctuation}`
    },
  )
}

function stripProviderRenderedQuotesBesidePairedCommands(
  input: string,
  reason: 'quote' | 'single quote',
): string {
  const phrase =
    reason === 'quote' ? '(?<!single\\s)(?:quote|quotation)' : 'single\\s+(?:quote|quotation)'
  const quoteClass = reason === 'quote' ? '["“”]' : "['‘’]"
  const pattern = new RegExp(
    `(${quoteClass}[ \\t]*)?(\\b${phrase}\\b[.,;:!?…—–-]*)([ \\t]*${quoteClass})?`,
    'gi',
  )
  let occurrence = 0
  return input.replace(
    pattern,
    (_whole, before: string | undefined, command: string, after: string | undefined) => {
      const isOpening = occurrence % 2 === 0
      occurrence += 1
      return isOpening ? `${before ?? ''}${command}` : `${command}${after ?? ''}`
    },
  )
}

function punctuationAfterSpokenCommand(
  source: string,
  commandOffset: number,
  commandReason: string,
  attachedPunctuation: string,
): string {
  const isClosingDelimiter =
    commandReason === 'quote' ||
    commandReason === 'single quote' ||
    commandReason === 'close parenthesis' ||
    commandReason === 'close bracket' ||
    commandReason === 'end bracket'
  if (!isClosingDelimiter) return ''
  const terminalPunctuation = attachedPunctuation.replace(/[^.?!…]/gu, '')
  if (!terminalPunctuation) return ''
  const contentBeforeCommand = source.slice(0, commandOffset).trimEnd()
  const contentAlreadyEndsSentence =
    /[.?!…]$/u.test(contentBeforeCommand) ||
    /\b(?:period|full stop|question mark|exclamation(?: (?:mark|point))?|ellipsis|dot dot dot|three dots)$/iu.test(
      contentBeforeCommand,
    )
  const quotedContentAlreadyEndsWithPunctuation =
    (commandReason === 'quote' || commandReason === 'single quote') &&
    (/[,;:—–-]$/u.test(contentBeforeCommand) ||
      /\b(?:comma|semicolon|semi[ -]?colon|colon|em dash|en dash|hyphen|dash)$/iu.test(
        contentBeforeCommand,
      ))
  if (contentAlreadyEndsSentence || quotedContentAlreadyEndsWithPunctuation) return ''
  return terminalPunctuation
}

function formatGeneratedQuotationOpenings(input: string, marker: string): string {
  const markedOpening = new RegExp(`${marker}([“‘])[ \\t]*([\\p{Ll}][\\p{L}\\p{M}'’-]*)`, 'gu')

  return input
    .replace(markedOpening, (_whole: string, quote: string, word: string) => {
      const hasInternalUppercase = /\p{Lu}/u.test(word.slice(1))
      const formattedWord = hasInternalUppercase
        ? word
        : `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`
      return `${quote}${formattedWord}`
    })
    .replaceAll(marker, '')
}

function replaceExplicitSpelling(
  input: string,
  compactUppercaseSpelling = false,
): Pick<DeterministicNormalization, 'text' | 'learningCandidates' | 'ambiguities'> {
  const learningCandidates: SpellingLearningCandidate[] = []
  const ambiguities: string[] = []
  const separatedPattern =
    /\b(?:(all caps|uppercase|lowercase|capitalized?)\s+)?((?:(?:[A-Za-z]\s*(?:-|dash|[.,](?:\s+dash)?|['\u2019])\s*){2,}[A-Za-z](?![A-Za-z]))|(?:(?:[A-Za-z]\s+){2,}[A-Za-z](?![A-Za-z])))(?:\s*([,;:]?)\s+([A-Za-z][A-Za-z'-]*))?/gi
  let text = input.replace(
    separatedPattern,
    (
      whole,
      casing: string | undefined,
      spoken: string,
      separator: string | undefined,
      cue: string | undefined,
    ) => {
      const letters = extractLetters(spoken)
      if (letters.length < 3) return whole
      const matchingCue = cueMatchesLetters(cue, letters) ? cue : undefined
      const canonical =
        matchingCue && !casing ? matchingCue : applySpellingCasing(matchingCue ?? letters, casing)
      learningCandidates.push({ canonical, spokenVariant: spoken.trim() })
      return `${canonical}${unmatchedCueSuffix(separator, cue, matchingCue)}`
    },
  )

  const compactHyphenatedPattern =
    /\b(?:(all caps|uppercase|lowercase|capitalized?)\s+)?((?:[A-Za-z]{2,}-)+[A-Za-z]{2,})(?:\s*([,;:]?)\s+([A-Za-z][A-Za-z'-]*))?/gi
  text = text.replace(
    compactHyphenatedPattern,
    (
      whole,
      casing: string | undefined,
      spoken: string,
      separator: string | undefined,
      cue: string | undefined,
    ) => {
      const letters = extractLetters(spoken)
      const matchingCue = cueMatchesLetters(cue, letters) ? cue : undefined
      if (!/[A-Z]{2,}/.test(spoken) || (!casing && !matchingCue)) return whole
      const canonical =
        matchingCue && !casing ? matchingCue : applySpellingCasing(matchingCue ?? spoken, casing)
      learningCandidates.push({ canonical, spokenVariant: spoken.trim() })
      return `${canonical}${unmatchedCueSuffix(separator, cue, matchingCue)}`
    },
  )

  // Some transcription providers collapse a deliberately spelled sequence into
  // one uppercase token (for example, "S H E A F" becomes "SHEAF"). Ordinary
  // dictation still requires a casing cue; edit payloads can opt into treating
  // compact uppercase tokens as explicit spelling, defaulting them to lowercase.
  const compactUppercasePattern =
    /\b(?:(all caps|uppercase|lowercase|capitalized?)\s+)?([A-Z]{3,})(?![A-Za-z])(?:\s*([,;:]?)\s+([A-Za-z][A-Za-z'-]*))?/g
  text = text.replace(
    compactUppercasePattern,
    (
      whole,
      casing: string | undefined,
      spoken: string,
      separator: string | undefined,
      cue: string | undefined,
    ) => {
      if (!casing && !compactUppercaseSpelling) return whole
      const matchingCue = cueMatchesLetters(cue, spoken) ? cue : undefined
      const canonical = applySpellingCasing(matchingCue ?? spoken, casing)
      learningCandidates.push({ canonical, spokenVariant: spoken.trim() })
      return `${canonical}${unmatchedCueSuffix(separator, cue, matchingCue)}`
    },
  )

  for (const candidate of learningCandidates) {
    text = text.replace(
      new RegExp(`\\b(write|type|spell)\\s*,\\s+(?=${escapeRegExp(candidate.canonical)}\\b)`, 'gi'),
      '$1 ',
    )
  }
  return { text, learningCandidates, ambiguities }
}

function unmatchedCueSuffix(
  separator: string | undefined,
  cue: string | undefined,
  matchingCue: string | undefined,
): string {
  if (!cue || matchingCue) return ''
  return `${separator ?? ''} ${cue}`
}

function extractLetters(value: string): string {
  return (
    value
      .replace(/\bdash\b/gi, '-')
      .match(/[A-Za-z'\u2019]/g)
      ?.join('') ?? ''
  )
}

function normalizeApostrophesInsideExplicitSpelling(value: string): string {
  const spelledBeforeApostrophe =
    /((?:(?:[A-Za-z]\s*(?:-|dash)\s*){2,}|(?:[A-Za-z]\s+){2,})[A-Za-z])\s*(?:-|dash)?\s*apostrophe\s*(?:-|dash)?\s*([A-Za-z])\b/gi
  const spelledAfterApostrophe =
    /\b([A-Za-z])\s*(?:-|dash)?\s*apostrophe\s*(?:-|dash)?\s*((?:[A-Za-z]\s*(?:-|dash)\s*){2,}[A-Za-z])/gi
  return value
    .replace(spelledBeforeApostrophe, '$1\u2019$2')
    .replace(spelledAfterApostrophe, '$1\u2019$2')
}

function cueMatchesLetters(cue: string | undefined, letters: string): cue is string {
  return Boolean(
    cue &&
    cue.replace(/[-'\u2019]/g, '').toLowerCase() ===
      letters.replace(/[-'\u2019]/g, '').toLowerCase(),
  )
}

export function applySpellingCasing(value: string, casing: string | undefined): string {
  if (!casing) return value.toLowerCase()
  const normalized = casing.toLowerCase()
  if (normalized === 'all caps' || normalized === 'uppercase') return value.toUpperCase()
  if (normalized === 'lowercase') return value.toLowerCase()
  return value
    .split(/([-\u2019'])/)
    .map((part) =>
      part === '-' || part === "'" || part === '\u2019'
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`,
    )
    .join('')
    .replace(/(['\u2019])S$/u, '$1s')
}

function cleanupPunctuationSpacing(value: string): string {
  return value
    .replace(/[ \t]+([,.;:!?)\]>])/g, '$1')
    .replace(/([(<[])\s+/g, '$1')
    .replace(/([“‘])[ \t]+/g, '$1')
    .replace(/[ \t]+([”’])/g, '$1')
    .replace(/[ \t]+…/g, '…')
    .replace(/(?<=\p{L})[ \t]*’[ \t]*(?=\p{L})/gu, '’')
    .replace(/[ \t]*-[ \t]*/g, '-')
    .replace(/[,;:]\s*([.!?])/g, '$1')
    .replace(/([,.;:!?])(?:\s*\1)+/g, '$1')
    .replace(/…(?:\s*\.){1,3}/g, '…')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([,.;:!?])(?=[A-Za-z])/g, '$1 ')
    .replace(/^[ \t]+/, '')
    .replace(/\s+$/, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
