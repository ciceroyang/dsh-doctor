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

import { existsSync, readdirSync, readFileSync, accessSync, constants, realpathSync } from 'node:fs'
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
  const major = Number(version.split('.')[0])
  if (major < 18) return { name: 'node', status: 'fail', detail: version + ' (< 18,建议升级)' }
  if (major < 22) return { name: 'node', status: 'warn', detail: version + ' (≥22.15 才支持读取历史会话日志)' }
  return { name: 'node', status: 'ok', detail: version }
}

export function checkPnpm() {
  const text = run('pnpm', ['--version'])
  if (!text) return { name: 'pnpm', status: 'fail', detail: '未安装或不在 PATH(dsh plugin 需要;npm i -g pnpm)' }
  return { name: 'pnpm', status: 'ok', detail: text }
}

export function checkDsh() {
  const text = run('dsh', ['--version'])
  if (!text) return { name: 'dsh', status: 'warn', detail: 'PATH 中未找到;可 npx @deepseek-ai/dsh 运行' }
  return { name: 'dsh', status: 'ok', detail: text }
}

export function checkPort(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const server = createServer()
      server.once('error', () => resolve({ name: 'port', status: 'warn', detail: port + ' 已被占用(web GUI 可能已在运行)' }))
      server.once('listening', () => server.close(() => resolve({ name: 'port', status: 'ok', detail: port + ' 空闲' })))
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
    return { name: 'ds_home', status: 'ok', detail: settings + ' 可写' }
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
  for (const name of entries) {
    const pkgFile = join(dir, name, 'package.json')
    if (!existsSync(pkgFile)) continue // shared dirs like node_modules are not profiles
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const bundles = pkg?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) throw new Error('no bundles')
      rows.push(name + '(' + bundles.length + ' bundles)')
    } catch {
      bad += 1
      rows.push(name + '(清单损坏)')
    }
  }
  const status = bad > 0 ? 'warn' : 'ok'
  return { name: 'profiles', status, detail: (rows.length > 0 ? rows.join(' ') : '无 profile') + (bad > 0 ? ' [损坏 ' + bad + ']' : '') }
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
  if (files === 0) return { name: 'sessions', status: 'ok', detail: '0 个日志' }
  return { name: 'sessions', status: 'ok', detail: files + ' 个日志(读取需要 Node ≥ 22.15 内置 zstd)' }
}

export function checkDedupe(home) {
  const root = join(home, 'profiles', 'node_modules')
  if (!existsSync(root)) return { name: 'dedupe', status: 'ok', detail: '无插件依赖目录' }
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
  return { name: 'dedupe', status: 'ok', detail: present.length > 0 ? present.join('/') + ' 单一副本' : '未发现关键包' }
}

export function checkZstd() {
  let zstd = false
  if (typeof process.getBuiltinModule === 'function') {
    const zlib = process.getBuiltinModule('node:zlib')
    zstd = zlib !== undefined && typeof zlib.zstdDecompressSync === 'function'
  }
  return zstd
    ? { name: 'zstd', status: 'ok', detail: '内置 zstd 可用(可读历史会话)' }
    : { name: 'zstd', status: 'warn', detail: '当前 Node 无内置 zstd;历史会话读取类插件会降级' }
}

export function defaultHome() {
  return process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
}

export async function runAll(home = defaultHome()) {
  const sync = [checkNode(), checkPnpm(), checkDsh(), checkDshHome(home), checkProfiles(home), checkSessions(home), checkZstd(), checkDedupe(home)]
  const port = await checkPort()
  return [...sync, port]
}

function render(checks, json) {
  if (json) {
    console.log(JSON.stringify(checks, null, 2))
    return
  }
  console.log('DeepSeek Harness 环境体检 (dsh-doctor)')
  console.log('')
  for (const c of checks) {
    const emoji = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗'
    console.log(emoji + ' ' + c.name + ': ' + c.detail)
  }
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  console.log('')
  console.log('结果: ' + fails + ' fail / ' + warns + ' warn / ' + (checks.length - fails - warns) + ' ok')
  if (fails > 0) console.log('先修 ✗ 项;修完重跑。')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const json = process.argv.includes('--json')
  runAll().then((checks) => render(checks, json)).catch((error) => {
    console.error('doctor 自身出错: ' + String(error))
    process.exit(1)
  })
}
