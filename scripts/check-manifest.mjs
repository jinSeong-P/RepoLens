import { access, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

const rootDirectory = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(resolve(rootDirectory, 'manifest.json'), 'utf8'))
assert.equal(manifest.manifest_version, 3)
assert.equal(manifest.background.type, 'module')
assert.equal(manifest.default_locale, 'ko')
assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'sidePanel', 'storage'])
assert.deepEqual(manifest.host_permissions.sort(), ['https://api.github.com/*', 'https://github.com/*'])
assert.equal(manifest.externally_connectable, undefined)
assert.equal(manifest.web_accessible_resources, undefined)
assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/)
assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval|unsafe-inline/)
assert.deepEqual(manifest.icons, {
  16: 'assets/icon-16.png',
  32: 'assets/icon-32.png',
  48: 'assets/icon-48.png',
  128: 'assets/icon-128.png',
})
for (const iconPath of Object.values(manifest.icons)) {
  await access(resolve(rootDirectory, iconPath))
}
await access(resolve(rootDirectory, manifest.background.service_worker))
await access(resolve(rootDirectory, manifest.side_panel.default_path))
await access(resolve(rootDirectory, '_locales/ko/messages.json'))
await access(resolve(rootDirectory, '_locales/en/messages.json'))
console.log('manifest: ok')
