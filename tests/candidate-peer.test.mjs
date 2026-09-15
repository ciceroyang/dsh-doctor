/**
 * Unit tests for the candidate pre-flight checks (v1.2 draft, #1719).
 * @module dsh-doctor/tests/candidate-peer
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePatchInserts, candidatePeerChecks } from '../doctor.mjs'

test('parsePatchInserts reads the loader-entry shape and skips disabled entries', () => {
  const text = [
    '- insert:',
    '    - id: alpha',
    '      name: acme-plugin',
    '    - id: beta',
    '      name: builtin:thing',
    '      disabled: true',
    '  - id: gamma',
    '    name: "quoted-pkg"',
  ].join('\n')
  const inserts = parsePatchInserts(text)
  assert.deepEqual(inserts.map((entry) => entry.id), ['alpha', 'gamma'])
  assert.equal(inserts[0].name, 'acme-plugin')
  assert.equal(inserts[1].name, 'quoted-pkg')
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cand-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules', 'bundle-a'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', 'acme-plugin'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['bundle-a'] } } }))
  writeFileSync(join(profile, 'node_modules', 'bundle-a', 'cordis.patch.yml'), '- insert:\n    - id: existing\n      name: bundle-a\n')
  writeFileSync(join(profile, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.2' }))
  writeFileSync(join(profile, 'node_modules', 'acme-plugin', 'package.json'), JSON.stringify({ name: 'acme-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/cordis': '>=4.0.0 <5' } }))
  return profile
}

const patch = (lines) => lines.join('\n')

test('candidatePeerChecks passes a clean insert', () => {
  const profile = fixture()
  const checks = candidatePeerChecks(profile, patch(['- insert:', '    - id: acme', '      name: acme-plugin']))
  assert.deepEqual(checks.map((c) => c.name), ['candidate-insert-collision', 'candidate-module-installed', 'candidate-peer-range'])
  assert.ok(checks.every((c) => c.status === 'pass'), JSON.stringify(checks))
  rmSync(join(profile, '..', '..'), { recursive: true, force: true })
})

test('candidatePeerChecks warns on an id that already exists', () => {
  const profile = fixture()
  const checks = candidatePeerChecks(profile, patch(['- insert:', '    - id: existing', '      name: acme-plugin']))
  const collision = checks.find((c) => c.name === 'candidate-insert-collision')
  assert.equal(collision.status, 'warn')
  assert.match(collision.detail, /existing/)
  rmSync(join(profile, '..', '..'), { recursive: true, force: true })
})

test('candidatePeerChecks fails when an inserted module is absent from the tree', () => {
  const profile = fixture()
  const checks = candidatePeerChecks(profile, patch(['- insert:', '    - id: nope', '      name: not-installed-pkg']))
  const missing = checks.find((c) => c.name === 'candidate-module-installed')
  assert.equal(missing.status, 'fail')
  assert.match(missing.detail, /not-installed-pkg/)
  rmSync(join(profile, '..', '..'), { recursive: true, force: true })
})

test('candidatePeerChecks fails when an inserted plugin excludes the installed host', () => {
  const profile = fixture()
  writeFileSync(join(profile, 'node_modules', 'acme-plugin', 'package.json'), JSON.stringify({ name: 'acme-plugin', peerDependencies: { '@deepseek-ai/cordis': '>=5.0.0' } }))
  const checks = candidatePeerChecks(profile, patch(['- insert:', '    - id: acme', '      name: acme-plugin']))
  const peers = checks.find((c) => c.name === 'candidate-peer-range')
  assert.equal(peers.status, 'fail')
  assert.match(peers.detail, />=5\.0\.0/)
  rmSync(join(profile, '..', '..'), { recursive: true, force: true })
})

test('candidatePeerChecks ignores builtins and relative paths for presence', () => {
  const profile = fixture()
  const checks = candidatePeerChecks(profile, patch(['- insert:', '    - id: b', '      name: cordis:internal', '    - id: r', '      name: ./local.mjs']))
  const installed = checks.find((c) => c.name === 'candidate-module-installed')
  assert.equal(installed.status, 'pass')
  assert.match(installed.detail, /仅内置|内置\/相对/)
  rmSync(join(profile, '..', '..'), { recursive: true, force: true })
})