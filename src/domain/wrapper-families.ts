/**
 * Pair-marker registry for the wrapper-aware edit flow. Every paired punctuation
 * family that can be commanded explicitly — `put quotation marks around X`,
 * `put single quotes around X`, `put parentheses around X`, `put brackets around X`,
 * `put angle brackets around X`, … — is identified here with its open/close pair and
 * its recognition regex. The intent:
 *
 *   1. Every pair family is treated as first-class equivalent to quotation marks.
 *   2. The wrapper-aware validation/repair normalizes against this registry instead
 *      of hard-coded `“”‘’` inspection, so no pairing is accidentally special-cased.
 */
export type WrapperFamilyId =
  | 'double-quote'
  | 'single-quote'
  | 'parentheses'
  | 'brackets'
  | 'braces'
  | 'angle-brackets'

export interface WrapperFamily {
  readonly id: WrapperFamilyId
  readonly open: string
  readonly close: string
  readonly name: string
  readonly explanatoryName: string
  /** Regex alternation matched against the spoken token (case-insensitive). */
  readonly tokenPattern: string
  /** Stores the family as ordinary-punctuation match (no anchoring). */
  readonly openPattern: RegExp
  readonly closePattern: RegExp
}

export const WRAPPER_FAMILIES: readonly WrapperFamily[] = [
  {
    id: 'double-quote',
    open: '“',
    close: '”',
    name: 'quotation marks',
    explanatoryName: 'quotation marks',
    tokenPattern: String.raw`(?:(?:double\s+)?(?:quotation\s+marks?|quote\s+marks?|quotations?|quotes?|double\s+quotes?))`,
    openPattern: /^[“"]$/u,
    closePattern: /^[”"]$/u,
  },
  {
    id: 'single-quote',
    open: '‘',
    close: '’',
    name: 'single quotation marks',
    explanatoryName: 'single quotation marks',
    tokenPattern: String.raw`(?:(?:single\s+)?(?:single\s+(?:quotation|quote|quotations|quotes|mark)(?:\s+marks?)?|singles?|single))`,
    openPattern: /^[‘']$/u,
    closePattern: /^[’']$/u,
  },
  {
    id: 'parentheses',
    open: '(',
    close: ')',
    name: 'parentheses',
    explanatoryName: 'parentheses',
    tokenPattern: String.raw`(?:parens?|parentheses|parenthesis|round\s+brackets?|round\s+bracket)`,
    openPattern: /^\($/u,
    closePattern: /^\)$/u,
  },
  {
    id: 'brackets',
    open: '[',
    close: ']',
    name: 'brackets',
    explanatoryName: 'brackets',
    tokenPattern: String.raw`(?:square\s+brackets?|square\s+bracket|brackets?|bracket)`,
    openPattern: /^\[$/u,
    closePattern: /^\]$/u,
  },
  {
    id: 'braces',
    open: '{',
    close: '}',
    name: 'braces',
    explanatoryName: 'braces',
    tokenPattern: String.raw`(?:curly\s+(?:braces?|brackets?)|curly\s+ones?|braces?|brace|curly\s+bracket)`,
    openPattern: /^\{$/u,
    closePattern: /^\}$/u,
  },
  {
    id: 'angle-brackets',
    open: '<',
    close: '>',
    name: 'angle brackets',
    explanatoryName: 'angle brackets',
    tokenPattern: String.raw`(?:angle\s+brackets?|angle\s+bracket|less\s+than\s+greater\s+than|greater\s+than\s+less\s+than|greater\s+and\s+less\s+than|less\s+and\s+greater\s+than|greater\s+less\s+than|less\s+greater\s+than|less\s+than\s+(?:and\s+)?more\s+than|chevrons?|chevron)`,
    openPattern: /^<$/u,
    closePattern: /^>$/u,
  },
]

const OPEN_TO_FAMILY = new Map<string, WrapperFamily>(WRAPPER_FAMILIES.map((family) => [family.open, family]))
const CLOSE_TO_FAMILY = new Map<string, WrapperFamily>(WRAPPER_FAMILIES.map((family) => [family.close, family]))

const OPENERS_GROUP = `(?:${WRAPPER_FAMILIES.map((family) => [family.open]).flat().map((character) => character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')}|"|')`
const CLOSERS_GROUP = `(?:${WRAPPER_FAMILIES.map((family) => [family.close]).flat().map((character) => character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')}|"|')`

/** Closing punctuation from the wrapper-families registry, plus ordinary ASCII punctuation used as openers/closers. */
const CLOSERS_LITERALS = [
  ...WRAPPER_FAMILIES.map((family) => family.close),
  ',', ';', ':', '!', '?', '.', ')', '}', ']', '"', `'`,
]
export const PUNCTUATION_CLOSERS_REGEX = new RegExp(
  `[${CLOSERS_LITERALS.map((character) => character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('')}]`,
  'u',
)
export const WRAPPER_OPENERS_REGEX = new RegExp(OPENERS_GROUP, 'u')
export const WRAPPER_CLOSERS_REGEX = new RegExp(CLOSERS_GROUP, 'u')

export function findWrapperFamilyByOpen(character: string): WrapperFamily | undefined {
  return OPEN_TO_FAMILY.get(character)
}

export function findWrapperFamilyByClose(character: string): WrapperFamily | undefined {
  return CLOSE_TO_FAMILY.get(character)
}

export function isWrapperOpener(character: string): boolean {
  return OPEN_TO_FAMILY.has(character)
}

export function isWrapperCloser(character: string): boolean {
  return CLOSE_TO_FAMILY.has(character)
}

/**
 * Resolve a spoken marker word or compound (`parentheses`, `single quotation marks`,
 * `square bracket`, `single`, `double`) into a wrapper family. Normalises case,
 * whitespace, and optional `the/a/an`-like prefixes; bare `single` / `double` map to
 * the quote families.
 */
export function resolveWrapperFamily(raw: string | undefined | null): WrapperFamily | null {
  if (!raw) return null
  let normalized = raw.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')
  normalized = normalized.replace(/^(?:the|a|an)\s+/giu, '').trim()
  const direct = findWrapperFamily(normalized)
  if (direct) return direct
  if (normalized === 'single' || normalized === 'single quote' || normalized === 'single quotation') return WRAPPER_FAMILIES.find((family) => family.id === 'single-quote') ?? null
  if (normalized === 'double' || normalized === 'double quote' || normalized === 'double quotation') return WRAPPER_FAMILIES.find((family) => family.id === 'double-quote') ?? null
  return null
}

export function findWrapperFamily(token: string): WrapperFamily | undefined {
  const normalized = token.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')
  for (const family of WRAPPER_FAMILIES) {
    const tester = new RegExp(`^${family.tokenPattern}$`, 'iu')
    if (tester.test(normalized)) return family
  }
  return undefined
}

export function wrapperPairOf(tag: WrapperFamilyId): { open: string; close: string } | null {
  const family = WRAPPER_FAMILIES.find((candidate) => candidate.id === tag)
  return family ? { open: family.open, close: family.close } : null
}

/** Alternation regex matching the spoken marker token alone, e.g. `quotes`, `parens`, `brackets`. */
export const WRAPPER_TOKEN_PATTERN = WRAPPER_FAMILIES.map((family) => family.tokenPattern).join('|')

export function allWrapperFamiliesToken(): string {
  return `(?:${WRAPPER_TOKEN_PATTERN})`
}
