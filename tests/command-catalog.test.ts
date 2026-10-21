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
    'Literal punctuation word',
    'Explicit punctuation',
    'Replace',
    'Delete',
    'Insert before',
    'Insert after',
    'Append',
    'Prepend',
    'Move',
    'Punctuation targets',
    'Split',
    'Join',
    'Move before',
    'Move after',
    'Uppercase',
    'Lowercase',
    'Capitalize',
    'Spelled form',
    'As in reference',
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

test('command catalog advertises the complete expanded punctuation vocabulary', () => {
  const examples: Array<readonly [string, string]> = []
  for (const group of COMMAND_GROUPS) examples.push(...group.examples)
  const catalog = examples
    .map(([activation, example]) => `${activation} ${example}`.toLowerCase())
    .join(' ')

  for (const command of [
    'period',
    'comma',
    'colon',
    'semicolon',
    'question mark',
    'exclamation mark',
    'ellipsis',
    'apostrophe',
    'open parenthesis',
    'close parenthesis',
    'open bracket',
    'close bracket',
    'begin bracket',
    'end bracket',
    'hyphen',
    'dash',
    'en dash',
    'em dash',
    'quote',
    'quotation',
    'single quote',
    'single quotation',
    'begin speech',
    'end speech',
    'begin single',
    'end single',
    'new line',
    'new paragraph',
  ]) {
    assert.ok(catalog.includes(command), `missing punctuation command: ${command}`)
  }
})

test('command catalog advertises delete command synonyms', () => {
  const examples: Array<readonly [string, string]> = []
  for (const group of COMMAND_GROUPS) examples.push(...group.examples)
  const catalog = examples
    .map(([activation, example]) => `${activation} ${example}`.toLowerCase())
    .join(' ')

  for (const command of ['delete', 'remove', 'take off']) {
    assert.ok(catalog.includes(command), `missing delete command synonym: ${command}`)
  }
})

test('command catalog advertises flexible editing synonyms', () => {
  const examples: Array<readonly [string, string]> = []
  for (const group of COMMAND_GROUPS) examples.push(...group.examples)
  const catalog = examples
    .map(([activation, example]) => `${activation} ${example}`.toLowerCase())
    .join(' ')

  for (const command of [
    'change',
    'swap',
    'substitute',
    'add',
    'place',
    'put',
    'tack onto',
    'relocate',
    'shift',
    'break',
    'divide',
    'merge',
    'combine',
    'all caps',
  ]) {
    assert.ok(catalog.includes(command), `missing editing synonym: ${command}`)
  }
})
