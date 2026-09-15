#!/usr/bin/env node
/**
 * Ecosystem-wide host-declaration snapshot.
 *
 * Reads a directory README of plugin repositories, fetches each repository's root
 * package.json, and checks every `@deepseek-ai/*` peer declaration against the host
 * versions a DSH install provides. Writes a JSON snapshot and a Markdown summary.
 *
 * Zero dependencies. Run with a DSH install present (npm i -g @deepseek-ai/dsh),
 * otherwise every precise range is unresolved and the snapshot is meaningless.
 *
 * @module dsh-doctor/scripts/ecosystem-compat
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { lintPeerDeclarations, installedHostVersions } from '../doctor.mjs'

const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/beancookie/awesome-dsh-plugin/main/README.en.md'

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, out: 'compat.json', summary: 'compat-summary.md', concurrency: 8 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--source') args.source = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--summary') args.summary = argv[++i]
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i])
    else if (arg === '--help') { console.log('node scripts/ecosystem-compat.mjs [--source url|file] [--out compat.json] [--summary compat-summary.md] [--concurrency 8]'); process.exit(0) }
    else { console.error('unknown option ' + arg); process.exit(2) }
  }
  return args
}

async function readSource(source) {
  if (!/^https?:/.test(source)) return readFileSync(source, 'utf8')
  let lastError = 'unknown'
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(source, { signal: AbortSignal.timeout(60000) })
      if (res.status === 200) return res.text()
      lastError = 'HTTP ' + res.status
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)))
  }
  throw new Error('source fetch failed after 4 attempts (' + lastError + '); pass --source <local file> to scan offline')
}

function extractRepos(text) {
  const matches = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? []
  const repos = matches.map((url) => url.replace('https://github.com/', '')).filter((repo) => repo.split('/').length === 2)
  return [...new Set(repos)].sort()
}

async function fetchPackage(repo) {
  const url = 'https://raw.githubusercontent.com/' + repo + '/HEAD/package.json'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
      if (res.status === 200) return JSON.parse(await res.text())
      if (res.status === 404) return null
    } catch {
      // retry once
    }
  }
  return undefined // network failure, distinct from "no package.json"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const hosts = installedHostVersions()
  if (Object.keys(hosts).length === 0) {
    console.error('no @deepseek-ai host packages found; install @deepseek-ai/dsh first')
    process.exit(2)
  }
  const repos = extractRepos(await readSource(args.source))
  console.error('host packages: ' + Object.keys(hosts).length + ' | repositories: ' + repos.length)

  const results = []
  let cursor = 0
  const worker = async () => {
    while (cursor < repos.length) {
      const index = cursor
      cursor += 1
      const repo = repos[index]
      const pkg = await fetchPackage(repo)
      if (pkg === undefined) { results.push({ repo, state: 'fetch-failed' }); continue }
      if (pkg === null) { results.push({ repo, state: 'no-package-json' }); continue }
      const lint = lintPeerDeclarations(pkg, hosts)
      if (!lint.hasPeers) { results.push({ repo, name: pkg.name ?? null, version: pkg.version ?? null, dshBundle: Boolean(pkg.dsh?.bundle), state: 'no-host-peers' }); continue }
      let worst = 'compatible'
      for (const row of lint.rows) {
        if (row.verdict === 'incompatible') { worst = 'incompatible'; break }
        if ((row.verdict === 'unresolved' || row.verdict === 'undecidable') && worst === 'compatible') worst = 'unknown'
      }
      results.push({ repo, name: pkg.name ?? null, version: pkg.version ?? null, dshBundle: Boolean(pkg.dsh?.bundle), state: 'checked', worst, counts: lint.counts, peers: lint.rows })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker))
  results.sort((a, b) => a.repo.localeCompare(b.repo))

  const checked = results.filter((r) => r.state === 'checked')
  const incompatible = checked.filter((r) => r.worst === 'incompatible')
  const unknown = checked.filter((r) => r.worst === 'unknown')
  const compatible = checked.filter((r) => r.worst === 'compatible')
  const peerCounts = { compatible: 0, incompatible: 0, wildcard: 0, unresolved: 0, undecidable: 0 }
  for (const r of checked) for (const key of Object.keys(peerCounts)) peerCounts[key] += r.counts[key]
  const stats = {
    repositories: results.length,
    checked: checked.length,
    incompatibleRepos: incompatible.length,
    unknownRepos: unknown.length,
    compatibleRepos: compatible.length,
    noHostPeers: results.filter((r) => r.state === 'no-host-peers').length,
    noPackageJson: results.filter((r) => r.state === 'no-package-json').length,
    fetchFailed: results.filter((r) => r.state === 'fetch-failed').length,
    peerCounts,
  }

  const generatedAt = new Date().toISOString()
  writeFileSync(args.out, JSON.stringify({ generatedAt, source: args.source, hosts, stats, results }, null, 2) + '\n')

  const lines = []
  lines.push('# DSH plugin x host compatibility snapshot')
  lines.push('')
  lines.push('Generated ' + generatedAt + ' from ' + args.source + '.')
  lines.push('')
  lines.push('Of ' + stats.repositories + ' repositories, **' + stats.checked + '** declare at least one `@deepseek-ai/*` peer: **' + stats.compatibleRepos + '** fully compatible, **' + stats.unknownRepos + '** with unresolved/undecidable declarations, **' + stats.incompatibleRepos + '** with at least one range that excludes the installed host.')
  lines.push('')
  lines.push('Peer declarations: ' + peerCounts.compatible + ' compatible / ' + peerCounts.incompatible + ' incompatible / ' + peerCounts.wildcard + ' wildcard / ' + peerCounts.unresolved + ' unresolved / ' + peerCounts.undecidable + ' undecidable.')
  lines.push('')
  lines.push(stats.noHostPeers + ' plugins declare a bundle but no host range at all, and ' + stats.noPackageJson + ' repositories have no root package.json; both are unanswerable from metadata.')
  if (stats.fetchFailed > 0) {
    lines.push('')
    lines.push('**' + stats.fetchFailed + ' repositories could not be fetched** (network/timeout) and are counted in neither group; re-run to fill them in.')
  }
  lines.push('')
  if (incompatible.length > 0) {
    lines.push('## Repositories with an incompatible declaration')
    lines.push('')
    lines.push('| repo | declared | installed |')
    lines.push('| --- | --- | --- |')
    for (const r of incompatible) {
      for (const row of r.peers.filter((p) => p.verdict === 'incompatible')) {
        lines.push('| [' + r.repo + '](https://github.com/' + r.repo + ') | ' + row.host + ' `' + row.range + '` | ' + row.installed + ' |')
      }
    }
    lines.push('')
  }
  lines.push('## Method and limits')
  lines.push('')
  lines.push('- Declaration source: each repository root `package.json` at HEAD (default branch, not the published tarball).')
  lines.push('- Host versions: the `@deepseek-ai` packages provided by the DSH CLI install on the scanning machine (' + Object.keys(hosts).length + ' packages).')
  lines.push('- A verdict is about the **declaration**, not runtime behaviour: the loader does not enforce peer ranges.')
  lines.push('- `wildcard` (`*` or absent) is reported as unknown, never as compatible.')
  lines.push('- Check your own package with `node doctor.mjs --lint-peers .`; this snapshot is refreshed by a scheduled workflow.')
  writeFileSync(args.summary, lines.join('\n') + '\n')

  console.log('checked ' + stats.checked + ' | compatible ' + stats.compatibleRepos + ' | unknown ' + stats.unknownRepos + ' | incompatible ' + stats.incompatibleRepos)
  console.log('wrote ' + args.out + ' and ' + args.summary)
}

main().catch((error) => {
  console.error('ecosystem-compat: ' + error.message)
  process.exit(2)
})