import type { GlossaryEntry } from './glossary'

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
}

const PUNCTUATION: Array<[RegExp, string, string]> = [
  [/\bnew paragraph\b[.,;:!?]?/gi, '\n\n', 'new paragraph'],
  [/\bnew line\b[.,;:!?]?/gi, '\n', 'new line'],
  [/\bopen (?:parenthesis|paren)\b/gi, '(', 'open parenthesis'],
  [/\bclose (?:parenthesis|paren)\b/gi, ')', 'close parenthesis'],
  [/\bopen bracket\b/gi, '[', 'open bracket'],
  [/\bclose bracket\b/gi, ']', 'close bracket'],
  [/\bopen single quote\b/gi, '‘', 'open single quote'],
  [/\bclose single quote\b/gi, '’', 'close single quote'],
  [/\bopen quote\b/gi, '“', 'open quote'],
  [/\bclose quote\b/gi, '”', 'close quote'],
  [/\bquestion mark\b/gi, '?', 'question mark'],
  [/\bexclamation (?:mark|point)\b/gi, '!', 'exclamation mark'],
  [/\bsemi[ -]?colon\b/gi, ';', 'semicolon'],
  [/\bcolon\b/gi, ':', 'colon'],
  [/\bcomma\b/gi, ',', 'comma'],
  [/\bfull stop\b/gi, '.', 'period'],
  [/\bperiod\b/gi, '.', 'period'],
  [/\b(?:ellipsis|dot dot dot|three dots)\b/gi, '…', 'ellipsis'],
  [/\bem dash\b/gi, '—', 'em dash'],
  [/\ben dash\b/gi, '–', 'en dash'],
  [/\bhyphen\b/gi, '-', 'hyphen'],
  [/\bdash\b/gi, '—', 'em dash'],
  [/\bapostrophe\b/gi, '’', 'apostrophe'],
]

const LITERAL_PUNCTUATION_CONTEXTS: RegExp[] = [
  /\bperiod(?=\s+(?:of|piece|drama|costume|between|during|when|where|in|was|is|lasted|ended|began)\b)/gi,
  /\btime\s+period\b/gi,
  /\bdash(?=\s+(?:of|to|for|toward|through|across)\b)/gi,
  /\b(?:mad|quick|hundred-meter)\s+dash\b/gi,
  /\bcolon(?=\s+(?:cancer|health|screening|surgery|disease|pain|care)\b)/gi,
]

export function normalizeDeterministically(
  raw: string,
  glossary: readonly GlossaryEntry[],
): DeterministicNormalization {
  const protectedLiterals: string[] = []
  let text = raw.replace(
    /\b(?:literal|the word)\s+(period|comma|colon|semi[ -]?colon|hyphen|dash|ellipsis|apostrophe)\b/gi,
    (_, word: string) => {
      const index = protectedLiterals.push(word.toLowerCase().replace(/[ -]/g, '')) - 1
      return `\uE000${index}\uE001`
    },
  )
  for (const pattern of LITERAL_PUNCTUATION_CONTEXTS) {
    text = text.replace(pattern, (literal: string) => {
      const index = protectedLiterals.push(literal) - 1
      return `\uE000${index}\uE001`
    })
  }
  text = text.replace(
    /\b(?:insert|punctuation)\s+(?=(?:period|full stop|comma|colon|semi[ -]?colon|question mark|exclamation (?:mark|point)|ellipsis|dot dot dot|three dots|hyphen|en dash|em dash|dash|apostrophe|open quote|close quote|open single quote|close single quote)\b)/gi,
    '',
  )
  const reasons: string[] = []
  const learningCandidates: SpellingLearningCandidate[] = []
  const spelling = replaceExplicitSpelling(text)
  text = spelling.text
  if (spelling.learningCandidates.length) reasons.push('explicit spelling')
  learningCandidates.push(...spelling.learningCandidates)

  for (const [pattern, replacement, reason] of PUNCTUATION) {
    const next = text.replace(pattern, replacement)
    if (next !== text) reasons.push(reason)
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

  text = cleanupPunctuationSpacing(text)
  return {
    text,
    changed: text !== raw,
    reasons: [...new Set(reasons)],
    learningCandidates,
    ambiguities: spelling.ambiguities,
    authoritativePunctuationLiterals: [...new Set(protectedLiterals)],
  }
}

function replaceExplicitSpelling(
  input: string,
): Pick<DeterministicNormalization, 'text' | 'learningCandidates' | 'ambiguities'> {
  const learningCandidates: SpellingLearningCandidate[] = []
  const ambiguities: string[] = []
  const separatedPattern =
    /\b(?:(all caps|uppercase|lowercase|capitalized?)\s+)?((?:(?:[A-Za-z]\s*(?:-|dash|[.,](?:\s+dash)?)\s*){2,}[A-Za-z](?![A-Za-z]))|(?:(?:[A-Za-z]\s+){2,}[A-Za-z](?![A-Za-z])))(?:\s*([,;:]?)\s+([A-Za-z][A-Za-z'-]*))?/gi
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
      const canonical = applySpellingCasing(matchingCue ?? letters, casing)
      if (!casing && !matchingCue) {
        ambiguities.push(`Confirm the casing of “${letters}”.`)
      }
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
      .match(/[A-Za-z]/g)
      ?.join('') ?? ''
  )
}

function cueMatchesLetters(cue: string | undefined, letters: string): cue is string {
  return Boolean(cue && cue.replace(/[-']/g, '').toLowerCase() === letters.toLowerCase())
}

function applySpellingCasing(value: string, casing: string | undefined): string {
  if (!casing) return value
  const normalized = casing.toLowerCase()
  if (normalized === 'all caps' || normalized === 'uppercase') return value.toUpperCase()
  if (normalized === 'lowercase') return value.toLowerCase()
  return value
    .split(/([-'])/)
    .map((part) =>
      part === '-' || part === "'"
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`,
    )
    .join('')
}

function cleanupPunctuationSpacing(value: string): string {
  return value
    .replace(/[ \t]+([,.;:!?)\]])/g, '$1')
    .replace(/([([])\s+/g, '$1')
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
