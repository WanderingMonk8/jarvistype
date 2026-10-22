import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearDebugEntries,
  debugDuration,
  formatDebugEntries,
  isDebugEnabled,
  recordDebug,
  setDebugEnabled,
} from '../src/domain/debug'

test('records nothing while debug logging is disabled', () => {
  const userId = 'debug-disabled-user'
  recordDebug(userId, 'request', 'start type=test')
  assert.equal(isDebugEnabled(userId), false)
  const lines = formatDebugEntries(userId)
  assert.ok(lines.some((line) => line.includes('Debug logging is currently off.')))
  assert.equal(
    lines.some((line) => line.includes('[request] start type=test')),
    false,
  )
})

test('records timestamped entries and formats them for copying', () => {
  const userId = 'debug-enabled-user'
  setDebugEnabled(userId, true)
  const startedAt = performance.now()
  recordDebug(userId, 'request', 'start type=edit.interpret.request')
  recordDebug(userId, 'test', `duration=${debugDuration(startedAt)}`)
  const lines = formatDebugEntries(userId)
  const text = lines.join('\n')
  assert.ok(text.includes('# JarvisType debug timing log'))
  assert.match(
    text,
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \+\d+\.\dms \[request\] start type=edit\.interpret\.request$/mu,
  )
  assert.match(text, /\[test\] duration=\d+\.\dms/u)
  assert.equal(text.includes('draft text example'), false)
})

test('keeps debug logs isolated by user and supports clearing', () => {
  const firstUser = 'debug-isolation-first'
  const secondUser = 'debug-isolation-second'
  setDebugEnabled(firstUser, true)
  setDebugEnabled(secondUser, true)
  recordDebug(firstUser, 'request', 'start type=first')
  recordDebug(secondUser, 'request', 'start type=second')
  assert.ok(formatDebugEntries(firstUser).join('\n').includes('type=first'))
  assert.equal(formatDebugEntries(firstUser).join('\n').includes('type=second'), false)
  clearDebugEntries(firstUser)
  const cleared = formatDebugEntries(firstUser).join('\n')
  assert.equal(cleared.includes('type=first'), false)
  assert.ok(formatDebugEntries(secondUser).join('\n').includes('type=second'))
  setDebugEnabled(firstUser, false)
  setDebugEnabled(secondUser, false)
})
