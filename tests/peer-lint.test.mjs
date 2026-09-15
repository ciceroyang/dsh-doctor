/**
 * Unit tests for the author-side peer declaration lint.
 * @module dsh-doctor/tests/peer-lint
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintPeerDeclarations } from '../doctor.mjs'

const HOSTS = { '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/dsh-tools': '0.1.5-rc.2', '@deepseek-ai/dsh-llm': '0.2.0-rc.1' }

test('lintPeerDeclarations classifies every verdict in one pass', () => {
  const result = lintPeerDeclarations({
    peerDependencies: {
      '@deepseek-ai/cordis': '>=4.0.0 <5',
      '@deepseek-ai/dsh-tools': '^0.0.1',
      '@deepseek-ai/dsh-skill': '*',
      '@deepseek-ai/dsh-not-installed': '^1',
      '@deepseek-ai/dsh-llm': '>=0.1.0',
      'left-pad': '^1',
    },
  }, HOSTS)
  assert.equal(result.counts.compatible, 1)
  assert.equal(result.counts.incompatible, 1)
  assert.equal(result.counts.wildcard, 1)
  assert.equal(result.counts.unresolved, 1)
  assert.equal(result.counts.undecidable, 1)
  assert.equal(result.rows.length, 5, 'non host peers are ignored')
  assert.equal(result.rows.find((r) => r.host === '@deepseek-ai/dsh-tools').verdict, 'incompatible')
})

test('lintPeerDeclarations reports no peers for a plugin without host declarations', () => {
  const result = lintPeerDeclarations({ peerDependencies: { react: '^18' } }, HOSTS)
  assert.equal(result.hasPeers, false)
  assert.equal(result.rows.length, 0)
})

test('lintPeerDeclarations accepts a valid current declaration', () => {
  const result = lintPeerDeclarations({
    peerDependencies: { '@deepseek-ai/cordis': '>=4.0.0 <5', '@deepseek-ai/dsh-tools': '>=0.1.0-rc.5 <0.2.0' },
  }, HOSTS)
  assert.equal(result.counts.incompatible, 0)
  assert.equal(result.counts.compatible, 2)
})