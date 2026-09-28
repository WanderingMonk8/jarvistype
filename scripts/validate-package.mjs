import { access, readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile('spindle.json', 'utf8'))

if (manifest.identifier !== 'jarvistype') {
  throw new Error('spindle.json identifier must be jarvistype')
}

if (!Array.isArray(manifest.permissions) || manifest.permissions.length !== 0) {
  throw new Error('The Phase 0 probe must not request gated permissions')
}

for (const entry of [manifest.entry_backend, manifest.entry_frontend]) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('Both manifest entry files must be configured')
  }
  await access(entry)
}

console.log('Validated Phase 0 probe package')
