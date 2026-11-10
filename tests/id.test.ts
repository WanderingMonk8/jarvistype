import assert from 'node:assert/strict'
import test from 'node:test'
import { createId } from '../src/domain/id'
import { createRequestId } from '../src/protocol/messages'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('createId produces RFC 4122 version 4 UUIDs without secure-context crypto', () => {
  for (let index = 0; index < 100; index += 1) assert.match(createId(), UUID_V4_PATTERN)
})

test('createId generates unique ids', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => createId()))
  assert.equal(ids.size, 1000)
})

test('createRequestId prefixes an RFC 4122 v4 UUID', () => {
  const requestId = createRequestId('example')
  assert.match(requestId, /^example-[0-9a-z]+-[0-9a-f-]{36}$/)
  assert.match(requestId.slice(-36), UUID_V4_PATTERN)
})
