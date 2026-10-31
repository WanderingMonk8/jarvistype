export const GLOSSARY_SCHEMA_VERSION = 1 as const
export const MAX_GLOSSARY_ENTRIES = 500

/** Conservative wording comparison only; this does not classify spoken intent. */
export function hasNearIdenticalHintWording(spoken: string, hint: string): boolean {
  const words = (value: string): string[] => {
    const tokens = value.normalize('NFKC').toLocaleLowerCase().replace(/[’]/gu, "'")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu) ?? []
    if (['a', 'an', 'the'].includes(tokens[0] ?? '')) tokens.shift()
    return tokens.map((word) => word.length > 4 && word.endsWith('ies')
      ? `${word.slice(0, -3)}y`
      : word.length > 4 && word.endsWith('s') && !word.endsWith('ss')
        ? word.slice(0, -1)
        : word)
  }
  const left = words(spoken)
  const right = words(hint)
  return left.length > 0 && left.length === right.length && left.every((word, index) => word === right[index])
}

export interface GlossaryEntry {
  id: string
  canonical: string
  variants: string[]
  hint: string
  source: 'explicit-spelling' | 'manual'
  /** Missing on legacy entries, which are treated as global. */
  scope?: 'local' | 'global'
  /** Present only for chat-local entries. */
  chatId?: string
  useCount: number
  createdAt: string
  updatedAt: string
}

export interface GlossaryState {
  schemaVersion: typeof GLOSSARY_SCHEMA_VERSION
  entries: GlossaryEntry[]
  undoStack: GlossaryEntry[][]
}

export interface GlossaryMutation {
  state: GlossaryState
  changed: boolean
  conflict?: GlossaryEntry
  entry?: GlossaryEntry
}

export function createGlossaryState(): GlossaryState {
  return { schemaVersion: GLOSSARY_SCHEMA_VERSION, entries: [], undoStack: [] }
}

export function upsertGlossaryEntry(
  state: GlossaryState,
  input: {
    id?: string
    canonical: string
    variants?: string[]
    hint?: string
    source: GlossaryEntry['source']
    scope?: 'local' | 'global'
    chatId?: string
  },
  now = new Date().toISOString(),
  createId: () => string = () => crypto.randomUUID(),
): GlossaryMutation {
  const canonical = input.canonical.trim()
  if (!canonical) return { state, changed: false }
  const variants = unique([...(input.variants ?? [])].map((value) => value.trim()).filter(Boolean))
  const scope = input.scope ?? 'global'
  const chatId = scope === 'local' ? input.chatId?.trim() : undefined
  if (scope === 'local' && !chatId) return { state, changed: false }
  const keys = new Set([canonical, ...variants].map(normalizeKey))
  const conflict = state.entries.find(
    (entry) =>
      entry.id !== input.id &&
      glossaryScopeKey(entry) === `${scope}:${chatId ?? ''}` &&
      [entry.canonical, ...entry.variants].some((value) => keys.has(normalizeKey(value))),
  )
  if (conflict) return { state, changed: false, conflict }

  const existing = input.id ? state.entries.find((entry) => entry.id === input.id) : undefined
  const entry: GlossaryEntry = existing
    ? {
        ...existing,
        canonical,
        variants,
        hint: input.hint?.trim() ?? '',
        source: input.source,
        scope,
        ...(chatId ? { chatId } : { chatId: undefined }),
        updatedAt: now,
      }
    : {
        id: createId(),
        canonical,
        variants,
        hint: input.hint?.trim() ?? '',
        source: input.source,
        scope,
        ...(chatId ? { chatId } : {}),
        useCount: 0,
        createdAt: now,
        updatedAt: now,
      }
  const entries = existing
    ? state.entries.map((item) => (item.id === existing.id ? entry : item))
    : [...state.entries, entry].slice(-MAX_GLOSSARY_ENTRIES)
  return { state: pushUndo(state, entries), changed: true, entry }
}

