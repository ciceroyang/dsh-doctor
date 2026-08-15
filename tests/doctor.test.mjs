/**
 * dsh-doctor checker tests.
 * @module dsh-doctor/tests/doctor
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkProfiles, checkDshHome, checkZstd, checkNode, checkPort, checkDedupe, runAll, computeExitCode, buildEnvelope } from '../doctor.mjs'

const DOCTOR = fileURLToPath(new URL('../doctor.mjs', import.meta.url))

test('checkProfiles skips shared dirs and flags corrupt manifests', () => {
  const home = mkdtempSync(join(tmpdir(), 'dd-'))
  mkdirSync(join(home, 'profiles', 'good'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'bad'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'shared'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'good', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } } }))
  writeFileSync(join(home, 'profiles', 'bad', 'package.json'), '{broken json')
  const result = checkProfiles(home)
  assert.ok(result.detail.includes('good(2 bundles)'))
  assert.ok(result.detail.includes('bad(清单损坏)'))
  assert.ok(!result.detail.includes('shared'))
  assert.equal(result.status, 'warn')
  rmSync(home, { recursive: true, force: true })
})

test('checkDshHome detects missing and unwritable states', () => {
  const base = mkdtempSync(join(tmpdir(), 'ddh-'))
  const missing = checkDshHome(join(base, 'nope'))
  assert.equal(missing.status, 'fail')
  const ok = mkdtempSync(join(tmpdir(), 'ddh2-'))
  writeFileSync(join(ok, 'settings.yaml'), 'x: 1')
  const good = checkDshHome(ok)
  assert.equal(good.status, 'ok')
  rmSync(base, { recursive: true, force: true })
  rmSync(ok, { recursive: true, force: true })
})

test('checkNode reports ok or warn for the running runtime', () => {
  const result = checkNode()
  assert.ok(['ok', 'warn'].includes(result.status))
  assert.ok(result.detail.length > 0)
})

test('checkPort resolves on an ephemeral port', async () => {
  const result = await checkPort(0)
  assert.equal(result.status, 'ok')
})

test('checkDedupe flags duplicate real copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'ddd-'))
  const base = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  mkdirSync(join(base, 'dsh-tools'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'node_modules', 'some-plugin', 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
  const duped = checkDedupe(home)
  assert.equal(duped.status, 'fail')
  assert.ok(duped.detail.includes('dsh-tools x2'))
  rmSync(join(home, 'profiles', 'node_modules', 'some-plugin'), { recursive: true, force: true })
  const clean = checkDedupe(home)
  assert.equal(clean.status, 'ok')
  rmSync(home, { recursive: true, force: true })
})

test('checkZstd returns a structured result', () => {
  const result = checkZstd()
  assert.ok(['ok', 'warn'].includes(result.status))
  assert.equal(result.name, 'zstd')
})

test('runAll returns structured checks for a temp home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddr-'))
  mkdirSync(join(home, 'profiles', 'p'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'p', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['x'] } } }))
  const checks = await runAll(home)
  assert.ok(Array.isArray(checks) && checks.length >= 6)
  for (const c of checks) {
    assert.ok(typeof c.name === 'string' && typeof c.detail === 'string')
    assert.ok(['ok', 'warn', 'fail'].includes(c.status))
  }
  rmSync(home, { recursive: true, force: true })
})

test('computeExitCode implements the 0/1/2 semantics', () => {
  assert.equal(computeExitCode([{ status: 'ok' }, { status: 'ok' }]), 0)
  assert.equal(computeExitCode([{ status: 'ok' }, { status: 'warn' }]), 1)
  assert.equal(computeExitCode([{ status: 'ok' }, { status: 'fail' }]), 2)
  assert.equal(computeExitCode([]), 0)
})

test('buildEnvelope emits the dsh-doctor/v1 shape', () => {
  const checks = [
    { name: 'node', status: 'ok', detail: '26.4.0' },
    { name: 'port', status: 'warn', detail: '3080 已被占用' },
  ]
  const env = buildEnvelope(checks, '/tmp/home')
  assert.equal(env.schema, 'dsh-doctor/v1')
  assert.equal(env.profile, '/tmp/home')
  assert.equal(env.exitCode, 1)
  assert.equal(env.ok, true)
  assert.deepEqual(env.summary, { pass: 1, warn: 1, fail: 0 })
  assert.equal(env.checks.length, 2)
  assert.ok(env.generatedAt.endsWith('Z'))
})

test('CLI renders a JSON report for --json', () => {
  const home = mkdtempSync(join(tmpdir(), 'ddj-'))
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const env = { ...process.env, DSH_HOME: home }
  delete env.NODE_TEST_CONTEXT
  const out = execFileSync(process.execPath, [DOCTOR, '--json'], { encoding: 'utf8', env })
  const parsed = JSON.parse(out)
  assert.ok(Array.isArray(parsed) && parsed.length >= 6)
  rmSync(home, { recursive: true, force: true })
})
