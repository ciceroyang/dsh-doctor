#!/usr/bin/env node
/**
 * dsh-doctor — 一键体检 DeepSeek Harness 本地环境。
 *
 * 零依赖 ESM CLI。检查:Node/pnpm/dsh 版本与 PATH、端口 3080 占用、DSH_HOME
 * 与 settings 可写性、profile 清单完整性、会话日志健康(多帧 zstd 解码)。
 * 每个检查返回 ok/warn/fail + 可执行建议;支持 --json 输出。
 *
 * 用法:
 *   node doctor.mjs
 *   node doctor.mjs --json
 *
 * @module dsh-doctor
 */

import { existsSync, readdirSync, readFileSync, accessSync, constants, realpathSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const DEFAULT_PORT = 3080

function failRun(checks) {
  return checks.filter((c) => c.status === 'fail').length > 0
}

function line(emoji, name, status, detail) {
  return emoji + ' ' + name + (detail ? ': ' + detail : '')
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function parseVersion(text, prefix) {
  if (!text) return null
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? m[0] : null
}

export function checkNode() {
  const version = parseVersion(run(process.execPath, ['--version']))
  if (!version) return { name: 'node', status: 'fail', detail: '无法执行 node' }
  const [major, minor] = version.split('.').map(Number)
  const inRange = (major === 22 && minor >= 19) || major >= 24
  if (!inRange) {
    return { name: 'node', status: 'warn', detail: version + ' (官方仓库声明 engines: ^22.19.0 || >=24.0.0;低于该范围,同 npm EBADENGINE 语义)' }
  }
  return { name: 'node', status: 'pass', detail: version + ' (在官方 engines 范围内)' }
}

export function checkPnpm() {
  const text = run('pnpm', ['--version'])
  if (!text) {
    return { name: 'pnpm', status: 'warn', detail: '未安装或不在 PATH(corepack 可免下载启用: corepack enable pnpm;或 npm i -g pnpm)' }
  }
  return { name: 'pnpm', status: 'pass', detail: text }
}

export function checkDsh() {
  const text = run('dsh', ['--version'])
  if (!text) return { name: 'dsh', status: 'warn', detail: 'PATH 中未找到;可 npx @deepseek-ai/dsh 运行' }
  return { name: 'dsh', status: 'pass', detail: text }
}

export function checkPort(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const server = createServer()
      server.once('error', () => resolve({ name: 'port', status: 'warn', detail: port + ' 已被占用(web GUI 可能已在运行)' }))
      server.once('listening', () => server.close(() => resolve({ name: 'port', status: 'pass', detail: port + ' 空闲' })))
      server.listen(port, '127.0.0.1')
    })
  })
}

export function checkDshHome(home) {
  if (!existsSync(home)) return { name: 'ds_home', status: 'fail', detail: home + ' 不存在' }
  const settings = join(home, 'settings.yaml')
  if (!existsSync(settings)) return { name: 'ds_home', status: 'warn', detail: home + ' 存在,但 settings.yaml 缺失' }
  try {
    accessSync(settings, constants.W_OK)
    return { name: 'ds_home', status: 'pass', detail: settings + ' 可写' }
  } catch {
    return { name: 'ds_home', status: 'fail', detail: settings + ' 不可写(常见:曾用 sudo 运行;chown 修复)' }
  }
}

export function checkProfiles(home) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return { name: 'profiles', status: 'fail', detail: dir + ' 不存在' }
  const entries = readdirSync(dir).filter((e) => !e.startsWith('.'))
  const rows = []
  let bad = 0
  let appLess = 0
  for (const name of entries) {
    const pkgFile = join(dir, name, 'package.json')
    if (!existsSync(pkgFile)) continue // shared dirs like node_modules are not profiles
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const bundles = pkg?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) throw new Error('no bundles')
      const appBundle = bundles.some((b) => /(web-app|headless|tui|app)/.test(b))
      rows.push(name + '(' + bundles.length + ' bundles' + (appBundle ? '' : ', 无应用组合包') + ')')
      if (!appBundle) appLess += 1
    } catch {
      bad += 1
      rows.push(name + '(清单损坏)')
    }
  }
  const status = bad > 0 || appLess > 0 ? 'warn' : 'pass'
  return {
    name: 'profiles',
    status,
    detail: (rows.length > 0 ? rows.join(' ') : '无 profile') +
      (bad > 0 ? ' [损坏 ' + bad + ']' : '') +
      (appLess > 0 ? ' [无应用组合包的 profile 直接启动会挂起,#2321]' : ''),
  }
}

const ZSTD_MAGIC = 0xFD2FB528