export function learnExplicitSpelling(
  state: GlossaryState,
  canonical: string,
  spokenVariant: string,
  now = new Date().toISOString(),
  createId?: () => string,
  scope: 'local' | 'global' = 'global',
  chatId?: string,
): GlossaryMutation {
  const key = normalizeKey(canonical)
  const scopeKey = `${scope}:${scope === 'local' ? (chatId ?? '') : ''}`
  const existing = state.entries.find(
    (entry) => normalizeKey(entry.canonical) === key && glossaryScopeKey(entry) === scopeKey,
  )
  if (existing) {
    const variants = unique([...existing.variants, spokenVariant].filter(Boolean))
    const entry = { ...existing, variants, useCount: existing.useCount + 1, updatedAt: now }
    return {
      state: pushUndo(
        state,
        state.entries.map((item) => (item.id === entry.id ? entry : item)),
      ),
      changed: true,
      entry,
    }
  }
  const result = upsertGlossaryEntry(
    state,
    {
      canonical,
      variants: spokenVariant ? [spokenVariant] : [],
      source: 'explicit-spelling',
      scope,
      chatId,
    },
    now,
    createId,
  )
  if (result.entry) result.entry.useCount = 1
  return result
}

export function glossaryEntriesForChat(
  state: GlossaryState,
  chatId: string,
): GlossaryEntry[] {
  return state.entries.filter(
    (entry) => (entry.scope ?? 'global') === 'global' || entry.chatId === chatId,
  )
}

export function deleteGlossaryEntry(state: GlossaryState, id: string): GlossaryMutation {
  if (!state.entries.some((entry) => entry.id === id)) return { state, changed: false }
  return {
    state: pushUndo(
      state,
      state.entries.filter((entry) => entry.id !== id),
    ),
    changed: true,
  }
}

export function undoGlossaryMutation(state: GlossaryState): GlossaryMutation {
  const previous = state.undoStack.at(-1)
  if (!previous) return { state, changed: false }
  return {
    state: { ...state, entries: previous, undoStack: state.undoStack.slice(0, -1) },
    changed: true,
  }
}

export function isGlossaryState(value: unknown): value is GlossaryState {
  if (!isRecord(value) || value.schemaVersion !== GLOSSARY_SCHEMA_VERSION) return false
  if (!Array.isArray(value.entries) || value.entries.length > MAX_GLOSSARY_ENTRIES) return false
  if (!value.entries.every(isGlossaryEntry)) return false
  return (
    Array.isArray(value.undoStack) &&
    value.undoStack.length <= 20 &&
    value.undoStack.every(
      (snapshot) =>
        Array.isArray(snapshot) &&
        snapshot.length <= MAX_GLOSSARY_ENTRIES &&
        snapshot.every(isGlossaryEntry),
    )
  )
}

function pushUndo(state: GlossaryState, entries: GlossaryEntry[]): GlossaryState {
  return { ...state, entries, undoStack: [...state.undoStack, state.entries].slice(-20) }
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, '')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function isGlossaryEntry(value: unknown): value is GlossaryEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.canonical === 'string' &&
    value.canonical.trim().length > 0 &&
    Array.isArray(value.variants) &&
    value.variants.every((item) => typeof item === 'string') &&
    typeof value.hint === 'string' &&
    (value.source === 'explicit-spelling' || value.source === 'manual') &&
    (value.scope === undefined || value.scope === 'local' || value.scope === 'global') &&
    (value.chatId === undefined || typeof value.chatId === 'string') &&
    (value.scope !== 'local' || (typeof value.chatId === 'string' && value.chatId.length > 0)) &&
    Number.isSafeInteger(value.useCount) &&
    Number(value.useCount) >= 0 &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function glossaryScopeKey(entry: GlossaryEntry): string {
  const scope = entry.scope ?? 'global'
  return `${scope}:${scope === 'local' ? (entry.chatId ?? '') : ''}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
