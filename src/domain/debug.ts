export interface DebugEntry {
  at: string
  offsetMs: number
  category: string
  message: string
}

const MAX_ENTRIES = 2_000
const MAX_MESSAGE_CHARACTERS = 500
const MAX_CATEGORY_CHARACTERS = 40

const entriesByUser = new Map<string, DebugEntry[]>()
const enabledUsers = new Set<string>()
const activeCaptureUsers = new Map<string, number>()
const startedAt = performance.now()

export function setDebugEnabled(userId: string, enabled: boolean): void {
  if (enabled) enabledUsers.add(userId)
  else enabledUsers.delete(userId)
}

export function beginDebugCapture(userId: string): void {
  activeCaptureUsers.set(userId, (activeCaptureUsers.get(userId) ?? 0) + 1)
}

export function endDebugCapture(userId: string): void {
  const active = activeCaptureUsers.get(userId) ?? 0
  if (active <= 1) activeCaptureUsers.delete(userId)
  else activeCaptureUsers.set(userId, active - 1)
}

export function isDebugEnabled(userId: string): boolean {
  return enabledUsers.has(userId)
}

/**
 * Records one timing line. Callers must pass metadata only: request types,
 * identifiers, counts, durations, and outcomes. Never pass draft text,
 * transcripts, prompts, or provider output.
 */
export function recordDebug(userId: string, category: string, message: string): void {
  if (!enabledUsers.has(userId) || !activeCaptureUsers.has(userId)) return
  const entries = entriesByUser.get(userId) ?? []
  entries.push({
    at: new Date().toISOString(),
    offsetMs: performance.now() - startedAt,
    category: clip(category, MAX_CATEGORY_CHARACTERS),
    message: clip(message, MAX_MESSAGE_CHARACTERS),
  })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  entriesByUser.set(userId, entries)
}

export function formatDebugEntries(userId: string): string[] {
  const entries = entriesByUser.get(userId) ?? []
  const header = [
    '# JarvisType debug timing log',
    `# Generated ${new Date().toISOString()}`,
    `# ${entries.length} entries; backend system time is UTC and offsets are monotonic.`,
    '# Metadata only: no draft text, transcript, prompt, or provider output is recorded.',
  ]
  if (!enabledUsers.has(userId)) header.push('# Debug logging is currently off.')
  return [
    ...header,
    ...entries.map(
      (entry) => `${entry.at} +${entry.offsetMs.toFixed(1)}ms [${entry.category}] ${entry.message}`,
    ),
  ]
}

export function clearDebugEntries(userId: string): void {
  entriesByUser.delete(userId)
}

export function debugDuration(startedAtMs: number): string {
  return `${Math.max(0, performance.now() - startedAtMs).toFixed(1)}ms`
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}