/**
 * Structurally scan a concatenated zstd container (port of the official
 * dsh-session-persistence-jsonl frame scan). DSH session logs are multi-frame.
 * @param {Buffer} buffer - compressed bytes.
 * @returns {Array<{start: number, end: number}>} complete frames in order.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt zstd frame magic at byte ' + offset)
    }
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved zstd block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Reproduce the enforced condition from dsh-session-persistence-jsonl: the first
 * zstd frame's plaintext must be exactly one line (its only newline is the last
 * byte) and that line must be the session header. A violation is the failure mode
 * reported in discussion #6651: the log decodes fine, but `dsh web` refuses to
 * start and session listings come back empty.
 * @param {Buffer} bytes - the whole session log.
 * @returns {string|null} human-readable issue, or null when the header frame is valid.
 */
export function headerFrameIssue(bytes) {
  if (!zstdAvailable()) return null
  const frames = scanZstdFrames(bytes)
  if (frames.length === 0) return '没有完整帧'
  const zlib = process.getBuiltinModule('node:zlib')
  let first
  try {
    first = zlib.zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8')
  } catch {
    return '首帧无法解码'
  }
  if (first.length === 0) return '首帧为空'
  if (first.indexOf('\n') !== first.length - 1) return '首帧不是恰好一行(#6651 会让 dsh web 启动/会话列表整体失败)'
  let parsed
  try {
    parsed = JSON.parse(first.slice(0, -1))
  } catch {
    return '首行不是 JSON'
  }
  if (!parsed || parsed.type !== 'session') return '首行不是 session header(type=' + String(parsed && parsed.type) + ')'
  return null
}

/**
 * Fully decompress a multi-frame zstd buffer (one-shot decompression stops at
 * the first frame).
 * @param {Buffer} bytes - compressed bytes.
 * @returns {string|null} full plaintext, or null when zstd is unavailable.
 */
export function zstdDecompressAll(bytes) {
  if (!zstdAvailable()) return null
  const zlib = process.getBuiltinModule('node:zlib')
  const parts = []
  for (const frame of scanZstdFrames(bytes)) {
    parts.push(zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8'))
  }
  return parts.join('')
}

const HEAD_BYTES = 4 * 1024 * 1024

function readHead(path, bytes = HEAD_BYTES) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

function relativeTo(home, path) {
  return path.startsWith(home) ? path.slice(home.length + 1) : path
}

/**
 * Sample the newest session logs and verify multi-frame zstd health. The
 * differentiating check: a broken or torn frame usually hides here while the
 * rest of the environment looks fine.
 * @param {string} home - DSH home.
 * @returns {{name: string, status: string, detail: string}} check result.
 */
export function checkLogHealth(home, opts = {}) {
  const allLogs = opts.allLogs === true
  const dir = join(home, 'sessions')
  if (!existsSync(dir)) return { name: 'log_health', status: 'pass', detail: '无会话目录' }
  const logs = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name === 'session.jsonl.zstd') {
        try {
          logs.push({ path: full, mtime: statSyncFile(full) })
        } catch {
          // unreadable candidate
        }
      }
    }
  }
  walk(dir)
  logs.sort((a, b) => b.mtime - a.mtime)
  if (logs.length === 0) return { name: 'log_health', status: 'pass', detail: '0 个日志' }
  if (!zstdAvailable()) return { name: 'log_health', status: 'warn', detail: logs.length + ' 个日志,但当前 Node 无内置 zstd,无法解码' }
  const selected = allLogs ? logs : logs.slice(0, 3)
  const results = []
  const offenders = []
  let bad = 0
  let headerIssues = 0
  let undetermined = 0
  for (const entry of selected) {
    try {
      // A full scan reads only the head of each log: the first frame is what the
      // startup check cares about, and session logs can be large.
      const bytes = allLogs ? readHead(entry.path) : readFileSync(entry.path)
      const frames = scanZstdFrames(bytes)
      if (frames.length === 0) {
        undetermined += 1
        continue
      }
      const issue = headerFrameIssue(bytes)
      if (issue) {
        headerIssues += 1
        offenders.push(relativeTo(home, entry.path) + ' [' + issue + ']')
        if (!allLogs) {
          const text = zstdDecompressAll(bytes)
          const lines = text.split('\n').filter((l) => l.trim() !== '').length
          results.push(frames.length + '帧/' + lines + '行 [首帧异常:' + issue + ']')
        }
      } else if (!allLogs) {
        const text = zstdDecompressAll(bytes)
        const lines = text.split('\n').filter((l) => l.trim() !== '').length
        results.push(frames.length + '帧/' + lines + '行')
      }
    } catch {
      bad += 1
      offenders.push(relativeTo(home, entry.path) + ' [解码失败]')
      if (!allLogs) results.push('解码失败')
    }
  }
  if (allLogs) {
    const summary = '全量扫描 ' + selected.length + '/' + logs.length + ' 个日志:首帧异常 ' + headerIssues + ' / 解码失败 ' + bad + (undetermined > 0 ? ' / 未判定 ' + undetermined : '')
    if (headerIssues === 0 && bad === 0) return { name: 'log_health', status: 'pass', detail: summary }
    const shown = offenders.slice(0, 5).join('; ')
    return { name: 'log_health', status: 'fail', detail: summary + ' — ' + shown + (offenders.length > 5 ? ' 等 ' + offenders.length + ' 个' : '') }
  }
  if (bad > 0) {
    return { name: 'log_health', status: 'fail', detail: '抽查 ' + selected.length + ' 个日志:' + results.join(' ') + ' [' + bad + ' 个损坏]' }
  }
  if (headerIssues > 0) {
    return { name: 'log_health', status: 'fail', detail: '抽查 ' + selected.length + ' 个日志:' + results.join(' ') + ' [' + headerIssues + ' 个首帧异常,用 --all-logs 扫描全部]' }
  }
  return { name: 'log_health', status: 'pass', detail: '抽查 ' + selected.length + ' 个日志:' + results.join(' ') }
}

