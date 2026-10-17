import assert from 'node:assert/strict'
import test from 'node:test'

import { COMMAND_GROUPS } from '../src/frontend'

test('command catalog covers every supported editing operation and composition mode', () => {
  const examples: Array<readonly [string, string]> = []
  for (const group of COMMAND_GROUPS) examples.push(...group.examples)
  const activations = new Set<string>(examples.map(([activation]) => activation))

  for (const activation of [
    'Record Message',
    'Record Edit',
    'Spoken punctuation',
    'Replace',
    'Delete',
    'Insert before',
    'Insert after',
    'Append',
    'Prepend',
    'Split',
    'Join',
    'Move before',
    'Move after',
    'Uppercase',
    'Lowercase',
    'Capitalize',
    'Spelled form',
    'As in',
    'Multiple changes',
  ]) {
    assert.ok(activations.has(activation), `missing command example: ${activation}`)
  }
})

test('command catalog has unique, non-empty activating phrases and examples', () => {
  const examples: Array<readonly [string, string]> = []
  for (const group of COMMAND_GROUPS) examples.push(...group.examples)
  const activations = examples.map(([activation]) => activation)

  assert.equal(new Set(activations).size, activations.length)
  assert.ok(examples.every(([activation, example]) => activation.trim() && example.trim()))
})
