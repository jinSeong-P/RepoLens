import { access, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

const rootDirectory = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(import.meta.dirname, '..')
const target = process.argv[3] ?? 'chrome'
if (!['chrome', 'firefox'].includes(target)) throw new Error(`Unsupported manifest target: ${target}`)
const manifest = JSON.parse(await readFile(resolve(rootDirectory, 'manifest.json'), 'utf8'))
assert.equal(manifest.manifest_version, 3)
assert.equal(manifest.background.type, 'module')
assert.equal(manifest.default_locale, 'ko')
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
if (target === 'chrome') {
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'sidePanel', 'storage'])
  assert.equal(manifest.browser_specific_settings, undefined)
  assert.equal(manifest.sidebar_action, undefined)
  assert.equal(manifest.background.scripts, undefined)
  await access(resolve(rootDirectory, manifest.background.service_worker))
  await access(resolve(rootDirectory, manifest.side_panel.default_path))
} else {
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'storage'])
  assert.equal(manifest.minimum_chrome_version, undefined)
  assert.equal(manifest.side_panel, undefined)
  assert.equal(manifest.background.service_worker, undefined)
  assert.deepEqual(manifest.background.scripts, ['src/background.js'])
  assert.deepEqual(manifest.browser_specific_settings, {
    gecko: {
      id: 'repolens@jinseong-p.github.io',
      strict_min_version: '140.0',
      data_collection_permissions: {
        required: ['authenticationInfo', 'websiteContent'],
      },
    },
  })
  assert.equal(manifest.sidebar_action.default_panel, 'sidepanel.html')
  assert.equal(manifest.sidebar_action.open_at_install, false)
  await access(resolve(rootDirectory, manifest.background.scripts[0]))
  await access(resolve(rootDirectory, manifest.sidebar_action.default_panel))
}
await access(resolve(rootDirectory, '_locales/ko/messages.json'))
await access(resolve(rootDirectory, '_locales/en/messages.json'))
console.log(`${target} manifest: ok`)
