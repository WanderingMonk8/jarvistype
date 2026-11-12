/**
 * Minimal, dependency-free ZIP writer for the Jev comparison report.
 *
 * Files are deflated with the platform `CompressionStream('deflate-raw')` when
 * available and stored verbatim otherwise; both are standard ZIP entries that
 * every unzip tool reads. Names must be ASCII (ours are). CRC-32 is the IEEE
 * polynomial required by the format.
 */

export interface ZipFileInput {
  name: string
  /** Text files are encoded as UTF-8; pass Uint8Array for raw bytes. */
  data: string | Uint8Array
}

// --- CRC-32 (IEEE) -----------------------------------------------------------
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1)
    crc = (CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

const u16 = (view: DataView, offset: number, value: number) => view.setUint16(offset, value & 0xffff, true)
const u32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value >>> 0, true)

function dosDateTime(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f)
  const day = ((date.getFullYear() - 1980) & 0x7f) << 9 | ((date.getMonth() + 1) << 5) | (date.getDate() & 0x1f)
  return { time, date: day }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const input = data.slice() // fresh ArrayBuffer-backed copy; CompressionStream requires it
    const stream = new CompressionStream('deflate-raw')
    const writer = stream.writable.getWriter()
    const done = writer.write(input).then(() => writer.close())
    const reader = stream.readable.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const { done: chunkDone, value } = await reader.read()
      if (chunkDone) break
      if (value) {
        chunks.push(value)
        length += value.length
      }
    }
    await done
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  } catch {
    return null
  }
}

export async function createZip(files: ZipFileInput[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const now = dosDateTime(new Date())
  const localParts: Uint8Array[] = []
  const centralEntries: Array<{
    nameBytes: Uint8Array
    method: number
    crc: number
    compressedSize: number
    uncompressedSize: number
    localHeaderOffset: number
  }> = []
  let offset = 0

  for (const file of files) {
    const data = typeof file.data === 'string' ? utf8(file.data) : file.data
    const nameBytes = encoder.encode(file.name)
    const compressed = await deflateRaw(data)
    const method = compressed && compressed.length < data.length ? 8 : 0
    const payload = method === 8 ? compressed! : data
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(local.buffer)
    u32(view, 0, 0x04034b50)
    u16(view, 4, 20) // version needed
    u16(view, 6, 0x0800) // flag: UTF-8 names
    u16(view, 8, method)
    u16(view, 10, now.time)
    u16(view, 12, now.date)
    u32(view, 14, crc)
    u32(view, 18, payload.length)
    u32(view, 22, data.length)
    u16(view, 26, nameBytes.length)
    u16(view, 28, 0) // extra length
    local.set(nameBytes, 30)
    localParts.push(local, payload)

    centralEntries.push({ nameBytes, method, crc, compressedSize: payload.length, uncompressedSize: data.length, localHeaderOffset: offset })
    offset += local.length + payload.length
  }

  let centralSize = 0
  const centralParts: Uint8Array[] = []
  for (const entry of centralEntries) {
    const central = new Uint8Array(46 + entry.nameBytes.length)
    const view = new DataView(central.buffer)
    u32(view, 0, 0x02014b50)
    u16(view, 4, 20) // version made by
    u16(view, 6, 20) // version needed
    u16(view, 8, 0x0800)
    u16(view, 10, entry.method)
    u16(view, 12, now.time)
    u16(view, 14, now.date)
    u32(view, 16, entry.crc)
    u32(view, 20, entry.compressedSize)
    u32(view, 24, entry.uncompressedSize)
    u16(view, 28, entry.nameBytes.length)
    u16(view, 30, 0) // extra length
    u16(view, 32, 0) // comment length
    u16(view, 34, 0) // disk number
    u16(view, 36, 0) // internal attributes
    u32(view, 38, 0) // external attributes
    u32(view, 42, entry.localHeaderOffset)
    central.set(entry.nameBytes, 46)
    centralParts.push(central)
    centralSize += central.length
  }

  const eocd = new Uint8Array(22)
  const end = new DataView(eocd.buffer)
  u32(end, 0, 0x06054b50)
  u16(end, 4, 0)
  u16(end, 6, 0)
  u16(end, 8, centralEntries.length)
  u16(end, 10, centralEntries.length)
  u32(end, 12, centralSize)
  u32(end, 16, offset)
  u16(end, 20, 0)

  return new Blob([...localParts, ...centralParts, eocd] as BlobPart[], { type: 'application/zip' })
}
