export interface DeterministicGrammarRepair {
  text: string
  changes: string[]
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

const DUPLICATE_WORD_PATTERN =
  /\b(the|a|an|and|or|of|to|in|on|at|for|with|from|by|is|was|were|be|been|has|it)\b(?:\s+\1\b)+/giu

const REPEATED_SPACE_PATTERN = /(?<=[^\s.!?\u2026])[ \t]{2,}(?=\S)/gu

const SPACE_BEFORE_PUNCTUATION_PATTERN =
  /(?<=[\p{L}\p{N}"'\u201d\u2019)\]])([ \t]+)([,;:!?]|\.(?!\.))/gu

const REPEATED_PUNCTUATION_PATTERN = /([,;:])\1+/gu

const ARTICLE_PATTERN = /\b(a|an)[ \t]+([\p{L}][\p{L}'\u2019-]*)/giu

const SKIPPED_ARTICLE_TARGETS = new Set(['a', 'an'])

/**
 * Applies only unambiguous local repairs that a deterministic edit can break:
 * repeated function words, repeated spaces, spaces before punctuation, repeated
 * separators, and article agreement. Returns the original text when unsure.
 */
export function repairDeterministicGrammar(text: string): DeterministicGrammarRepair {
  const changes: string[] = []
  let repaired = text

  repaired = repaired.replace(DUPLICATE_WORD_PATTERN, (match, word: string) => {
    pushChange(changes, `Removed a repeated “${word}”.`)
    return word
  })

  const beforeSpaceCollapse = repaired
  repaired = repaired.replace(REPEATED_SPACE_PATTERN, ' ')
  if (repaired !== beforeSpaceCollapse) pushChange(changes, 'Collapsed repeated spaces.')

  repaired = repaired.replace(
    SPACE_BEFORE_PUNCTUATION_PATTERN,
    (_match, _spaces: string, punctuation: string) => {
      pushChange(changes, `Removed a space before “${punctuation}”.`)
      return punctuation
    },
  )

  repaired = repaired.replace(REPEATED_PUNCTUATION_PATTERN, (match, punctuation: string) => {
    pushChange(changes, `Collapsed repeated “${punctuation}”.`)
    return punctuation
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

  return { text: repaired, changes }
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
