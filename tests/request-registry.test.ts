import assert from 'node:assert/strict'
import test from 'node:test'

import { RequestRegistry } from '../src/domain/request-registry'

test('supports a per-request timeout without changing the default', async () => {
  const registry = new RequestRegistry<string>(100)
  assert.equal((await registry.wait('short', 5)).status, 'timed-out')
  const pending = registry.wait('default')
  assert.equal(registry.resolve('default', 'ok'), true)
  assert.deepEqual(await pending, { status: 'resolved', value: 'ok' })
})

test('resolves a matching request and rejects stale responses', async () => {
  const registry = new RequestRegistry<string>(100)
  const outcome = registry.wait('current')

  assert.equal(registry.resolve('stale', 'ignored'), false)
  assert.equal(registry.resolve('current', 'ready'), true)
  assert.deepEqual(await outcome, { status: 'resolved', value: 'ready' })
  assert.equal(registry.size, 0)
})

test('times out and reports the request id', async () => {
  const timedOut: string[] = []
  const registry = new RequestRegistry<string>(5, (requestId) => timedOut.push(requestId))

  assert.deepEqual(await registry.wait('slow'), { status: 'timed-out' })
  assert.deepEqual(timedOut, ['slow'])
})

test('cancels every pending request during teardown', async () => {
  const registry = new RequestRegistry<string>(100)
  const first = registry.wait('first')
  const second = registry.wait('second')

  registry.cancelAll()

  assert.deepEqual(await first, { status: 'cancelled' })
  assert.deepEqual(await second, { status: 'cancelled' })
  assert.equal(registry.size, 0)
})
