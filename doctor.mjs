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

import { existsSync, readdirSync, readFileSync, accessSync, constants, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Sample the newest session logs and verify multi-frame zstd health. The
 * differentiating check: a broken or torn frame usually hides here while the
 * rest of the environment looks fine.
 * @param {string} home - DSH home.
 * @returns {{name: string, status: string, detail: string}} check result.
 */
export function checkLogHealth(home) {
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
  const sample = logs.slice(0, 3)
  const results = []
  let bad = 0
  for (const entry of sample) {
    try {
      const bytes = readFileSync(entry.path)
      const frames = scanZstdFrames(bytes)
      const text = zstdDecompressAll(bytes)
      const lines = text.split('\n').filter((l) => l.trim() !== '').length
      results.push(frames.length + '帧/' + lines + '行')
    } catch {
      bad += 1
      results.push('解码失败')
    }
  }
  return bad > 0
    ? { name: 'log_health', status: 'fail', detail: '抽查 ' + sample.length + ' 个日志:' + results.join(' ') + ' [' + bad + ' 个损坏]' }
    : { name: 'log_health', status: 'pass', detail: '抽查 ' + sample.length + ' 个日志:' + results.join(' ') }
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

export async function runAll(home = defaultHome()) {
  const sync = [checkNode(), checkPnpm(), checkDsh(), checkDshHome(home), checkProfiles(home), checkSessions(home), checkZstd(), checkDedupe(home), checkLogHealth(home)]
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
export function buildEnvelope(checks, home) {
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  const skips = checks.filter((c) => c.status === 'skip').length
  const passes = checks.length - fails - warns - skips
  return {
    schema: 'dsh-doctor/v1',
    generatedAt: new Date().toISOString(),
    profile: home,
    exitCode: computeExitCode(checks),
    summary: { pass: passes, warn: warns, fail: fails, skip: skips },
    ok: fails === 0,
    checks,
  }
}

function parseArgs(argv) {
  const args = { json: false, envelope: false, profile: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') args.json = true
    else if (arg === '--envelope') args.envelope = true
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
  const home = args.profile ?? defaultHome()
  runAll(home).then((checks) => {
    if (args.envelope) {
      console.log(JSON.stringify(buildEnvelope(checks, home), null, 2))
    } else {
      render(checks, args.json)
    }
    process.exit(computeExitCode(checks))
  }).catch((error) => {
    console.error('doctor 自身出错: ' + String(error))
    process.exit(2)
  })
}