function statSyncFile(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export function checkSessions(home) {
  const dir = join(home, 'sessions')
  if (!existsSync(dir)) return { name: 'sessions', status: 'warn', detail: dir + ' 不存在(还没有会话)' }
  let files = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name === 'session.jsonl.zstd') files += 1
    }
  }
  try {
    walk(dir)
  } catch {
    return { name: 'sessions', status: 'fail', detail: '会话目录不可读' }
  }
  if (files === 0) return { name: 'sessions', status: 'pass', detail: '0 个日志' }
  return { name: 'sessions', status: 'pass', detail: files + ' 个日志(读取需要 Node ≥ 22.15 内置 zstd)' }
}

export function checkDedupe(home) {
  const root = join(home, 'profiles', 'node_modules')
  if (!existsSync(root)) return { name: 'dedupe', status: 'pass', detail: '无插件依赖目录' }
  const targets = ['dsh-tools', 'dsh-skill', 'cordis']
  const locations = new Map() // name -> Set<resolved real path>
  const record = (name, full) => {
    let real = full
    try {
      real = realpathSync(full)
    } catch {
      // unreadable symlink target; record the link path itself
    }
    const set = locations.get(name) ?? new Set()
    set.add(real)
    locations.set(name, set)
  }
  const walk = (dir, depth) => {
    if (depth > 7) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (targets.includes(e.name)) {
        record(e.name, full) // symlinks resolve to their target here
      }
      if (e.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  const dupes = targets.filter((t) => (locations.get(t)?.size ?? 0) > 1)
  if (dupes.length > 0) {
    return {
      name: 'dedupe',
      status: 'fail',
      detail: '关键包多副本并存: ' + dupes.map((d) => d + ' x' + locations.get(d).size).join(', ') +
        ' — 会导致工具调度崩溃(官方讨论 #1849),运行 dsh plugin --profile <p> dedupe',
    }
  }
  const present = targets.filter((t) => (locations.get(t)?.size ?? 0) === 1)
  return { name: 'dedupe', status: 'pass', detail: present.length > 0 ? present.join('/') + ' 单一副本' : '未发现关键包' }
}

/**
 * Minimal semver comparison for the peer-range check. Not a full implementation:
 * enough of the grammar (`^ ~ >= <= > < = x` and `||`) plus prerelease ordering.
 * Everything unparseable resolves to null, which callers must report as unknown —
 * never as incompatible. A doctor that fails a healthy profile is worse than none.
 */
export function parseSemver(text) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (nx) return -1
    else if (ny) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.pre, b.pre)
}

export function parseComparator(text) {
  const t = text.trim()
  if (t === '' || t === '*' || /^x$/i.test(t)) return { kind: 'any' }
  const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(t)
  if (!m) return null
  return {
    kind: 'cmp',
    op: m[1] || '=',
    hasMinor: m[3] !== undefined,
    hasPatch: m[4] !== undefined,
    version: {
      major: Number(m[2]),
      minor: m[3] === undefined ? 0 : Number(m[3]),
      patch: m[4] === undefined ? 0 : Number(m[4]),
      pre: m[5] ? m[5].split('.') : [],
    },
  }
}

