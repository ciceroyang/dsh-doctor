import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflightWebPlugin } from '../doctor.mjs'

const BUNDLE = id => 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {'
  + ' var module = { exports: {} }; var exports = module.exports;'
  + ' const React = require("react");'
  + ' function apply(ctx) {}'
  + ' const inject = ["slots"];'
  + ' exports.apply = apply; exports.inject = inject;'
  + ' return module.exports; } });\n'

const status = (checks, name) => checks.find(c => c.name === name).status

function fixture(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-doctor-plugin-'))
  const pkg = { name: spec.name, version: '1.0.0' }
  if (spec.patch) {
    pkg.dsh = { bundle: { patch: './cordis.patch.yml' } }
    writeFileSync(join(dir, 'cordis.patch.yml'), spec.patch)
  }
  if (spec.client) {
    pkg.dsh = Object.assign(pkg.dsh || {}, { client: spec.client })
    if (spec.clientExport !== null) {
      pkg.exports = { './client': spec.clientExport === undefined ? './lib/client.js' : spec.clientExport }
    }
    if (spec.bundleId !== null) {
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib/client.js'), spec.bundle === undefined ? BUNDLE(spec.bundleId === undefined ? spec.name : spec.bundleId) : spec.bundle)
    }
  }
  if (spec.files) {
    pkg.files = spec.files
    for (const f of spec.files) if (f !== 'lib') mkdirSync(join(dir, f.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  return dir
}

const GOOD_PATCH = '- insert:\n    - id: demo\n      name: demo-plugin\n'

test('a self-mounting client plugin passes every check', () => {
  const dir = fixture({ name: 'demo-plugin', patch: GOOD_PATCH, client: { platform: 'web', immediately: true }, files: ['index.js', 'cordis.patch.yml', 'lib'] })
  const checks = preflightWebPlugin(dir)
  assert.deepEqual(checks.map(c => c.status), ['pass', 'pass', 'pass', 'pass', 'pass'])
})

test('a client-only package warns that dsh plugin add will not mount it', () => {
  const dir = fixture({ name: 'demo-plugin', client: { platform: 'web' } })
  assert.equal(status(preflightWebPlugin(dir), 'plugin_host_mount'), 'warn')
})

test('a bundle patch that inserts a different name fails', () => {
  const dir = fixture({ name: 'demo-plugin', patch: '- insert:\n    - id: other\n      name: some-other-package\n' })
  assert.equal(status(preflightWebPlugin(dir), 'plugin_host_mount'), 'fail')
})

test('a declared patch file that does not exist fails', () => {
  const dir = fixture({ name: 'demo-plugin', patch: null })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2))
  assert.equal(status(preflightWebPlugin(dir), 'plugin_host_mount'), 'fail')
})

test('a non-web platform fails before any bundle work', () => {
  const dir = fixture({ name: 'demo-plugin', client: { platform: 'node' } })
  const checks = preflightWebPlugin(dir)
  assert.equal(status(checks, 'plugin_client_export'), 'fail')
  assert.equal(status(checks, 'plugin_client_bundle'), 'skip')
})

test('a missing exports["./client"] fails', () => {
  const dir = fixture({ name: 'demo-plugin', client: { platform: 'web' }, clientExport: null })
  const checks = preflightWebPlugin(dir)
  assert.equal(status(checks, 'plugin_client_export'), 'fail')
  assert.equal(status(checks, 'plugin_client_bundle'), 'skip')
})

test('a bundle that registers the wrong id fails', () => {
  const dir = fixture({ name: 'demo-plugin', client: { platform: 'web' }, bundleId: 'a-different-name' })
  const checks = preflightWebPlugin(dir)
  assert.equal(status(checks, 'plugin_client_export'), 'pass')
  assert.equal(status(checks, 'plugin_client_bundle'), 'fail')
  assert.ok(preflightWebPlugin(dir).find(c => c.name === 'plugin_client_bundle').detail.includes('a-different-name'))
})

test('a bundle that does not export apply fails', () => {
  const dir = fixture({ name: 'demo-plugin', client: { platform: 'web' }, bundle: 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });\n' })
  assert.equal(status(preflightWebPlugin(dir), 'plugin_client_bundle'), 'fail')
})

test('a bundle requiring an undeclared external warns', () => {
  const dir = fixture({
    name: 'demo-plugin',
    client: { platform: 'web' },
    bundle: 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: (require) => { const x = require("@other/ui"); return { apply() {} } } });\n',
  })
  assert.equal(status(preflightWebPlugin(dir), 'plugin_client_bundle'), 'warn')
})

test('the same external declared in dsh.client.external passes', () => {
  const dir = fixture({
    name: 'demo-plugin',
    client: { platform: 'web', external: ['@other/ui'] },
    bundle: 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: (require) => { const x = require("@other/ui"); return { apply() {} } } });\n',
  })
  assert.equal(status(preflightWebPlugin(dir), 'plugin_client_bundle'), 'pass')
})

test('a directory entry in files covers the bundle inside it', () => {
  const dir = fixture({ name: 'demo-plugin', patch: GOOD_PATCH, client: { platform: 'web' }, files: ['index.js', 'cordis.patch.yml', 'lib'] })
  assert.equal(status(preflightWebPlugin(dir), 'plugin_npm_files'), 'pass')
})

test('a files list that omits the patch file warns', () => {
  const dir = fixture({ name: 'demo-plugin', patch: GOOD_PATCH, files: ['index.js'] })
  assert.equal(status(preflightWebPlugin(dir), 'plugin_npm_files'), 'warn')
})

test('a missing manifest fails immediately instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-doctor-plugin-'))
  const checks = preflightWebPlugin(dir)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].status, 'fail')
})
