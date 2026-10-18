export const GLOSSARY_SCHEMA_VERSION = 1 as const
export const MAX_GLOSSARY_ENTRIES = 500
export const GLOSSARY_PERFORMANCE_FIXTURE_ID_PREFIX = 'jt-phase7-fixture-'

export interface GlossaryEntry {
  id: string
  canonical: string
  variants: string[]
  hint: string
  source: 'explicit-spelling' | 'manual'
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
  },
  now = new Date().toISOString(),
  createId: () => string = () => crypto.randomUUID(),
): GlossaryMutation {
  const canonical = input.canonical.trim()
  if (!canonical) return { state, changed: false }
  const variants = unique([...(input.variants ?? [])].map((value) => value.trim()).filter(Boolean))
  const keys = new Set([canonical, ...variants].map(normalizeKey))
  const conflict = state.entries.find(
    (entry) =>
      entry.id !== input.id &&
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
        updatedAt: now,
      }
    : {
        id: createId(),
        canonical,
        variants,
        hint: input.hint?.trim() ?? '',
        source: input.source,
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
): GlossaryMutation {
  const key = normalizeKey(canonical)
  const existing = state.entries.find((entry) => normalizeKey(entry.canonical) === key)
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
    { canonical, variants: spokenVariant ? [spokenVariant] : [], source: 'explicit-spelling' },
    now,
    createId,
  )
  if (result.entry) result.entry.useCount = 1
  return result
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

export function toggleGlossaryPerformanceFixture(
  state: GlossaryState,
  now = new Date().toISOString(),
): GlossaryMutation {
  const hasFixture = state.entries.some((entry) =>
    entry.id.startsWith(GLOSSARY_PERFORMANCE_FIXTURE_ID_PREFIX),
  )
  if (hasFixture) {
    return {
      state: pushUndo(
        state,
        state.entries.filter(
          (entry) => !entry.id.startsWith(GLOSSARY_PERFORMANCE_FIXTURE_ID_PREFIX),
        ),
      ),
      changed: true,
    }
  }

  const keys = new Set(
    state.entries.flatMap((entry) => [entry.canonical, ...entry.variants]).map(normalizeKey),
  )
  const additions: GlossaryEntry[] = []
  for (let index = 1; state.entries.length + additions.length < MAX_GLOSSARY_ENTRIES; index += 1) {
    const suffix = index.toString().padStart(4, '0')
    const canonical = `JTPerfTerm${suffix}`
    const variant = `jay tee performance term ${suffix}`
    if (keys.has(normalizeKey(canonical)) || keys.has(normalizeKey(variant))) continue
    keys.add(normalizeKey(canonical))
    keys.add(normalizeKey(variant))
    additions.push({
      id: `${GLOSSARY_PERFORMANCE_FIXTURE_ID_PREFIX}${suffix}`,
      canonical,
      variants: [variant],
      hint: `Synthetic Phase 7 glossary performance fixture ${suffix}`,
      source: 'manual',
      useCount: index % 8,
      createdAt: now,
      updatedAt: now,
    })
  }
  if (!additions.length) return { state, changed: false }
  return { state: pushUndo(state, [...state.entries, ...additions]), changed: true }
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
    Number.isSafeInteger(value.useCount) &&
    Number(value.useCount) >= 0 &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
