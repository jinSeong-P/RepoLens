import { access, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))
assert.equal(manifest.manifest_version, 3)
assert.equal(manifest.background.type, 'module')
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
  await access(new URL(`../${iconPath}`, import.meta.url))
}
console.log('manifest: ok')
