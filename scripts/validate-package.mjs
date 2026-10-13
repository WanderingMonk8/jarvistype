import { access, readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile('spindle.json', 'utf8'))

if (manifest.identifier !== 'jarvistype') {
  throw new Error('spindle.json identifier must be jarvistype')
}

if (
  !Array.isArray(manifest.permissions) ||
  manifest.permissions.length !== 1 ||
  manifest.permissions[0] !== 'media'
) {
  throw new Error('Phase 1 must declare only the Phase 0-validated media permission')
}

for (const entry of [manifest.entry_backend, manifest.entry_frontend]) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('Both manifest entry files must be configured')
  }
  await access(entry)
}

if (manifest.name !== 'JarvisType' || manifest.version !== '0.7.0') {
  throw new Error('Phase 1 manifest name and version are invalid')
}

console.log('Validated JarvisType Phase 1 package')
