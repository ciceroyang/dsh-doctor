# How a DSH web plugin is mounted, and the trap of a package that installs but never loads

*2026-09-17. Written after an install that reported success and produced nothing on the page.*

## Three moving parts

**1. The profile tree.** `$DSH_HOME/profiles/<name>/package.json` declares `dependencies` and
`dsh.profile.bundles` — the ordered stack of bundle layers. The tree is composed once at boot: each
bundle in that stack contributes its `cordis.patch.yml`, then the profile's own patch layer, then any
`--patch` overlay.

**2. The host mount.** A package is only reachable if a loader entry names it. A bundle contributes
entries through its patch file; the profile patch layer can also insert one by hand:

```yaml
- insert:
    - id: my-plugin
      name: my-plugin
```

**3. The browser half.** `@deepseek-ai/dsh-client-modules` scans the **live loader entries** for packages
whose manifest declares `dsh.client` with `platform: web`, resolves `exports["./client"]`, serves that
file at `/plugins/??<name>/client.js&rev=<hash>`, and composes `window.__DSH_BOOT__`. If the host half is
not mounted, the browser half is never even looked at.

## The trap

`dsh plugin add` reconciles the profile against the installed tree. A dependency that resolves to a
package **declaring `dsh.bundle`** joins the bundle stack, so its patch runs and its host half mounts.
A package that declares **only `dsh.client`** stays an ordinary dependency: it is installed, it appears
in `dependencies`, and it is never mounted. Nothing errors. The command exits 0. The page simply has no
such plugin in it.

Our own local profile carries a comment saying exactly this about a `dsh.client`-only package:

> only declares dsh.client (no bundle patch); `dsh plugin add` only installs it as an ordinary dependency
> and does not activate it; this insert line is what mounts it into the loader tree.

The fix for a plugin author is one file plus one manifest field:

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: my-plugin
```

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

A package may declare `dsh.bundle` and `dsh.client` at once. The bundle half mounts the host entry; the
client half then reaches the page. That combination is what makes `dsh plugin --profile web add
github:owner/repo#v1.2.3` a single command that actually does something.

## Preflight it without installing anything

`dsh-doctor --web-plugin <dir>` answers whether a package can be mounted, and why not:

| check | fails when |
| --- | --- |
| `plugin_manifest` | `package.json` is missing, unparseable, or has no `name` |
| `plugin_host_mount` | no `dsh.bundle.patch` (warn: the one-command install will not mount it), or the patch file is absent, or it inserts a different package name |
| `plugin_client_export` | `dsh.client.platform` is not `web`, or `exports["./client"]` is missing or points at no file |
| `plugin_client_bundle` | the bundle does not register exactly one loader entry, registers an id that differs from the package name, fails to materialize, exports no `apply(ctx)`, has a malformed `inject`, or requires a package that `dsh.client.external` does not declare |
| `plugin_npm_files` | `files` omits the patch file or the client bundle, so the published tarball cannot be mounted |

The bundle is executed in an isolated `node:vm` context whose only global is a `window.__ModuleLoader__`
stub. That proves two things at once: the artifact is valid, and it touches no browser global at
registration time.

```sh
node doctor.mjs --web-plugin /path/to/plugin
```

## Why the registered id must equal the package name

The composer builds the graph row from the package name (`id`), and the browser registers factories from
the `id` inside the bundle. Two independent sources for one identity. If they disagree, the graph names a
row that no factory answers, and the plugin fails the moment the page tries to materialize it. Our build
step reads `pkg.name` for exactly this reason, and `plugin_client_bundle` compares the two.

## Verifying without disturbing a running instance

A freshly added bundle does **not** hot-reload into a running `dsh web`. In the profile used for these
measurements the plugin was installed and listed in `dsh.profile.bundles`, yet the live server returned
**404** for its combo route while a plugin installed before boot returned 200 — the bundle stack is read
at boot, and `patchReload: live` applies to the patch file, not to the bundle list. Restart the server, or
boot a second instance, before concluding the plugin is broken.

Booting a second instance is the safe way to verify, and it is what produced the evidence below:

```sh
VH=/tmp/dsh-verify-home
mkdir -p "$VH/profiles"
cp ~/.dsh/settings.yaml "$VH/" 2>/dev/null || true
cp -a ~/.dsh/profiles/web "$VH/profiles/web"   # a real copy: hard links would write through

DSH_HOME="$VH" dsh web --port 3081 --no-open   # `dsh web` is already the profile alias

# token comes from the new process log; then:
#   - the page boot graph must list the plugin id
#   - /plugins/??<name>/client.js&rev=<rev> must return 200 and declare id: "<name>"
```

Do not restart the live server to test a plugin if the agent doing the testing lives inside that process.
The isolated copy costs a few seconds and one port.

## What the controls show

| package | shape | `--web-plugin` verdict |
| --- | --- | --- |
| three new plugins (`dsh-privacy-guard`, `dsh-prompt-library`, `dsh-followup-actions`) | `dsh.bundle` + `dsh.client` | all five checks pass; booted in an isolated instance, present in `__DSH_BOOT__`, bundle served with 200 |
| `dsh-report-studio` | `dsh.bundle` only | host mount passes, the two client checks skip |
| `dsh-peak-meter` | `dsh.client` only, mounted by a hand-written insert | host mount warns — which is what its README instructs |
| `@deepseek-ai/dsh-client-ui-llm-verifier` | `dsh.client` only, installed | host mount warns — matching the comment in the profile patch layer |

## Summary

Installing is not mounting, and mounting is not serving, and serving is not rendering. Each step has one
cheap check, and the first two are silent when they fail. If a plugin does not appear, ask in this order:
does the manifest declare `dsh.bundle`; does the patch insert the package name; did the server boot after
the install; does the bundle register the package name as its loader id.
