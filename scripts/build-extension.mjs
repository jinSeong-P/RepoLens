import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] ?? 'chrome'
if (!['chrome', 'firefox'].includes(target)) {
  throw new Error(`Unsupported extension build target: ${target}`)
}
const outputDirectory = join(
  rootDirectory,
  'build',
  target === 'firefox' ? 'firefox-extension' : 'extension',
)
const manifestSource = target === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(join(outputDirectory, 'src'), { recursive: true })

await run(process.execPath, [
  join(rootDirectory, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p',
  join(rootDirectory, 'tsconfig.build.json'),
  '--outDir',
  join(outputDirectory, 'src'),
])

const staticFiles = [
  'sidepanel.html',
  'src/sidepanel.css',
  'src/vendor/MERMAID_LICENSE.txt',
  'src/vendor/mermaid-11.16.1.min.js',
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
]

await cp(join(rootDirectory, manifestSource), join(outputDirectory, 'manifest.json'))

for (const relativePath of staticFiles) {
  const destination = join(outputDirectory, ...relativePath.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(rootDirectory, ...relativePath.split('/')), destination)
}

// Both browser manifests read strings from _locales, while the UI consumes the
// compiled catalog module. Generate both from the same typed catalog source.
const localeGeneratorPath = join(outputDirectory, 'src/i18n/chrome-locales.js')
const localeModule = await import(`${pathToFileURL(localeGeneratorPath).href}?${Date.now()}`)
if (typeof localeModule.CHROME_LOCALES_JSON !== 'string') {
  throw new Error('Compiled Chrome locale generator did not export locale JSON.')
}
const locales = JSON.parse(localeModule.CHROME_LOCALES_JSON)
const manifest = JSON.parse(await readFile(join(outputDirectory, 'manifest.json'), 'utf8'))
if (!isLocaleCatalog(locales) || !(manifest.default_locale in locales)) {
  throw new Error('Compiled Chrome locale catalog is invalid or missing the default locale.')
}
await rm(localeGeneratorPath)
for (const [locale, messages] of Object.entries(locales).sort(([left], [right]) => left.localeCompare(right))) {
  const localeDirectory = join(outputDirectory, '_locales', locale)
  await mkdir(localeDirectory, { recursive: true })
  await writeFile(join(localeDirectory, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`, 'utf8')
}

console.log(`Built ${target} extension at ${outputDirectory}`)

function run(command, arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { cwd: rootDirectory, stdio: 'inherit' })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${command} exited with code ${code}`))
    })
  })
}

function isLocaleCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([locale, messages]) => /^[A-Za-z0-9_]+$/.test(locale)
    && messages && typeof messages === 'object' && !Array.isArray(messages))
}