function satisfiesComparator(version, c) {
  if (c.kind === 'any') return true
  const v = c.version
  const cmp = compareSemver(version, v)
  if (c.op === '=') {
    if (c.hasPatch) return cmp === 0
    if (c.hasMinor) return cmp >= 0 && version.major === v.major && version.minor === v.minor
    return version.major === v.major
  }
  if (c.op === '>') return cmp > 0
  if (c.op === '>=') return cmp >= 0
  if (c.op === '<') return cmp < 0
  if (c.op === '<=') return cmp <= 0
  if (c.op === '^') {
    if (cmp < 0) return false
    const upper = v.major > 0
      ? { major: v.major + 1, minor: 0, patch: 0, pre: [] }
      : v.minor > 0
        ? { major: 0, minor: v.minor + 1, patch: 0, pre: [] }
        : { major: 0, minor: 0, patch: v.patch + 1, pre: [] }
    return compareSemver(version, upper) < 0
  }
  if (c.op === '~') {
    if (cmp < 0) return false
    const upper = c.hasMinor ? { major: v.major, minor: v.minor + 1, patch: 0, pre: [] } : { major: v.major + 1, minor: 0, patch: 0, pre: [] }
    return compareSemver(version, upper) < 0
  }
  return null
}

function satisfiesGroup(version, comps) {
  for (const c of comps) {
    const r = satisfiesComparator(version, c)
    if (r === false) return false
    if (r === null) return null
  }
  if (version.pre.length > 0) {
    // A group that mentions any prerelease is prerelease-aware, so evaluate it
    // numerically: `>=0.1.0-rc.5 <0.2.0` genuinely accepts 0.1.5-rc.2, while
    // `>=0.1.0-rc.5 <0.1.0-rc.7` genuinely rejects it. Only a release-only group
    // (e.g. `>=4.0.0`) against a prerelease install is undecidable: strict semver
    // excludes it, but calling that a hard incompatibility would fail healthy setups.
    const prereleaseAware = comps.some((c) => c.kind === 'cmp' && c.version.pre.length > 0)
    if (!prereleaseAware) return null
  }
  return true
}

export function satisfiesRange(version, range) {
  const v = parseSemver(version)
  if (!v) return null
  let undecidable = false
  for (const group of String(range).split('||')) {
    const parts = group.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    const comps = parts.map(parseComparator)
    if (comps.some((c) => c === null)) return null
    const verdict = satisfiesGroup(v, comps)
    if (verdict === true) return true
    if (verdict === null) undecidable = true
  }
  return undecidable ? null : false
}

function readPackageJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function resolveInstalledPackage(home, profile, name) {
  const candidates = [
    join(home, 'profiles', profile, 'node_modules', name, 'package.json'),
    join(home, 'profiles', 'node_modules', name, 'package.json'),
  ]
  for (const candidate of candidates) {
    const pkg = readPackageJson(candidate)
    if (pkg && typeof pkg.version === 'string') return pkg
  }
  return null
}

/**
 * Vendor-local check (contract rule 1). Compares each installed plugin's declared
 * @deepseek-ai/* peer ranges against the host versions actually present in the
 * profile — the offline half of the plugin-x-harness compatibility question from
 * discussion #4792. Three states: compatible / incompatible / unknown (wildcard,
 * absent, unparseable, or prerelease-ambiguous). Unknown is never called compatible.
 */
export function checkPluginPeerRange(home, opts = {}) {
  const strict = opts.strictPeer === true
  const name = 'ciceroyang/peer_range'
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) return { name, status: 'pass', detail: '无 profiles 目录' }
  const incompatible = []
  let compatible = 0
  let unknown = 0
  let plugins = 0
  let profiles = 0
  let entries = 0
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const profilePkg = readPackageJson(join(profilesDir, entry.name, 'package.json'))
    if (!profilePkg) continue
    const deps = Object.keys(profilePkg.dependencies || {})
    if (deps.length === 0) continue
    profiles += 1
    for (const dep of deps) {
      const installed = resolveInstalledPackage(home, entry.name, dep)
      if (!installed) continue
      plugins += 1
      for (const [host, range] of Object.entries(installed.peerDependencies || {})) {
        if (!host.startsWith('@deepseek-ai/')) continue
        entries += 1
        const hostInstalled = resolveInstalledPackage(home, entry.name, host)
        if (!hostInstalled) {
          unknown += 1
          continue
        }
        const wildcard = String(range).trim() === '' || String(range).trim() === '*'
        const verdict = wildcard ? null : satisfiesRange(hostInstalled.version, range)
        if (verdict === true) compatible += 1
        else if (verdict === false) incompatible.push(dep + ' 需要 ' + host + ' ' + range + ',已装 ' + hostInstalled.version)
        else unknown += 1
      }
    }
  }
  const summary = '已装插件 ' + plugins + '(profile ' + profiles + ' 个),host 声明 ' + entries + ' 条:兼容 ' + compatible + ' / 未知 ' + unknown
  if (incompatible.length > 0) {
    return {
      name,
      status: 'fail',
      detail: summary + ' / 不兼容 ' + incompatible.length + ' — ' + incompatible.slice(0, 3).join('; ') +
        (incompatible.length > 3 ? ' 等' : '') + '(修复:升级插件到区间包含当前 harness 的版本,或回退 harness)',
    }
  }
  if (strict && unknown > 0) {
    return { name, status: 'warn', detail: summary + ' — 未知来自 `*`/未声明/无法解析;--strict-peer 要求确认' }
  }
  return { name, status: 'pass', detail: summary + (unknown > 0 ? '(未知主要是 `*` 通配声明)' : '') }
}

