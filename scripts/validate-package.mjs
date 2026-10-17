import { access, readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile('spindle.json', 'utf8'))

if (manifest.identifier !== 'jarvistype') {
  throw new Error('spindle.json identifier must be jarvistype')
}

if (
  !Array.isArray(manifest.permissions) ||
  JSON.stringify(manifest.permissions) !==
    JSON.stringify(['media', 'chats', 'chat_mutation', 'generation'])
) {
  throw new Error('Phase 5 must declare exactly media, chats, chat_mutation, and generation')
}

for (const entry of [manifest.entry_backend, manifest.entry_frontend]) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('Both manifest entry files must be configured')
  }
  await access(entry)
}

if (manifest.name !== 'JarvisType' || manifest.version !== '1.4.4') {
  throw new Error('Phase 6 manifest name and version are invalid')
}

console.log('Validated JarvisType Phase 6 package')
