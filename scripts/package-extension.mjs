import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(rootDirectory, 'dist')

// Keep the release surface explicit. Tests, design sources, local browser
// profiles, and development output must never enter the extension archive.
const releaseFiles = [
  'assets/icon-16.png',
  'assets/icon-32.png',
  'assets/icon-48.png',
  'assets/icon-128.png',
  'LICENSE',
  'LICENSES/mermaid-11.16.1-bundle-components.md',
  'LICENSES/mermaid-11.16.1-bundle-licenses.txt',
  'CHANGELOG.md',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'manifest.json',
  'sidepanel.html',
  'src/background.js',
  'src/github-oauth-config.js',
  'src/lib/ai-client.js',
  'src/lib/analysis-plan.js',
  'src/lib/analysis-settings.js',
  'src/lib/analysis.js',
  'src/lib/architecture-graph.js',
  'src/lib/cache.js',
  'src/lib/connection.js',
  'src/lib/github-auth-state.js',
  'src/lib/github-auth-ui.js',
  'src/lib/github-auth.js',
  'src/lib/github-cache.js',
  'src/lib/github-request-state.js',
  'src/lib/github-rpc.js',
  'src/lib/github.js',
  'src/lib/provider-url.js',
  'src/lib/provider-vault-authority.js',
  'src/lib/provider-vault.js',
  'src/lib/repository-selector.js',
  'src/lib/sse.js',
  'src/sidepanel.css',
  'src/sidepanel.js',
  'src/vendor/MERMAID_LICENSE.txt',
  'src/vendor/mermaid-11.16.1.min.js',
].sort()

const packageMetadata = JSON.parse(await readFile(join(rootDirectory, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(rootDirectory, 'manifest.json'), 'utf8'))
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  return value >>> 0
})

if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
  throw new Error(`Unsupported extension version: ${manifest.version}`)
}
if (packageMetadata.version !== manifest.version) {
  throw new Error(`package.json version ${packageMetadata.version} does not match manifest version ${manifest.version}`)
}

const entries = []
for (const archivePath of releaseFiles) {
  assertSafeArchivePath(archivePath)
  const sourcePath = join(rootDirectory, ...archivePath.split('/'))
  const metadata = await stat(sourcePath)
  if (!metadata.isFile()) throw new Error(`Release entry is not a regular file: ${archivePath}`)

  // Git can check text out with platform-specific line endings. Normalizing the
  // known-text release surface makes the archive reproducible across hosts.
  const source = await readFile(sourcePath)
  const data = archivePath.endsWith('.png')
    ? source
    : Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(source).replace(/\r\n?/g, '\n'), 'utf8')
  entries.push({ path: archivePath, data })
}

const archive = createZip(entries)
const archiveName = `repolens-extension-${manifest.version}.zip`
const outputPath = join(outputDirectory, archiveName)
const temporaryPath = `${outputPath}.tmp-${process.pid}`

await mkdir(outputDirectory, { recursive: true })
await writeFile(temporaryPath, archive)
await rm(outputPath, { force: true })
await rename(temporaryPath, outputPath)

const digest = createHash('sha256').update(archive).digest('hex')
console.log(`Created ${outputPath}`)
console.log(`SHA-256 ${digest}`)

function assertSafeArchivePath(value) {
  if (!/^[A-Za-z0-9_.\-/]+$/.test(value)
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').includes('..')) {
    throw new Error(`Unsafe release path: ${value}`)
  }
}

function createZip(files) {
  const localRecords = []
  const centralRecords = []
  let localOffset = 0

  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const checksum = crc32(file.data)
    assertZip32Value(file.data.length, `file size for ${file.path}`)
    assertZip32Value(localOffset, `offset for ${file.path}`)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0x0021, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(file.data.length, 18)
    localHeader.writeUInt32LE(file.data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x0021, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(file.data.length, 20)
    centralHeader.writeUInt32LE(file.data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)

    localRecords.push(localHeader, name, file.data)
    centralRecords.push(centralHeader, name)
    localOffset += localHeader.length + name.length + file.data.length
  }

  if (files.length > 0xffff) throw new Error('ZIP32 entry count exceeded')
  const centralDirectory = Buffer.concat(centralRecords)
  assertZip32Value(centralDirectory.length, 'central directory size')
  assertZip32Value(localOffset, 'central directory offset')

  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4)
  endRecord.writeUInt16LE(0, 6)
  endRecord.writeUInt16LE(files.length, 8)
  endRecord.writeUInt16LE(files.length, 10)
  endRecord.writeUInt32LE(centralDirectory.length, 12)
  endRecord.writeUInt32LE(localOffset, 16)
  endRecord.writeUInt16LE(0, 20)

  return Buffer.concat([...localRecords, centralDirectory, endRecord])
}

function assertZip32Value(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`ZIP32 ${label} exceeded`)
  }
}

function crc32(data) {
  let checksum = 0xffffffff
  for (const byte of data) checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8)
  return (checksum ^ 0xffffffff) >>> 0
}