/** Whether the runtime ships built-in zstd (Node >= 22.15). */
export function zstdAvailable() {
  if (typeof process.getBuiltinModule !== 'function') return false
  const zlib = process.getBuiltinModule('node:zlib')
  return zlib !== undefined && typeof zlib.zstdDecompressSync === 'function'
}

export function checkZstd() {
  return zstdAvailable()
    ? { name: 'zstd', status: 'pass', detail: '内置 zstd 可用(可读历史会话)' }
    : { name: 'zstd', status: 'warn', detail: '当前 Node 无内置 zstd;历史会话读取类插件会降级' }
}

export function defaultHome() {
  return process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
}

export async function runAll(home = defaultHome(), opts = {}) {
  const sync = [checkNode(), checkPnpm(), checkDsh(), checkDshHome(home), checkProfiles(home), checkSessions(home), checkZstd(), checkDedupe(home), checkLogHealth(home, opts), checkPluginPeerRange(home, opts)]
  const port = await checkPort()
  return [...sync, port]
}

/**
 * dsh-doctor/v1 exit semantics: 0 all-pass, 1 any warn, 2 any fail.
 * @param {Array<{status: string}>} checks - runAll output.
 * @returns {number} exit code.
 */
export function computeExitCode(checks) {
  if (checks.some((c) => c.status === 'fail')) return 2
  if (checks.some((c) => c.status === 'warn')) return 1
  return 0 // 'skip' counts as neither pass nor fail
}

/**
 * The community dsh-doctor/v1 envelope (aligned with zoahdev and
 * moonquake2004 implementations; see official discussion #1719).
 * @param {Array<{name: string, status: string, detail: string}>} checks - runAll output.
 * @param {string} home - profile/DSH_HOME the checks ran against.
 * @returns {object} envelope.
 */
export function buildEnvelope(checks, home, opts = {}) {
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  const skips = checks.filter((c) => c.status === 'skip').length
  const passes = checks.length - fails - warns - skips
  const envelope = {
    schema: 'dsh-doctor/v1',
    generatedAt: new Date().toISOString(),
    profile: home,
    exitCode: computeExitCode(checks),
    summary: { pass: passes, warn: warns, fail: fails, skip: skips },
    ok: fails === 0,
    checks,
  }
  // Opt-in extension, nominated as a v1.1 vocabulary field in #1719; the
  // frozen r5 envelope never emits it unless the caller asks.
  if (opts.remediation === true) {
    envelope.remediation = buildRemediation(checks)
  }
  // v1.2 draft (deepseek-ai/deepseek-harness#1719): candidates are opt-in, so the
  // frozen r5 envelope only grows a `mode` when a candidate run asks for one.
  if (typeof opts.mode === 'string' && opts.mode !== '') {
    envelope.mode = opts.mode
  }
  return envelope
}

/**
 * Host package versions provided by a DSH CLI install, keyed by `@deepseek-ai/<name>`.
 * Roots are the CLI's own bundled packages and the global install; missing roots are skipped.
 */
export function installedHostVersions(roots = defaultHostRoots()) {
  const hosts = {}
  for (const dir of roots) {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const key = '@deepseek-ai/' + entry.name
      if (hosts[key]) continue
      const pkg = readPackageJson(join(dir, entry.name, 'package.json'))
      if (pkg && typeof pkg.version === 'string') hosts[key] = pkg.version
    }
  }
  return hosts
}

function defaultHostRoots() {
  const roots = []
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20000 }).trim()
    roots.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    roots.push(join(globalRoot, '@deepseek-ai'))
  } catch {
    // npm unavailable: no host versions, every precise range becomes unresolved
  }
  return roots
}

/**
 * Lint one package's `@deepseek-ai/*` peer declarations against installed host
 * versions. Same three-state rule as the profile check, but used from the plugin
 * author's side: it answers "does my declaration cover the host I am testing on?"
 * @param {object} pkg - parsed package.json.
 * @param {Record<string, string>} hosts - installed host versions.
 * @returns {{rows: Array<object>, counts: object, hasPeers: boolean}}
 */
export function lintPeerDeclarations(pkg, hosts) {
  const peers = Object.entries(pkg?.peerDependencies ?? {}).filter(([host]) => host.startsWith('@deepseek-ai/'))
  const rows = []
  for (const [host, range] of peers) {
    const installed = hosts[host] ?? null
    const text = String(range).trim()
    let verdict
    if (text === '' || text === '*') verdict = 'wildcard'
    else if (installed === null) verdict = 'unresolved'
    else {
      const result = satisfiesRange(installed, range)
      verdict = result === true ? 'compatible' : result === false ? 'incompatible' : 'undecidable'
    }
    rows.push({ host, range, installed, verdict })
  }
  const counts = { compatible: 0, incompatible: 0, wildcard: 0, unresolved: 0, undecidable: 0 }
  for (const row of rows) counts[row.verdict] += 1
  return { rows, counts, hasPeers: peers.length > 0 }
}

