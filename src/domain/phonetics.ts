/**
 * Produces a deliberately coarse key for speech-recognition comparisons.
 *
 * Sounds are grouped by articulation, not by spelling or word category, so the
 * key stays a sound comparison. The groups only combine phonemes that
 * recognizers genuinely confuse: voiced/unvoiced pairs (`d`/`t`, `s`/`z`),
 * hard velar stops (`c`/`g`/`k`/`q`), and labials that cross the stop/fricative
 * boundary (`b`/`p`/`f`/`v`, for example "Ervode" → "Erbold").
 *
 * Distinct places of articulation stay distinct:
 * `th` (dental fricative, e.g. "this" /ð/) is not `t` ("tess" /t/),
 * `sh` (/ʃ/) is not `s` (/s/), `ch` (/tʃ/) is not `k` (/k/) or `t` (/t/),
 * and `j` (/dʒ/) is an affricate, not a velar stop ("Juan" vs "Ken").
 *
 * Vowels intentionally collapse to one group because providers vary them
 * heavily. `h` is elided because h-dropping is a common pronunciation and
 * recognition pattern. `w` is not elided: dropping /w/ changes the word
 * identity ("Weston" vs "Easton"), so it keeps its own group.
 *
 * A trailing vowel is ignored for longer terms because providers frequently
 * add or drop an unstressed final vowel.
 */
export function speechPhoneticKey(value: string): string {
  const prepared = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ph/gu, 'f')
    .replace(/th/gu, 'D')
    .replace(/sh/gu, 'X')
    .replace(/ch/gu, 'J')
    .replace(/ght/gu, 't')
    .replace(/gh/gu, '')
    .replace(/ck/gu, 'k')
    .replace(/kn/gu, 'n')
    .replace(/wr/gu, 'r')
    .replace(/qu/gu, 'kw')
    // Soft "c" before a front vowel is /s/, not the hard velar /k/.
    .replace(/c(?=[eiy])/gu, 's')
  let key = ''
  for (const character of prepared) {
    const sound = speechSoundGroup(character)
    if (sound && sound !== key.at(-1)) key += sound
  }
  return key.length >= 4 ? key.replace(/A$/u, '') : key
}

/**
 * A key may gain or lose one sound group while still describing the same name.
 * Substitutions are not neighbors: families that describe genuinely different
 * sounds (for example `j` and `k`) must stay apart at every word length.
 */
export function areSpeechPhoneticNeighbors(left: string, right: string): boolean {
  const leftKey = speechPhoneticKey(left)
  const rightKey = speechPhoneticKey(right)
  if (leftKey === rightKey) return true
  if (
    Math.min(leftKey.length, rightKey.length) < 4 ||
    leftKey.charAt(0) !== rightKey.charAt(0) ||
    Math.abs(leftKey.length - rightKey.length) !== 1
  )
    return false
  const shorter = leftKey.length < rightKey.length ? leftKey : rightKey
  const longer = leftKey.length < rightKey.length ? rightKey : leftKey
  let shortIndex = 0
  let longIndex = 0
  let skipped = false
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1
      longIndex += 1
      continue
    }
    if (skipped) return false
    skipped = true
    longIndex += 1
  }
  return true
}

/**
 * Whether swapping one letter for another is a plausible recognition variant.
 * Substitution is only allowed inside one sound family, so vowels replace
 * vowels and consonants replace consonants of the same family. Crossing from a
 * vowel to a consonant changes the word ("Willie" vs "Willum"), and `j` must
 * never stand in for `k`, however long the word is.
 */
export function areSpeechLettersCompatible(left: string, right: string): boolean {
  return (
    speechSoundGroup(left.toLocaleLowerCase()) === speechSoundGroup(right.toLocaleLowerCase())
  )
}

/**
 * One entry per consonant family. Family letters double as the key alphabet,
 * so an uppercase marker produced by a digraph rewrite (`th` → `D`, `sh` → `X`,
 * `ch`/`j` → `J`) simply falls through unchanged.
 */
const CONSONANT_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  // Labials cross the stop/fricative boundary in recognition (Ervode → Erbold).
  [/[bpfv]/u, 'B'],
  // Alveolar stops, a voiced/unvoiced pair.
  [/[dt]/u, 'T'],
  // Hard velar stops. Soft "c" was rewritten to "s" above.
  [/[cgkq]/u, 'K'],
  // Sibilant fricatives.
  [/[sxz]/u, 'S'],
  // Affricates, a voiced/unvoiced pair; kept apart from the stop families.
  [/j/u, 'J'],
  [/l/u, 'L'],
  [/m/u, 'M'],
  [/n/u, 'N'],
  [/r/u, 'R'],
  [/w/u, 'W'],
]

function speechSoundGroup(character: string): string {
  if (/[aeiouy]/u.test(character)) return 'A'
  // H-dropping is a common pronunciation and recognition pattern.
  if (character === 'h') return ''
  for (const [pattern, family] of CONSONANT_FAMILIES)
    if (pattern.test(character)) return family
  return /[\p{L}\p{N}]/u.test(character) ? character : ''
}
