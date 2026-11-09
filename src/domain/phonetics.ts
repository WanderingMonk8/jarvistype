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

/** A one-group difference is allowed only for substantial, same-opening keys. */
export function areSpeechPhoneticNeighbors(left: string, right: string): boolean {
  const leftKey = speechPhoneticKey(left)
  const rightKey = speechPhoneticKey(right)
  if (Math.min(leftKey.length, rightKey.length) < 4 || leftKey.charAt(0) !== rightKey.charAt(0))
    return false
  return editDistanceAtMost(leftKey, rightKey, 1)
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

function editDistanceAtMost(left: string, right: string, maximum: number): boolean {
  if (Math.abs(left.length - right.length) > maximum) return false
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      const distance = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      )
      current.push(distance)
      rowMinimum = Math.min(rowMinimum, distance)
    }
    if (rowMinimum > maximum) return false
    previous = current
  }
  return previous[right.length]! <= maximum
}