function lintPeersAt(target) {
  const path = join(target, 'package.json')
  const pkgPath = existsSync(path) ? path : target
  const pkg = readPackageJson(pkgPath)
  if (!pkg) throw new Error('找不到或无法解析 package.json: ' + pkgPath)
  const hosts = installedHostVersions()
  // Never pass silently when there is nothing to compare against: on a machine
  // without a DSH install every precise range would read as "unresolved" and the
  // lint would exit 0, which is the one wrong answer that matters.
  if (Object.keys(hosts).length === 0) {
    throw new Error('本机找不到任何 @deepseek-ai host 包;请先 npm install -g @deepseek-ai/dsh 再运行(否则所有精确区间都会显示为未解析,检查结果没有意义)')
  }
  return { pkg, hosts, ...lintPeerDeclarations(pkg, hosts) }
}

const LINT_MARK = { compatible: '✓ 兼容', incompatible: '✗ 不兼容', wildcard: '· 通配(*)', unresolved: '? 未解析', undecidable: '? 无法判定' }

function renderLint(result) {
  console.log('peer 声明检查: ' + (result.pkg.name ?? '(未命名)') + '@' + (result.pkg.version ?? '?') + '  · host 版本来自本机 CLI 安装(' + Object.keys(result.hosts).length + ' 个包)')
  console.log('')
  for (const row of result.rows) {
    console.log('  ' + LINT_MARK[row.verdict] + '  ' + row.host + '  ' + row.range + '  (已装 ' + (row.installed ?? '-') + ')')
  }
  console.log('')
  console.log('结果: ' + result.counts.compatible + ' 兼容 / ' + result.counts.incompatible + ' 不兼容 / ' + result.counts.wildcard + ' 通配 / ' + result.counts.unresolved + ' 未解析 / ' + result.counts.undecidable + ' 无法判定')
  if (!result.hasPeers) console.log('这个包没有声明任何 @deepseek-ai/* peer:目录与升级检查无法从元数据判断兼容性(#4792)。')
  else if (result.counts.incompatible > 0) console.log('把不兼容的区间改到包含当前 host 的版本,或明确写出你实际测试过的版本线。')
  if (result.counts.wildcard > 0) console.log('通配 `*` 等于没有声明:需要兼容性判断的消费者会把它当作未知,而不是通过。')
  if (result.counts.unresolved > 0) console.log('未解析项:该 host 包不在本机 CLI 里,换一台装了对应包的机器再跑一次。')
}

/**
 * Parse the loader-patch entries a `cordis.patch.yml` would insert.
 *
 * The profile template documents the file as a top-level YAML array of entries
 * carrying `id` (and optionally `name`, `disabled`). A full YAML parser is out of
 * scope for a zero-dependency tool, so this is a targeted line scanner over that
 * documented shape; unknown lines are ignored rather than guessed at.
 * @param {string} text - patch file content.
 * @returns {Array<{id: string, name: string|null}>} enabled inserts in file order.
 */
