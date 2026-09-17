# dsh-doctor

One-command health check for DeepSeek Harness local environments. A zero-dependency implementation of the community-requested "dsh doctor" idea (official Discussions #1719).

> Status: usable. See [Releases](https://github.com/ciceroyang/dsh-doctor/releases) for the current version. This is an independent community tool for the DeepSeek Harness developer preview; interfaces may change.

## Usage

    npx github:ciceroyang/dsh-doctor
    node doctor.mjs --json                    # checks array
    node doctor.mjs --json --envelope         # dsh-doctor/v1 envelope (community contract)
    node doctor.mjs --profile <dir>           # target a specific DSH_HOME/directory
    node doctor.mjs --all-logs                # scan every session log (default samples the newest 3)
    node doctor.mjs --strict-peer             # treat an undeclared plugin peer range as a warning
    node doctor.mjs --lint-peers [dir]        # check THIS package's own @deepseek-ai/* peer ranges (exit 1 on mismatch)
    node doctor.mjs --candidate-peer <patch>   # pre-flight a proposed patch against a profile (no writes)
    node doctor.mjs --web-plugin <dir>          # pre-flight a plugin package for mountability (no install)

## Lint your own declaration in CI

`--lint-peers` is the author-side half of `ciceroyang/peer_range`: it reads the current package's `@deepseek-ai/*` peer declarations and compares them against the host versions provided by a DSH install.

```yaml
- run: npm install -g @deepseek-ai/dsh
- run: node doctor.mjs --lint-peers .
```

Exit codes: `0` every declared range covers the installed host; `1` at least one does not; `2` usage error **or no DSH install was found** — it never passes silently when there is nothing to compare against. `*` declarations are reported as wildcards, not as passes.

The rule itself is written down in [docs/host-peer-declarations.md](docs/host-peer-declarations.md): resolution order, the three states, and the prerelease combination that decides whether an implementation is usable on prerelease hosts.

A snapshot of how the whole ecosystem scores on this is published as a rolling release; see the next section.

## Ecosystem snapshot

`scripts/ecosystem-compat.mjs` reads a plugin directory's repository list, fetches each repository root `package.json`, and scores every `@deepseek-ai/*` peer declaration against the host versions a DSH install provides. A weekly workflow runs it and publishes the result as a rolling release:

- JSON: `https://github.com/ciceroyang/dsh-doctor/releases/download/ecosystem-compat/compat.json`
- Markdown summary: `https://github.com/ciceroyang/dsh-doctor/releases/download/ecosystem-compat/compat-summary.md`

Run it against any source list:

```sh
node scripts/ecosystem-compat.mjs --source <url-or-file> --out compat.json --summary compat-summary.md
```

First manual run (2026-09-15, the community directory's 503 repositories): 305 declare at least one host peer, 41 declare at least one range that excludes the installed host, and 162 declare no host range at all.

## Pre-flight a patch (`candidate`, v1.2 draft)

`--candidate-peer <patch.yml> --profile <profileDir>` judges the tree a proposed patch *would* produce, without applying it. It implements the declaration-focused subset of the v1.2 `candidate` draft (deepseek-ai/deepseek-harness#1719):

| check | fails when |
| --- | --- |
| `candidate-insert-collision` | an inserted id already exists in the current tree (warn) |
| `candidate-module-installed` | an inserted package is absent from the resulting tree (fail) |
| `candidate-peer-range` | an inserted package's `@deepseek-ai/*` range excludes the host it would get (fail) |

## Pre-flight a plugin package (`--web-plugin`)

`--web-plugin <dir>` answers the question a plugin author asks one minute after `dsh plugin add` seems to work: **will this package actually show up in the web UI?** Nothing is installed or written.

It exists because of a trap that is easy to hit. A package that declares only `dsh.client` is installed by `dsh plugin add` but never mounted, because the profile only layers packages that declare `dsh.bundle`. Our own local profile carries a comment about `@deepseek-ai/dsh-client-ui-llm-verifier` saying exactly that; the first run of this check reproduced it.

| check | fails when |
| --- | --- |
| `plugin_manifest` | `package.json` is missing or unparseable, or has no `name` |
| `plugin_host_mount` | no `dsh.bundle.patch` (warn: the one-command install will not mount it), or the patch file is missing, or it inserts a different package name |
| `plugin_client_export` | `dsh.client.platform` is not `web`, or `exports["./client"]` is missing or points at a nonexistent file |
| `plugin_client_bundle` | the bundle does not register exactly one loader entry, registers an id that differs from the package name, fails to materialize, exports no `apply(ctx)`, has a malformed `inject`, or requires a package that `dsh.client.external` does not declare |
| `plugin_npm_files` | `files` omits the patch file or the client bundle, so the published tarball cannot be mounted |

The bundle is executed in an isolated `node:vm` context whose only global is a `window.__ModuleLoader__` stub. That proves two things at once: the artifact is valid, and it does not reach for a browser global at registration time.

Exit code is 1 when any check fails, 0 otherwise; `--json` prints the same checks as data.

The full mechanism — installing vs mounting vs serving, why a `dsh.client`-only package stays invisible, and how to verify in an isolated second instance — is in [docs/web-plugin-mounting.md](docs/web-plugin-mounting.md).

`--json` emits the envelope with `mode: "candidate"`; the default envelope never carries that field. This mode performs **no mutation**: quarantine/rollback belongs to the installer that owns the write, and the output says so.

## Community contract (dsh-doctor/v1)

Aligned with the zoahdev and moonquake2004 implementations (official discussion #1719):
- envelope: `{ schema, generatedAt, profile, exitCode, summary{pass,warn,fail}, ok, checks:[{name,status,detail}] }`
- status literals: `pass` / `warn` / `fail` / `skip` (r5; the `ok` literal is retired, the top-level boolean stays `ok`)
- exit codes: 0 all-pass / 1 any warn / 2 any fail (CLI entry point only, see #1719 r4/r5)
- check-name vocabulary (v1.1 draft, see #1719): `node` / `pnpm` / `dsh` / `ds_home` / `profiles` / `sessions` / `log_health` / `dedupe` / `port` — this implementation already uses the core names
- the `node` threshold aligns with the repo-declared engines (`^22.19.0 || >=24.0.0`, root package.json); #2259 asks to propagate it into the published manifests
- vocabulary r5 compatible — drafted by @ciceroyang (this repo), reviewed by @sjh9714 (dsh-win32) and @moonquake2004
- the full frozen spec lives at [docs/contract-v1.md](docs/contract-v1.md) (English) / [docs/contract-v1.zh.md](docs/contract-v1.zh.md) (中文)

## Checks

- node version (>=18 usable; >=22.15 required for historical session-log reading)
- pnpm presence (dsh plugin depends on it)
- dsh on PATH
- DSH_HOME / settings.yaml existence and writability (with sudo-ownership hint)
- profile manifest integrity (per-profile bundle counts, corrupt ones flagged)
- session log count (multi-frame zstd health)
- built-in zstd availability
- port 3080 availability
- duplicate critical packages (multiple dsh-tools/dsh-skill/cordis copies = tool-scheduling crash risk, #1849)
- session-log health sampling (multi-frame zstd frame scan + full decode — the differentiating check), including the #6651 first-frame condition (the first frame must be exactly one `session` header line; violating it decodes fine but blocks `dsh web` startup and empties session listings). `--all-logs` scans the whole store instead of the newest 3, so a single blocked log cannot hide outside the sample
- plugin-package pre-flight (`--web-plugin`): whether a package can be mounted by a web profile at all — `dsh.bundle` host mount, `exports["./client"]`, the bundle's registered loader id against the package name, declared `dsh.client.external` dependencies, and npm `files` coverage. Written after a real trap (a `dsh.client`-only package is installed by `dsh plugin add` and never activated); the first run on our own three plugins and on `@deepseek-ai/dsh-client-ui-llm-verifier` reproduced it exactly
- installed-plugin compatibility (`ciceroyang/peer_range`, vendor-local id per contract rule 1): for every plugin in a profile's `dependencies`, compares its declared `@deepseek-ai/*` peer ranges against the host versions actually present on disk — offline. Three states: compatible / incompatible / unknown (wildcard, undeclared, unparseable, or prerelease-ambiguous); unknown is shown as unknown and never as compatible, and `--strict-peer` escalates it to a warning. The offline half of the plugin-x-harness question from #4792

Every check reports ok / warn / fail with an actionable fix.

## Quick answers doctor encodes

- pnpm not found on PATH → npm i -g pnpm (mirror for restricted networks)
- "cannot save confirmation state" toast → settings.yaml not writable, fix ownership
- plugin tree failed to load → locate the entry via --dump-config, verify with a manual node import
- historical sessions unreadable → Node < 22.15 has no built-in zstd

## References

- Proposal: official Discussions #1719
- Field guide with real pitfalls: https://github.com/ciceroyang/dsh-report-studio/blob/main/docs/tutorial-zh.md
