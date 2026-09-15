# Host peer declarations: one rule shared by plugins and tooling

How does a plugin say which harness it works with, and how does anything else check that claim? This document is the rule this tool implements on both sides (author and consumer), written so that a second implementation can conform without re-deriving the edge cases.

Context: deepseek-ai/deepseek-harness#4792 (the compatibility question), #6680 (installs are not checked), #1719 (the contract discipline this follows: freeze what consumers depend on, make additions additive).

## Why the declaration is the only signal we have

- `peerDependencies` on `@deepseek-ai/*` packages is already machine-readable and already published in npm metadata, so directories and managers can read it without cloning anything.
- `dsh plugin add` does not evaluate it: a profile's pnpm config is `autoInstallPeers: false`, the host packages come from the CLI's shared root layer and are not in the profile's dependency graph, so pnpm has no peer target to resolve against and prints nothing (#6680).
- The ecosystem snapshot (2026-09-15, 503 repositories) shows what that costs: 162 plugins declare a bundle but no host range at all; of the 305 that do declare one, 43 declare at least one range that excludes the installed host, and 160 declarations are wildcards.

## The rule

### 1. Declaration (author side)

A plugin SHOULD declare a range for every `@deepseek-ai/*` package it loads at runtime. `*` is legal but means "no information": consumers MUST treat it as unknown, not as compatible.

### 2. Resolution (consumer side)

To find the version that will actually be provided:

1. Read `<profile>/node_modules/<name>/package.json`.
2. Fall back to `<DSH_HOME>/profiles/node_modules/<name>/package.json` (the CLI's shared root layer).
3. **Follow symlinks.** Dev/`file:` plugins and the root layer both appear as symlinks; an `lstat`-style check reports the two most common healthy layouts as missing. A symlink whose target is gone is genuinely missing.
4. Scoped names split at the first slash (`@scope/name` is two segments).
5. Exclude `cordis:` and `node:` builtins, relative paths and absolute paths before judging them.

### 3. Verdict

Three states, and **unknown is never compatible**:

| verdict | meaning |
| --- | --- |
| `compatible` | the declared range includes the provided version |
| `incompatible` | it does not |
| `unknown` | wildcard, undeclared, unparseable, or prerelease-ambiguous |

Consumers SHOULD surface `incompatible` as a warning or risk signal, not as a hard failure: the loader does not enforce peer ranges, so the declaration is evidence about intent, not a runtime verdict.

### 4. Prerelease semantics (the part that is easy to get wrong)

DSH ships prerelease versions, so this decides whether the rule is usable at all. Evaluate twice and combine:

```
strict  = semver range check with includePrerelease: false
numeric = semver range check with includePrerelease: true

strict satisfied                 -> compatible
numeric satisfied, strict not    -> unknown    // the only prerelease ambiguity
numeric not satisfied            -> incompatible // unrelated to prereleases
```

Consequences worth checking against your implementation:

- `>=0.1.0-rc.5 <0.2.0` accepts `0.1.5-rc.2` — the comparators are prerelease-aware, so numeric evaluation is the right one. A literal `includePrerelease: false` call reports this healthy declaration as unsatisfied.
- `>=0.1.0-rc.5 <0.1.0-rc.7` rejects `0.1.5-rc.2` (out of the numeric bounds).
- `^0.0.1` rejects `0.1.5-rc.2`; it must not degrade to unknown just because the provided version carries a prerelease.
- `>=4.0.0` against `4.1.0-rc.1` is unknown, not satisfied and not incompatible.
- Partial comparators are valid: `<1`, `<5`, `>=4` must parse (fill missing segments with 0). Rejecting them turns healthy declarations into false `incompatible`.

## Tooling that implements this rule

| side | command | exit codes |
| --- | --- | --- |
| author | `node doctor.mjs --lint-peers .` | 0 all ranges cover the installed host; 1 at least one does not; 2 usage error or no DSH install found (never a silent pass) |
| consumer | `ciceroyang/peer_range` inside `doctor.mjs` | a `checks[]` entry; `fail` only when a range is incompatible |

Supporting artifacts:

- Ecosystem snapshot, refreshed weekly: https://github.com/ciceroyang/dsh-doctor/releases/tag/ecosystem-compat
- Scanner: `scripts/ecosystem-compat.mjs`
- Differential harness: `scripts/range-difftest.mjs --other <module.mjs> --corpus compat.json` — compares two implementations of this rule over a snapshot and prints the divergence patterns. Run it before claiming conformance; the first run against a second implementation found 58 divergences in 1639 declarations, all of them in the four corners above.

## Provenance

The rule was distilled in deepseek-ai/deepseek-harness#4792 and #6678. The prerelease combination was prompted by @moonquake2004's report that a literal strict-semver call misjudged healthy prerelease declarations; the resolution-order and symlink points came from inspecting a real `DSH_HOME`; the differential harness and the snapshot are by @ciceroyang. Corrections welcome as issues or PRs — the edge cases above are the whole test surface.
