#!/usr/bin/env node
/**
 * Differential test for semver-range verdicts.
 *
 * Compares this repository's `satisfiesRange` against another implementation of the
 * same rule (a module exporting `peerRangeState`), over either a built-in edge-case
 * corpus or every (range, installed) pair in an ecosystem snapshot. Two independent
 * implementations of a hand-written rule diverge where the rule is underspecified —
 * the divergences are the useful output.
 *
 * Usage:
 *   node scripts/range-difftest.mjs --other /path/to/impl.mjs [--corpus compat.json]
 *
 * @module dsh-doctor/scripts/range-difftest
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { satisfiesRange } from '../doctor.mjs'

const EDGE_CASES = [
  ['>=0.1.0-rc.5 <0.2.0', '0.1.5-rc.2'],
  ['>=0.1.0-rc.5 <0.1.0-rc.7', '0.1.5-rc.2'],
  ['>=4.0.0', '4.1.0-rc.1'],
  ['>=4.0.0', '3.9.0'],
  ['^1.2.3', '1.2.4-rc.1'],
  ['^1.2.3', '1.4.0'],
  ['~1.2.3', '1.3.0'],
  ['^0.0.1', '4.0.2'],
  ['^0.0.1', '0.1.5-rc.2'],
  ['>=0.1.0-rc.5 <1', '0.1.5-rc.2'],
  ['>=4.0.1 <5', '4.0.2'],
  ['>=1.0.0 <2.0.0 || >=3.0.0', '2.5.0'],
  ['1.2.3', '1.2.3'],
]

function parseArgs(argv) {
  const args = { other: null, corpus: null, exportName: 'peerRangeState', limit: 20, failOnDivergence: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--other') args.other = argv[++i]
    else if (arg === '--corpus') args.corpus = argv[++i]
    else if (arg === '--export') args.exportName = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--fail-on-divergence') args.failOnDivergence = true
    else { console.error('unknown option ' + arg); process.exit(2) }
  }
  if (!args.other) { console.error('--other <module.mjs> is required (a module exporting the peerRangeState rule)'); process.exit(2) }
  return args
}

function loadCorpus(path) {
  if (!path) return EDGE_CASES.map(([range, installed]) => ({ range, installed }))
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  const cases = []
  for (const result of snapshot.results ?? []) {
    if (result.state !== 'checked') continue
    for (const peer of result.peers ?? []) {
      if (peer.installed === null) continue
      const raw = String(peer.range).trim()
      if (raw === '' || raw === '*') continue
      cases.push({ range: peer.range, installed: peer.installed, repo: result.repo, host: peer.host })
    }
  }
  return cases
}

const verdictOf = (value) => (value === true ? 'satisfied' : value === false ? 'unsatisfied' : 'unknown')

const args = parseArgs(process.argv.slice(2))
const other = await import(pathToFileURL(resolve(args.other)).href)
const otherFn = other[args.exportName]
if (typeof otherFn !== 'function') { console.error('module does not export ' + args.exportName); process.exit(2) }

const cases = loadCorpus(args.corpus)
const divergences = []
const patterns = new Map()
for (const testCase of cases) {
  const ours = verdictOf(satisfiesRange(testCase.installed, testCase.range))
  const raw = otherFn(testCase.installed, testCase.range)
  const theirs = typeof raw === 'string' ? raw : raw?.state
  if (ours === theirs) continue
  divergences.push({ ...testCase, ours, theirs })
  const key = ours + ' vs ' + theirs + ' | ' + testCase.range + ' | ' + testCase.installed
  patterns.set(key, (patterns.get(key) ?? 0) + 1)
}

console.log('cases: ' + cases.length + ' | divergences: ' + divergences.length)
const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1])
for (const [pattern, count] of sorted) console.log('  x' + count + '  ' + pattern)
if (divergences.length > 0) {
  console.log('')
  console.log('sample divergences:')
  for (const row of divergences.slice(0, args.limit)) {
    console.log('  ' + (row.repo ?? '(case)') + '  ' + (row.host ?? '') + '  ' + row.range + '  inst=' + row.installed + '  ours=' + row.ours + ' theirs=' + row.theirs)
  }
}
process.exit(args.failOnDivergence && divergences.length > 0 ? 1 : 0)