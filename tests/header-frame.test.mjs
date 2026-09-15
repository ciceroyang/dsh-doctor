import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLogHealth, headerFrameIssue, zstdAvailable } from '../doctor.mjs'

function zstd() { return process.getBuiltinModule('node:zlib') }

function writeLog(home, sessionId, plaintexts) {
  const dir = join(home, 'sessions', 'proj', sessionId)
  mkdirSync(dir, { recursive: true })
  const frames = plaintexts.map((text) => zstd().zstdCompressSync(Buffer.from(text)))
  writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(frames))
}

const HEADER = '{"type":"session","id":"a"}\n'
const EVENT = '{"type":"user/message","seq":0}\n'

test('headerFrameIssue accepts a header-first multi-frame log', (t) => {
  if (!zstdAvailable()) { t.skip('no built-in zstd'); return }
  const bytes = Buffer.concat([zstd().zstdCompressSync(Buffer.from(HEADER)), zstd().zstdCompressSync(Buffer.from(EVENT))])
  assert.equal(headerFrameIssue(bytes), null)
})

test('headerFrameIssue flags a first frame that wraps the header plus events', (t) => {
  if (!zstdAvailable()) { t.skip('no built-in zstd'); return }
  const bytes = zstd().zstdCompressSync(Buffer.from(HEADER + EVENT))
  assert.match(headerFrameIssue(bytes), /首帧不是恰好一行/)
})

test('headerFrameIssue flags an event-first frame', (t) => {
  if (!zstdAvailable()) { t.skip('no built-in zstd'); return }
  const bytes = Buffer.concat([zstd().zstdCompressSync(Buffer.from(EVENT)), zstd().zstdCompressSync(Buffer.from(HEADER))])
  assert.match(headerFrameIssue(bytes), /不是 session header/)
})

test('checkLogHealth fails on a corrupt-header log and passes a healthy one (#6651)', (t) => {
  if (!zstdAvailable()) { t.skip('no built-in zstd'); return }
  const bad = mkdtempSync(join(tmpdir(), 'ddhdr-'))
  writeLog(bad, 'bad', [EVENT, HEADER + EVENT])
  const badResult = checkLogHealth(bad)
  assert.equal(badResult.name, 'log_health')
  assert.equal(badResult.status, 'fail')
  assert.match(badResult.detail, /首帧异常/)
  const ok = mkdtempSync(join(tmpdir(), 'ddok-'))
  writeLog(ok, 'good', [HEADER, EVENT])
  assert.equal(checkLogHealth(ok).status, 'pass')
  rmSync(bad, { recursive: true, force: true })
  rmSync(ok, { recursive: true, force: true })
})