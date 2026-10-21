export interface DeterministicGrammarRepair {
  text: string
  changes: string[]
}

export interface DeterministicGrammarOptions {
  protectedTerms?: readonly string[]
  capitalizeSentenceStarts?: boolean
  insideQuoteAtStart?: boolean
}

const MAX_DETERMINISTIC_CHANGES = 8

const SILENT_H_WORDS = ['hour', 'honest', 'honor', 'honour', 'heir'] as const

const AMBIGUOUS_H_WORDS = ['herb', 'historic', 'historical', 'homage'] as const

const CONSONANT_SOUND_U_WORDS = [
  'eu',
  'ewe',
  'one',
  'once',
  'ouija',
  'ubiq',
  'ukulele',
  'unan',
  'ura',
  'ure',
  'uri',
  'uro',
  'use',
  'usu',
  'ute',
  'uti',
  'uto',
  'unic',
  'unif',
  'unil',
  'unio',
  'uniq',
  'unis',
  'unit',
  'univ',
] as const

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'u.s',
  'u.k',
])

const COMMON_COMPACT_SUFFIXES = new Set([
  'com',
  'org',
  'net',
  'io',
  'dev',
  'ai',
  'co',
  'edu',
  'gov',
  'txt',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'json',
  'html',
  'css',
  'js',
  'ts',
  'md',
  'docx',
  'xlsx',
  'zip',
])

const DUPLICATE_WORD_PATTERN =
  /\b(the|a|an|and|or|of|to|in|on|at|for|with|from|by|is|was|were|be|been|has|it)\b(?:\s+\1\b)+/giu

const REPEATED_SPACE_PATTERN = /(?<=[^\s.!?\u2026])[ \t]{2,}(?=\S)/gu

