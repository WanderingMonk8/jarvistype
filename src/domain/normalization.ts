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
}

const PUNCTUATION: Array<[RegExp, string, string]> = [
  [/\bnew paragraph\b/gi, '\n\n', 'new paragraph'],
  [/\bnew line\b/gi, '\n', 'new line'],
  [/\bopen (?:parenthesis|paren)\b/gi, '(', 'open parenthesis'],
  [/\bclose (?:parenthesis|paren)\b/gi, ')', 'close parenthesis'],
  [/\bopen bracket\b/gi, '[', 'open bracket'],
  [/\bclose bracket\b/gi, ']', 'close bracket'],
  [/\bopen quote\b/gi, '“', 'open quote'],
  [/\bclose quote\b/gi, '”', 'close quote'],
  [/\bquestion mark\b/gi, '?', 'question mark'],
  [/\bexclamation (?:mark|point)\b/gi, '!', 'exclamation mark'],
  [/\bsemicolon\b/gi, ';', 'semicolon'],
  [/\bcolon\b/gi, ':', 'colon'],
  [/\bcomma\b/gi, ',', 'comma'],
  [/\bfull stop\b/gi, '.', 'period'],
  [/\bperiod\b/gi, '.', 'period'],
  [/\bellipsis\b/gi, '…', 'ellipsis'],
  [/\bem dash\b/gi, '—', 'em dash'],
  [/\ben dash\b/gi, '–', 'en dash'],
  [/\bhyphen\b/gi, '-', 'hyphen'],
  [/\bapostrophe\b/gi, '’', 'apostrophe'],
]

export function normalizeDeterministically(
  raw: string,
  glossary: readonly GlossaryEntry[],
): DeterministicNormalization {
  const protectedLiterals: string[] = []
  let text = raw.replace(
    /\b(?:literal|the word)\s+(period|comma|colon|semicolon|hyphen|apostrophe)\b/gi,
    (_, word: string) => {
      const index = protectedLiterals.push(word.toLowerCase()) - 1
      return `\uE000${index}\uE001`
    },
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
  }
}

function replaceExplicitSpelling(
  input: string,
): Pick<DeterministicNormalization, 'text' | 'learningCandidates' | 'ambiguities'> {
  const learningCandidates: SpellingLearningCandidate[] = []
  const ambiguities: string[] = []
  const separatedPattern =
    /\b(?:(all caps|uppercase|lowercase|capitalized?)\s+)?((?:(?:[A-Za-z]\s*(?:-|dash)\s*){2,}[A-Za-z](?![A-Za-z]))|(?:(?:[A-Za-z]\s+){2,}[A-Za-z](?![A-Za-z])))(?:\s*[,;:]?\s+([A-Za-z][A-Za-z'-]*))?/gi
  let text = input.replace(
    separatedPattern,
    (whole, casing: string | undefined, spoken: string, cue: string | undefined) => {
      const letters = extractLetters(spoken)
      if (letters.length < 3) return whole
      const matchingCue = cueMatchesLetters(cue, letters) ? cue : undefined
      const canonical = applySpellingCasing(matchingCue ?? letters, casing)
      if (!casing && !matchingCue) {
        ambiguities.push(`Confirm the casing of “${letters}”.`)
      }
      learningCandidates.push({ canonical, spokenVariant: spoken.trim() })
      return canonical
    },
  )

  const compactHyphenatedPattern =
    /\b(?:(all caps|uppercase|lowercase|capitalized?)\s+)((?:[A-Za-z]{2,}-)+[A-Za-z]{2,})\s*[,;:]?\s+([A-Za-z][A-Za-z'-]*)/gi
  text = text.replace(
    compactHyphenatedPattern,
    (whole, casing: string | undefined, spoken: string, cue: string) => {
      const letters = extractLetters(spoken)
      if (!/[A-Z]{2,}/.test(spoken) || !cueMatchesLetters(cue, letters)) return whole
      const canonical = applySpellingCasing(cue, casing)
      learningCandidates.push({ canonical, spokenVariant: spoken.trim() })
      return canonical
    },
  )
  return { text, learningCandidates, ambiguities }
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
    .replace(/[,;:]\s*([.!?])/g, '$1')
    .replace(/([,.;:!?])(?:\s*\1)+/g, '$1')
    .replace(/…(?:\s*\.){1,3}/g, '…')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([,.;:!?])(?=[A-Za-z])/g, '$1 ')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
