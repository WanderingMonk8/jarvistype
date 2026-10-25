/**
 * Produces a deliberately coarse key for speech-recognition comparisons.
 *
 * The groups cover common provider substitutions between voiced/unvoiced or
 * closely articulated consonants. A trailing vowel is ignored for longer
 * terms because providers frequently add or drop an unstressed final vowel.
 */
export function speechPhoneticKey(value: string): string {
  const prepared = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ph/gu, 'f')
    .replace(/ght/gu, 't')
    .replace(/gh/gu, '')
    .replace(/ck/gu, 'k')
    .replace(/kn/gu, 'n')
    .replace(/wr/gu, 'r')
    .replace(/qu/gu, 'kw')
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

function speechSoundGroup(character: string): string {
  if (/[aeiouy]/u.test(character)) return 'A'
  // Speech recognition commonly crosses the stop/fricative boundary here
  // (for example, Ervode -> Erbold), so keep all labials in one group.
  if (/[bpfv]/u.test(character)) return 'B'
  if (/[cgjkq]/u.test(character)) return 'K'
  if (/[dt]/u.test(character)) return 'T'
  if (/[sxz]/u.test(character)) return 'S'
  if (character === 'l') return 'L'
  if (character === 'm') return 'M'
  if (character === 'n') return 'N'
  if (character === 'r') return 'R'
  if (/[hw]/u.test(character)) return ''
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
