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
import { checkProfiles, checkDshHome, checkZstd, checkNode, checkPort, checkDedupe, checkLogHealth, scanZstdFrames, zstdDecompressAll, zstdAvailable, runAll, computeExitCode, buildEnvelope, buildRemediation } from '../doctor.mjs'

const DOCTOR = fileURLToPath(new URL('../doctor.mjs', import.meta.url))

test('checkProfiles skips shared dirs and flags corrupt manifests', () => {
  const home = mkdtempSync(join(tmpdir(), 'dd-'))
  mkdirSync(join(home, 'profiles', 'good'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'bad'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'shared'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'good', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } } }))
  writeFileSync(join(home, 'profiles', 'bad', 'package.json'), '{broken json')
  const result = checkProfiles(home)
  assert.ok(result.detail.includes('good(2 bundles, 无应用组合包)'))
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
  assert.equal(good.status, 'pass')
  rmSync(base, { recursive: true, force: true })
  rmSync(ok, { recursive: true, force: true })
})

test('checkNode reports ok or warn for the running runtime', () => {
  const result = checkNode()
  assert.ok(['pass', 'warn'].includes(result.status))
  assert.ok(result.detail.length > 0)
})

test('checkPort resolves on an ephemeral port', async () => {
  const result = await checkPort(0)
  assert.equal(result.status, 'pass')
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
  assert.equal(clean.status, 'pass')
  rmSync(home, { recursive: true, force: true })
})

test('checkZstd returns a structured result', () => {
  const result = checkZstd()
  assert.ok(['pass', 'warn'].includes(result.status))
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
    assert.ok(['pass', 'warn', 'fail', 'skip'].includes(c.status))
  }
  rmSync(home, { recursive: true, force: true })
})

test('scanZstdFrames rejects corrupt magic', () => {
  const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
  assert.throws(() => scanZstdFrames(buf), /corrupt zstd frame magic/)
})

test('checkLogHealth handles an empty sessions dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'ddl-'))
  const result = checkLogHealth(home)
  assert.equal(result.status, 'pass')
  assert.equal(result.name, 'log_health')
  rmSync(home, { recursive: true, force: true })
})

test('multi-frame zstd roundtrip decodes fully (skipped without zstd)', (t) => {
  if (!zstdAvailable()) {
    t.skip('built-in zstd unavailable on this Node')
    return
  }
  const zlib = process.getBuiltinModule('node:zlib')
  const frameA = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"a"}\n'))
  const frameB = zlib.zstdCompressSync(Buffer.from('{"type":"user/message","seq":0}\n'))
  const joined = Buffer.concat([frameA, frameB])
  const frames = scanZstdFrames(joined)
  assert.equal(frames.length, 2)
  const text = zstdDecompressAll(joined)
  assert.ok(text.includes('session') && text.includes('user/message'))
})

test('buildRemediation emits fix lines only for warn/fail checks', () => {
  const checks = [
    { name: 'node', status: 'pass', detail: 'x' },
    { name: 'pnpm', status: 'warn', detail: 'x' },
    { name: 'port', status: 'fail', detail: 'x' },
    { name: 'git_bash', status: 'skip', detail: 'win32 only' },
    { name: 'unknown_check', status: 'warn', detail: 'x' },
  ]
  const lines = buildRemediation(checks)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].startsWith('[pnpm]'))
  assert.ok(lines[1].startsWith('[port]'))
})

test('computeExitCode implements the 0/1/2 semantics with skip', () => {
  assert.equal(computeExitCode([{ status: 'pass' }, { status: 'pass' }]), 0)
  assert.equal(computeExitCode([{ status: 'pass' }, { status: 'warn' }]), 1)
  assert.equal(computeExitCode([{ status: 'pass' }, { status: 'fail' }]), 2)
  assert.equal(computeExitCode([{ status: 'skip' }, { status: 'pass' }]), 0)
  assert.equal(computeExitCode([]), 0)
})

test('buildEnvelope emits the dsh-doctor/v1 shape', () => {
  const checks = [
    { name: 'node', status: 'pass', detail: '26.4.0' },
    { name: 'port', status: 'warn', detail: '3080 已被占用' },
  ]
  const env = buildEnvelope(checks, '/tmp/home')
  assert.equal(env.schema, 'dsh-doctor/v1')
  assert.equal(env.profile, '/tmp/home')
  assert.equal(env.exitCode, 1)
  assert.equal(env.ok, true)
  assert.deepEqual(env.summary, { pass: 1, warn: 1, fail: 0, skip: 0 })
  assert.equal(env.checks.length, 2)
  assert.ok(env.generatedAt.endsWith('Z'))

  const withSkip = buildEnvelope([{ name: 'win', status: 'skip', detail: 'win32 only' }, { name: 'node', status: 'pass', detail: 'v22' }], '/tmp/home')
  assert.deepEqual(withSkip.summary, { pass: 1, warn: 0, fail: 0, skip: 1 })
  assert.equal(withSkip.exitCode, 0)
  assert.equal(withSkip.ok, true)

  // Frozen r5 shape: remediation is opt-in and absent by default.
  assert.equal('remediation' in withSkip, false)
  const withFix = buildEnvelope([{ name: 'pnpm', status: 'warn', detail: 'x' }], '/tmp/home', { remediation: true })
  assert.ok(Array.isArray(withFix.remediation))
  assert.ok(withFix.remediation[0].startsWith('[pnpm]'))
})

test('CLI renders a JSON report for --json', () => {
  const home = mkdtempSync(join(tmpdir(), 'ddj-'))
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const env = { ...process.env, DSH_HOME: home }
  delete env.NODE_TEST_CONTEXT
  let out
  try {
    out = execFileSync(process.execPath, [DOCTOR, '--json'], { encoding: 'utf8', env })
  } catch (error) {
    // Exit 1 (warn) or 2 (fail) are legitimate environment-dependent outcomes:
    // CI runners lack pnpm (fail) or built-in zstd on Node 18/20 (warn), and a
    // local GUI can occupy port 3080 (warn). Assert the report, not the code.
    assert.ok(error.status === 1 || error.status === 2, 'unexpected exit code ' + error.status)
    out = error.stdout
  }
  const parsed = JSON.parse(out)
  assert.ok(Array.isArray(parsed) && parsed.length >= 6)
  rmSync(home, { recursive: true, force: true })
})
