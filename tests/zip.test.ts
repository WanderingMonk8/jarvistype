import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32, createZip } from '../src/domain/zip'

test('crc32 matches the IEEE check vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  assert.equal(crc32(new TextEncoder().encode('')), 0)
})

test('createZip emits a readable archive with correct metadata', async () => {
  const zip = await createZip([
    { name: 'README.txt', data: 'hello zip' },
    { name: 'data.json', data: '{"a":1}\n' },
  ])
  const bytes = new Uint8Array(await zip.arrayBuffer())
  // Local file header and end-of-central-directory signatures.
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  const eocdSignature = [0x50, 0x4b, 0x05, 0x06]
  let eocdOffset = -1
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (eocdSignature.every((value, inner) => bytes[index + inner] === value)) { eocdOffset = index; break }
  }
  assert.ok(eocdOffset >= 0, 'end-of-central-directory record not found')
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  assert.equal(view.getUint16(eocdOffset + 8, true), 2) // entries on this disk
  assert.equal(view.getUint16(eocdOffset + 10, true), 2) // total entries
  // Central directory entries follow the local headers; verify both are found.
  const centralSignature = [0x50, 0x4b, 0x01, 0x02]
  let centralCount = 0
  for (let index = 0; index < bytes.length - 4; index += 1)
    if (centralSignature.every((value, inner) => bytes[index + inner] === value)) centralCount += 1
  assert.equal(centralCount, 2)
})