export function parsePatchInserts(text) {
  const inserts = []
  let current = null
  for (const line of String(text).split('\n')) {
    const idMatch = /^\s*-?\s*id:\s*['"]?([\w@/.\-]+)['"]?\s*$/.exec(line)
    if (idMatch) {
      if (current) inserts.push(current)
      current = { id: idMatch[1], name: null, disabled: false }
      continue
    }
    if (!current) continue
    const nameMatch = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (nameMatch) {
      current.name = nameMatch[1]
      continue
    }
    if (/^\s*disabled:\s*true\s*$/.test(line)) current.disabled = true
  }
  if (current) inserts.push(current)
  return inserts.filter((entry) => !entry.disabled)
}

const BUILTIN_PREFIXES = ['cordis:', 'node:']

/** A package spec we can look for on disk (not a builtin, relative or absolute path). */
function isResolvableSpec(name) {
  if (typeof name !== 'string' || name === '') return false
  if (BUILTIN_PREFIXES.some((prefix) => name.startsWith(prefix))) return false
  if (name.startsWith('.') || name.startsWith('/')) return false
  return true
}

function resolveInProfile(profileDir, name) {
  const roots = [join(profileDir, 'node_modules'), join(dirname(profileDir), 'node_modules')]
  for (const root of roots) {
    // Presence is what this answers: a manifest without a version still means the
    // package is in the tree. (Host versions are resolved separately, where a
    // version is genuinely required.)
    const pkg = readPackageJson(join(root, name, 'package.json'))
    if (pkg) return pkg
  }
  return null
}

/** Every patch file already in the profile: its bundles' patches plus the user patch. */
function existingPatchFiles(profileDir) {
  const files = []
  const manifest = readPackageJson(join(profileDir, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  for (const bundle of bundles) {
    const patch = join(profileDir, 'node_modules', bundle, 'cordis.patch.yml')
    if (existsSync(patch)) files.push(patch)
  }
  const userPatch = join(profileDir, 'cordis.patch.yml')
  if (existsSync(userPatch)) files.push(userPatch)
  return files
}

/**
 * Pre-flight checks for a proposed patch: judge the tree the change would produce,
 * without applying it. Implements the declaration-focused subset of the v1.2
 * `candidate` draft (deepseek-ai/deepseek-harness#1719): insert-id collision,
 * inserted-module presence, and the host peer ranges of what would be inserted.
 *
 * It intentionally performs no mutation. The reversible action the draft requires
 * (quarantine, then rollback) belongs to the installer that owns the write; this
 * function is the pre-flight half and says so in its output.
 * @param {string} profileDir - profile directory to evaluate against.
 * @param {string} patchText - proposed `cordis.patch.yml` content.
 * @returns {Array<{name: string, status: string, detail: string}>} checks.
 */
export function candidatePeerChecks(profileDir, patchText) {
  const inserts = parsePatchInserts(patchText)
  const existingIds = new Set()
  for (const file of existingPatchFiles(profileDir)) {
    for (const entry of parsePatchInserts(readFileSync(file, 'utf8'))) existingIds.add(entry.id)
  }
  const collisions = inserts.filter((entry) => existingIds.has(entry.id))
  const seenSpecs = new Set()
  const specs = inserts
    .filter((entry) => isResolvableSpec(entry.name))
    .filter((entry) => (seenSpecs.has(entry.name) ? false : (seenSpecs.add(entry.name), true)))
  const missing = []
  const peerRows = []
  const hosts = installedHostVersions([
    join(profileDir, 'node_modules', '@deepseek-ai'),
    join(dirname(profileDir), 'node_modules', '@deepseek-ai'),
  ])
  for (const entry of specs) {
    const pkg = resolveInProfile(profileDir, entry.name)
    if (!pkg) {
      missing.push(entry.name)
      continue
    }
    const lint = lintPeerDeclarations(pkg, hosts)
    for (const row of lint.rows) {
      if (row.verdict === 'incompatible') peerRows.push(entry.name + ' 需要 ' + row.host + ' ' + row.range + ',已装 ' + row.installed)
      else if (row.verdict === 'unresolved' || row.verdict === 'undecidable') peerRows.push(entry.name + ' ' + row.host + ' ' + row.range + '(未知)')
    }
  }
  const checks = []
  checks.push({
    name: 'candidate-insert-collision',
    status: collisions.length > 0 ? 'warn' : 'pass',
    detail: collisions.length > 0
      ? '插入的 id 已存在于当前树:' + collisions.map((entry) => entry.id).join(', ') + '(会碰撞而非新增)'
      : '插入的 ' + inserts.length + ' 个 id 均未与当前树冲突',
  })
  checks.push({
    name: 'candidate-module-installed',
    status: missing.length > 0 ? 'fail' : 'pass',
    detail: missing.length > 0
      ? '要插入的包在变更后的树里找不到:' + missing.join(', ') + '(修复: dsh plugin --profile <name> add <pkg>)'
      : (specs.length === 0 ? '没有可解析的包名(仅内置/相对路径)' : '要插入的 ' + specs.length + ' 个包都存在于目标树里'),
  })
  const incompatible = peerRows.filter((row) => !row.includes('(未知)'))
  checks.push({
    name: 'candidate-peer-range',
    status: incompatible.length > 0 ? 'fail' : 'pass',
    detail: incompatible.length > 0
      ? '变更后 host 范围不匹配:' + incompatible.join('; ')
      : (peerRows.length > 0 ? '有 ' + peerRows.length + ' 条声明无法确定(按未知处理,不计入失败)' : '没有声明精确 host 范围的插入项'),
  })
  return checks
}

function parseArgs(argv) {
  const args = { json: false, envelope: false, profile: null, remediation: false, allLogs: false, strictPeer: false, lintPeers: false, lintTarget: null, candidatePeer: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') args.json = true
    else if (arg === '--envelope') args.envelope = true
    else if (arg === '--remediation') args.remediation = true
    else if (arg === '--all-logs') args.allLogs = true
    else if (arg === '--strict-peer') args.strictPeer = true
    else if (arg === '--candidate-peer') {
      args.candidatePeer = argv[++i]
      if (!args.candidatePeer) { console.error('--candidate-peer requires a path'); process.exit(2) }
    }
    else if (arg === '--lint-peers') {
      args.lintPeers = true
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { args.lintTarget = next; i += 1 }
    }
    else if (arg === '--profile') {
      args.profile = argv[++i]
      if (!args.profile) {
        console.error('--profile requires a value')
        process.exit(2)
      }
    } else {
      console.error('unknown option ' + arg)
      process.exit(2)
    }
  }
  return args
}

const REMEDIATIONS = {
  node: '升级 Node 到官方范围 ^22.19.0 || >=24.0.0(nvm install 22 或安装包升级)',
  pnpm: 'npm install -g pnpm(国内网络加 --registry=https://registry.npmmirror.com)',
  dsh: 'npm install -g @deepseek-ai/dsh,或使用 npx @deepseek-ai/dsh',
  ds_home: 'sudo chown $(whoami) <DSH_HOME 下被 root 占用的文件>,或删除重建 settings.yaml',
  profiles: '无应用组合包的 profile 启动会挂起(#2321): dsh plugin --profile <name> add @deepseek-ai/dsh-headless',
  sessions: '检查 DSH_HOME 指向与目录权限',
  log_health: '会话日志损坏:参考官方讨论 #1043,或社区工具 dsh-session-health 做帧级诊断',
  dedupe: 'dsh plugin --profile <p> dedupe;仍有多副本则卸载重装相关插件(#1849)',
  'ciceroyang/peer_range': '升级插件到区间包含当前 harness 的版本,或把 harness 回退到插件声明的范围内(#4792)',
  port: 'dsh --profile web --port <其他端口> 换端口启动',
}

/**
 * Human-mode remediation lines for every failing/warning check.
 * Kept out of the JSON envelope so the frozen r5 shape stays untouched.
 * @param {Array<{name: string, status: string}>} checks - runAll output.
 * @returns {string[]} actionable fix lines.
 */
export function buildRemediation(checks) {
  const lines = []
  for (const c of checks) {
    if (c.status === 'pass' || c.status === 'skip') continue
    const fix = REMEDIATIONS[c.name]
    if (fix) lines.push('[' + c.name + '] ' + fix)
  }
  return lines
}

function render(checks, json) {
  if (json) {
    console.log(JSON.stringify(checks, null, 2))
    return
  }
  console.log('DeepSeek Harness 环境体检 (dsh-doctor)')
  console.log('')
  for (const c of checks) {
    const emoji = c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗'
    console.log(emoji + ' ' + c.name + ': ' + c.detail)
  }
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  console.log('')
  console.log('结果: ' + fails + ' fail / ' + warns + ' warn / ' + (checks.length - fails - warns) + ' pass')
  const remediations = buildRemediation(checks)
  if (remediations.length > 0) {
    console.log('')
    console.log('修复建议:')
    for (const line of remediations) console.log('  ' + line)
  }
  if (fails > 0) console.log('先修 ✗ 项;修完重跑。')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.candidatePeer) {
    try {
      const target = resolve(args.candidatePeer)
      const patchPath = statSync(target).isDirectory() ? join(target, 'cordis.patch.yml') : target
      const profileDir = args.profile ?? defaultHome()
      const checks = candidatePeerChecks(profileDir, readFileSync(patchPath, 'utf8'))
      const envelope = buildEnvelope(checks, profileDir, { mode: 'candidate' })
      if (args.json || args.envelope) console.log(JSON.stringify(envelope, null, 2))
      else {
        console.log('candidate 预检(不写入任何文件): ' + patchPath + ' → ' + profileDir)
        console.log('')
        for (const check of checks) {
          const emoji = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗'
          console.log(emoji + ' ' + check.name + ': ' + check.detail)
        }
        console.log('')
        console.log('说明:这是变更前的判定;隔离/回滚属于执行写入的安装器(#1719 v1.2 第 4 条)。')
      }
      process.exit(computeExitCode(checks))
    } catch (error) {
      console.error('candidate-peer: ' + error.message)
      process.exit(2)
    }
  }
  if (args.lintPeers) {
    try {
      const result = lintPeersAt(args.lintTarget ?? '.')
      renderLint(result)
      process.exit(result.counts.incompatible > 0 ? 1 : 0)
    } catch (error) {
      console.error('lint-peers: ' + error.message)
      process.exit(2)
    }
  }
  const home = args.profile ?? defaultHome()
  runAll(home, { allLogs: args.allLogs, strictPeer: args.strictPeer }).then((checks) => {
    if (args.envelope) {
      console.log(JSON.stringify(buildEnvelope(checks, home, { remediation: args.remediation }), null, 2))
    } else {
      render(checks, args.json)
    }
    process.exit(computeExitCode(checks))
  }).catch((error) => {
    console.error('doctor 自身出错: ' + String(error))
    process.exit(2)
  })
}