const SPACE_BEFORE_PUNCTUATION_PATTERN =
  /(?<=[\p{L}\p{N}"'\u201d\u2019)\]])([ \t]+)([,;:!?\u2026]|\.(?!\.))/gu

const REPEATED_PUNCTUATION_PATTERN = /([,;:])\1+/gu

const ARTICLE_PATTERN = /\b(a|an)[ \t]+([\p{L}][\p{L}'\u2019-]*)/giu

const SKIPPED_ARTICLE_TARGETS = new Set(['a', 'an'])

/**
 * Applies only unambiguous local repairs that a deterministic edit can break:
 * errant punctuation, spacing, sentence capitalization, repeated function
 * words, repeated separators, and article agreement. Returns the original text
 * when unsure.
 */
export function repairDeterministicGrammar(
  text: string,
  options: DeterministicGrammarOptions = {},
): DeterministicGrammarRepair {
  const changes: string[] = []
  let repaired = text

  repaired = normalizeErrantPunctuation(repaired, changes)

  const beforeSpaceCollapse = repaired
  repaired = repaired.replace(REPEATED_SPACE_PATTERN, ' ')
  if (repaired !== beforeSpaceCollapse) pushChange(changes, 'Collapsed repeated spaces.')

  repaired = repaired.replace(/([“‘([{])([ \t]+)/gu, (_match, delimiter: string) => {
    pushChange(changes, `Removed a space after “${delimiter}”.`)
    return delimiter
  })
  repaired = repaired.replace(/([ \t]+)([”’)\]])/gu, (_match, _spaces, delimiter: string) => {
    pushChange(changes, `Removed a space before “${delimiter}”.`)
    return delimiter
  })

  repaired = repaired.replace(
    SPACE_BEFORE_PUNCTUATION_PATTERN,
    (_match, _spaces: string, punctuation: string) => {
      pushChange(changes, `Removed a space before “${punctuation}”.`)
      return punctuation
    },
  )

  repaired = insertMissingSpaces(repaired, changes)

  repaired = repaired.replace(REPEATED_PUNCTUATION_PATTERN, (match, punctuation: string) => {
    pushChange(changes, `Collapsed repeated “${punctuation}”.`)
    return punctuation
  })

  repaired = repaired.replace(DUPLICATE_WORD_PATTERN, (match, word: string) => {
    pushChange(changes, `Removed a repeated “${word}”.`)
    return word
  })

  repaired = repaired.replace(ARTICLE_PATTERN, (match, article: string, word: string) => {
    if (article === 'AN' || SKIPPED_ARTICLE_TARGETS.has(word.toLocaleLowerCase())) return match
    const desired = desiredArticle(word)
    if (!desired) return match
    const next = article[0] === article[0]?.toLocaleUpperCase() ? capitalize(desired) : desired
    if (next === article) return match
    pushChange(changes, `Changed “${article}” to “${next}” before “${clip(word, 40)}”.`)
    return `${next}${match.slice(article.length)}`
  })

  if (options.capitalizeSentenceStarts !== false && !options.insideQuoteAtStart) {
    repaired = capitalizeSentenceOpenings(repaired, options.protectedTerms ?? [], changes)
  }

  return { text: repaired, changes }
}

/**
 * True when the text before a sentence focus leaves an unmatched double quote
 * open, so the focus begins inside quoted material.
 */
export function opensInsideDoubleQuote(prefix: string): boolean {
  let depth = 0
  for (const character of prefix) {
    if (character === '\u201c') depth += 1
    else if (character === '\u201d') depth = Math.max(0, depth - 1)
    else if (character === '"') depth = depth === 0 ? 1 : 0
  }
  return depth > 0
}

/**
 * True when an article is followed by a word whose sound cannot be resolved
 * locally. These are the article cases the provider may still repair.
 */
export function hasAmbiguousArticleIssue(text: string): boolean {
  for (const match of text.matchAll(ARTICLE_PATTERN)) {
    const article = match[1] ?? ''
    const word = match[2] ?? ''
    if (article === 'AN' || SKIPPED_ARTICLE_TARGETS.has(word.toLocaleLowerCase())) continue
    if (!/^\p{Ll}/u.test(word)) continue
    if (desiredArticle(word) === null) return true
  }
  return false
}

function normalizeErrantPunctuation(text: string, changes: string[]): string {
  let result = text.replace(/([.!?\u2026])[ \t]*[,;:]+/gu, (_match, terminal: string) => {
    pushChange(changes, 'Removed errant punctuation after a sentence ending.')
    return terminal
  })
  result = result.replace(
    /([,;:])[ \t]*([.!?\u2026])/gu,
    (_match, _separator, terminal: string) => {
      pushChange(changes, 'Removed errant punctuation before a sentence ending.')
      return terminal
    },
  )
  result = result.replace(/(?<!\.)\.{2}(?!\.)/gu, () => {
    pushChange(changes, 'Collapsed a repeated period.')
    return '.'
  })
  result = result.replace(/([?!])\.(?![.?!])/gu, (_match, terminal: string) => {
    pushChange(changes, 'Removed a period after a sentence ending.')
    return terminal
  })
  result = result.replace(/(?<!\.)\.(?=[?!])/gu, () => {
    pushChange(changes, 'Removed a period before a sentence ending.')
    return ''
  })
  return result
}

function insertMissingSpaces(text: string, changes: string[]): string {
  let result = text.replace(
    /([,;:])(?=[\p{L}\p{N}])/gu,
    (match: string, mark: string, offset: number, source: string) => {
      const previous = source[offset - 1] ?? ''
      const next = source[offset + 1] ?? ''
      if ((mark === ',' || mark === ':') && /\d/u.test(previous) && /\d/u.test(next)) return match
      if (mark === ':' && next === '/') return match
      pushChange(changes, `Added a space after “${mark}”.`)
      return `${mark} `
    },
  )
  result = result.replace(
    /([!?])(?=[\p{L}])/gu,
    (match: string, mark: string, offset: number, source: string) => {
      if (mark === '?') {
        const before = source.slice(Math.max(0, offset - 40), offset)
        if (/https?:\/\/\S*$/u.test(before)) return match
        if (/^[\p{L}\d]+=/u.test(source.slice(offset + 1))) return match
      }
      pushChange(changes, `Added a space after “${mark}”.`)
      return `${mark} `
    },
  )
  result = result.replace(/\.(?=[\p{Lu}])/gu, (match: string, offset: number, source: string) => {
    const previous = source[offset - 1] ?? ''
    if (/\d/u.test(previous)) return match
    if (!previous) return match
    const word = source.slice(0, offset).match(/(\p{L}[\p{L}.'\u2019]*)$/u)?.[1] ?? ''
    if (isAbbreviationOrInitialism(word)) return match
    const suffix = source.slice(offset + 1).match(/^[\p{L}\d-]+/u)?.[0] ?? ''
    if (COMMON_COMPACT_SUFFIXES.has(suffix.toLocaleLowerCase())) return match
    pushChange(changes, 'Added a space after a period.')
    return '. '
  })
  return result
}

function isAbbreviationOrInitialism(word: string): boolean {
  const lower = word.toLocaleLowerCase().replace(/['\u2019]/gu, '')
  if (ABBREVIATIONS.has(lower)) return true
  if (/^\p{L}$/u.test(word)) return true
  if (/^(?:\p{L}\.){1,}\p{L}$/u.test(word)) return true
  return false
}

function capitalizeSentenceOpenings(
  text: string,
  protectedTerms: readonly string[],
  changes: string[],
): string {
  const protectedWords = new Set(
    protectedTerms.flatMap((term) => {
      const firstWord = term.match(/[\p{L}\p{M}][\p{L}\p{M}'\u2019-]*/u)?.[0]
      return firstWord ? [firstWord.toLocaleLowerCase()] : []
    }),
  )
  return text.replace(
    /(^|([.!?])(["'\u201d\u2019)\]]*)[ \t]+)(["'\u201c\u2018([{]*)(\p{Ll})([\p{L}\p{M}'\u2019-]*)/gu,
    (
      whole: string,
      boundary: string,
      terminal: string | undefined,
      closers: string,
      openers: string,
      first: string,
      rest: string,
      offset: number,
      source: string,
    ) => {
      if (openers && /["'\u201c\u2018]/u.test(openers)) return whole
      if (terminal) {
        if (terminal === '.' && source[offset - 1] === '.') return whole
        if (closers && /["'\u201d\u2019]/u.test(closers)) return whole
        const beforeTerminal = source.slice(0, offset)
        const word = beforeTerminal.match(/(\p{L}[\p{L}.'\u2019]*)$/u)?.[1] ?? ''
        if (isAbbreviationOrInitialism(word)) return whole
        if (opensInsideDoubleQuote(source.slice(0, offset + boundary.length))) return whole
      }
      const word = `${first}${rest}`
      const lower = word.toLocaleLowerCase()
      if (protectedWords.has(lower) || /\p{Lu}/u.test(rest)) return whole
      if (/^(?:www|http|https)$/iu.test(word)) return whole
      const afterWord = source.slice(offset + boundary.length + openers.length + word.length)
      const domainSuffix = afterWord.match(/^\.([\p{L}\d-]+)/u)?.[1]
      if (domainSuffix && COMMON_COMPACT_SUFFIXES.has(domainSuffix.toLocaleLowerCase()))
        return whole
      pushChange(changes, `Capitalized “${clip(word, 40)}”.`)
      return `${boundary}${openers}${capitalize(word)}`
    },
  )
}

function desiredArticle(word: string): 'a' | 'an' | null {
  if (!/^\p{Ll}/u.test(word)) return null
  const lower = word.toLocaleLowerCase()
  if (!/^[a-z]/u.test(lower)) return null
  if (lower.length <= 5 && !/[aeiou]/u.test(lower)) return null
  if (lower.startsWith('x')) return null
  if (lower.startsWith('h')) {
    if (AMBIGUOUS_H_WORDS.some((prefix) => lower.startsWith(prefix))) return null
    return SILENT_H_WORDS.some((prefix) => lower.startsWith(prefix)) ? 'an' : 'a'
  }
  if (!/^[aeiou]/u.test(lower)) return 'a'
  if (lower.startsWith('u')) {
    if (CONSONANT_SOUND_U_WORDS.some((prefix) => lower.startsWith(prefix))) return 'a'
    return null
  }
  return 'an'
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toLocaleUpperCase()}${value.slice(1)}`
}

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

function pushChange(changes: string[], change: string): void {
  if (changes.includes(change) || changes.length >= MAX_DETERMINISTIC_CHANGES) return
  changes.push(change)
}
