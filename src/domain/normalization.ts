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
  const pattern =
    /\b(?:(all caps|uppercase|lowercase|capitalized?)\s+)?((?:(?:[A-Za-z]\s*(?:-|dash)\s*){2,}[A-Za-z])|(?:(?:[A-Za-z]\s+){2,}[A-Za-z]))(?:\s*[,;:]?\s+([A-Za-z][A-Za-z'-]*))?/gi
  const text = input.replace(
    pattern,
    (whole, casing: string | undefined, spoken: string, cue: string | undefined) => {
      const letters =
        spoken
          .replace(/\bdash\b/gi, '-')
          .match(/[A-Za-z]/g)
          ?.join('') ?? ''
      if (letters.length < 3) return whole
      let canonical =
        cue && cue.replace(/[-']/g, '').toLowerCase() === letters.toLowerCase() ? cue : letters
      if (casing) {
        const normalized = casing.toLowerCase()
        if (normalized === 'all caps' || normalized === 'uppercase')
          canonical = letters.toUpperCase()
        else if (normalized === 'lowercase') canonical = letters.toLowerCase()
        else canonical = letters[0]!.toUpperCase() + letters.slice(1).toLowerCase()
      } else if (!cue) {
        ambiguities.push(`Confirm the casing of “${letters}”.`)
      }
      learningCandidates.push({ canonical, spokenVariant: spoken.trim() })
      return canonical
    },
  )
  return { text, learningCandidates, ambiguities }
}

function cleanupPunctuationSpacing(value: string): string {
  return value
    .replace(/[ \t]+([,.;:!?)\]])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([,.;:!?])(?=[A-Za-z])/g, '$1 ')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
