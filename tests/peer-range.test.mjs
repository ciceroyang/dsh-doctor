import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { satisfiesRange, compareSemver, parseSemver, checkPluginPeerRange } from '../doctor.mjs'

test('semver: ordering and prerelease rules', () => {
  assert.equal(compareSemver(parseSemver('4.0.2'), parseSemver('4.0.1')), 1)
  assert.equal(compareSemver(parseSemver('1.0.0-rc.2'), parseSemver('1.0.0-rc.10')), -1)
  assert.equal(compareSemver(parseSemver('1.0.0-rc.1'), parseSemver('1.0.0')), -1)
  assert.equal(compareSemver(parseSemver('1.0.0'), parseSemver('1.0.0')), 0)
})

test('semver: ranges used by real plugins', () => {
  assert.equal(satisfiesRange('4.0.2', '>=4'), true)
  assert.equal(satisfiesRange('4.0.2', '>=4.0.0 <5'), true)
  assert.equal(satisfiesRange('5.1.0', '>=4.0.0 <5'), false)
  assert.equal(satisfiesRange('0.1.0-rc.6', '>=0.1.0-rc.5 <0.2.0'), true)
  assert.equal(satisfiesRange('0.1.0-rc.4', '>=0.1.0-rc.5 <0.2.0'), false)
  assert.equal(satisfiesRange('1.4.9', '^1.2.3'), true)
  assert.equal(satisfiesRange('2.0.0', '^1.2.3'), false)
  assert.equal(satisfiesRange('1.2.9', '~1.2.3'), true)
  assert.equal(satisfiesRange('1.3.0', '~1.2.3'), false)
  assert.equal(satisfiesRange('1.5.0', '1'), true)
  assert.equal(satisfiesRange('2.0.0', '1'), false)
  assert.equal(satisfiesRange('0.9.0', '>=1 || >=0.8 <1'), true)
})

test('semver: unparseable and prerelease-ambiguous ranges are null, never false', () => {
  assert.equal(satisfiesRange('1.0.0', 'not a range'), null)
  assert.equal(satisfiesRange('1.0.0', '~x.y'), null)
  // a satisfiable branch wins over an unparseable alternative; only when nothing
  // matches do we fall back to undecidable
  assert.equal(satisfiesRange('1.0.0', '>=1.0.0 <2.0.0 || ~x.y'), true)
  assert.equal(satisfiesRange('3.0.0', '>=1.0.0 <2.0.0 || ~x.y'), null)
  // A prerelease-aware group (one that mentions any prerelease) is evaluated
  // numerically: the common shape accepts a later prerelease...
  assert.equal(satisfiesRange('0.1.5-rc.2', '>=0.1.0-rc.5 <0.2.0'), true)
  // ...and a narrowly pinned one genuinely rejects it (the real dsh-win32 case,
  // whose @deepseek-ai/dsh-subprocess-local range stops at <0.1.0-rc.7 while the
  // current CLI ships 0.1.5-rc.2).
  assert.equal(satisfiesRange('0.1.5-rc.2', '>=0.1.0-rc.5 <0.1.0-rc.7'), false)
  // A release-only group against a prerelease install stays undecidable: strict
  // semver excludes it, but that is not a hard incompatibility.
  assert.equal(satisfiesRange('4.1.0-rc.1', '>=4.0.0'), null)
})

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'ddpeer-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules', 'acme-plugin'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'acme-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['acme-plugin'] } },
  }))
  writeFileSync(join(profile, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.2' }))
  return { home, profile }
}

function writePlugin(profile, peers) {
  writeFileSync(join(profile, 'node_modules', 'acme-plugin', 'package.json'), JSON.stringify({
    name: 'acme-plugin',
    version: '1.0.0',
    peerDependencies: peers,
  }))
}

test('checkPluginPeerRange: compatible declaration passes and is counted', () => {
  const { home, profile } = fixtureHome()
  writePlugin(profile, { '@deepseek-ai/cordis': '>=4.0.0 <5' })
  const result = checkPluginPeerRange(home)
  assert.equal(result.name, 'ciceroyang/peer_range')
  assert.equal(result.status, 'pass')
  assert.match(result.detail, /兼容 1 \/ 未知 0/)
  rmSync(home, { recursive: true, force: true })
})

test('checkPluginPeerRange: an out-of-range host fails with the versions named', () => {
  const { home, profile } = fixtureHome()
  writePlugin(profile, { '@deepseek-ai/cordis': '>=5.0.0' })
  const result = checkPluginPeerRange(home)
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /不兼容 1/)
  assert.match(result.detail, /acme-plugin 需要 @deepseek-ai\/cordis >=5.0.0,已装 4.0.2/)
  rmSync(home, { recursive: true, force: true })
})

test('checkPluginPeerRange: a wildcard is unknown, not compatible; --strict-peer warns', () => {
  const { home, profile } = fixtureHome()
  writePlugin(profile, { '@deepseek-ai/cordis': '*' })
  assert.equal(checkPluginPeerRange(home).status, 'pass')
  assert.match(checkPluginPeerRange(home).detail, /兼容 0 \/ 未知 1/)
  assert.equal(checkPluginPeerRange(home, { strictPeer: true }).status, 'warn')
  rmSync(home, { recursive: true, force: true })
})

test('checkPluginPeerRange: an unresolvable host is unknown', () => {
  const { home, profile } = fixtureHome()
  writePlugin(profile, { '@deepseek-ai/dsh-tools': '>=0.1.0' })
  const result = checkPluginPeerRange(home)
  assert.equal(result.status, 'pass')
  assert.match(result.detail, /未知 1/)
  rmSync(home, { recursive: true, force: true })
})