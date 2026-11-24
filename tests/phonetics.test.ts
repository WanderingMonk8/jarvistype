import test from 'node:test'
import assert from 'node:assert/strict'
import { areSpeechPhoneticNeighbors, areSpeechVowelGlideNeighbors } from '../src/domain/phonetics'

test('explicit-hint vowel-glide matching handles vowel spellings without changing the general matcher', () => {
  for (const [canonical, heard] of [['Nao', 'now'], ['Lau', 'law'], ['Seu', 'sew'], ['Lou', 'low'], ['N-A-O', 'now'], ['Taura', 'Tawra']] as const) {
    assert.equal(areSpeechVowelGlideNeighbors(canonical, heard), true, `${canonical}/${heard}`)
    assert.equal(areSpeechVowelGlideNeighbors(heard, canonical), true, `${heard}/${canonical}`)
  }
  assert.equal(areSpeechPhoneticNeighbors('Nao', 'now'), false)
  for (const [left, right] of [['Nao', 'cow'], ['Nao', 'no'], ['Nao', 'nao'], ['Lau', 'lawson'], ['ta', 'taw'], ['Nao君', 'now'], ['Nao2', 'now']] as const)
    assert.equal(areSpeechVowelGlideNeighbors(left, right), false, `${left}/${right}`)
})
