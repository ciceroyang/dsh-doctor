# dsh-doctor/v1 Contract — vocabulary r5 (FROZEN) + v1.1 addendum

Canonical record of the community contract settled in
deepseek-harness discussion #1719. Frozen 2026-08-16 with three conforming
implementations: ciceroyang/dsh-doctor, moonquake2004/dsh-doctor, dsh-win32.

## Envelope

```json
{
  "schema": "dsh-doctor/v1",
  "generatedAt": "2026-08-16T00:00:00.000Z",
  "profile": "/path/to/dsh-home",
  "exitCode": 0,
  "summary": { "pass": 9, "warn": 1, "fail": 0, "skip": 0 },
  "ok": true,
  "checks": [ { "name": "node", "status": "pass", "detail": "..." } ]
}
```

## Status literals

`pass | warn | fail | skip` (lowercase; the former `ok` literal is retired —
the top-level boolean stays `ok`).

- `skip` REQUIRES a reason in `detail`; counts as neither pass nor fail.
- `summary.skip` is always present (0 when unused).
- `ok` = no fail.

## Exit codes (CLI entry point only)

0 all-pass / 1 any warn / 2 any fail. The codes are a property of a direct
`doctor` invocation, NOT of running the checks; embedded callers (installers,
setup commands) decide their own policy. Adopting the codes is a breaking
change: ship it in a minor bump with a release note; consumers gate on exit 2
and treat exit 1 as informational.

## Core check-name vocabulary

Each entry is a four-tuple (name, semantic, status, provenance).

| name | semantic | status | provenance |
|---|---|---|---|
| `node` | Node against the repo-declared engines `^22.19.0 || >=24.0.0` | pass in range; warn otherwise (npm EBADENGINE semantics; no hard-fail tier) | root package.json; #2259 pending manifest propagation |
| `pnpm` | pnpm availability | pass present; warn missing (corepack-recoverable) | - |
| `dsh` | dsh executable on PATH | pass; warn npx-only | - |
| `ds_home` | DSH_HOME exists + settings.yaml writable | pass; warn settings missing; fail not writable | #1027 |
| `profiles` | profile manifests parse | pass; warn app-less profile (boot hang) / corrupt entries | #964, #2321 |
| `sessions` | session logs enumerable | pass; warn missing/unreadable | - |
| `log_health` | zstd container structure + decodeability (multi-frame scan + decode) | pass; fail bad frames / decode failure | #1043 |
| `dedupe` | critical packages single-copy (cordis/dsh-tools/dsh-skill) | pass; fail multi-copy | #1849 |
| `port` | default port availability | pass free; warn occupied | - |

## Rules

1. Unvocabularized checks keep vendor-prefixed local ids until nominated.
2. New names enter through the four-tuple; CI asserts on name + status only —
   `detail` stays free text.
3. `schema` remains `"dsh-doctor/v1"`; vocabulary amendments do not bump it.

## v1.1 addendum: optional envelope field `remediation` (ADOPTED, three +1s)

- opt-in only: emitted with an explicit flag (`--json --envelope --remediation`); frozen r5 consumers never see it
- an array of lines `"[check-name] free text"` — the key is the exact `checks[].name` value up to the first `]`; the parse rule is a BOUNDARY, not a charset: `/^\[([^\]]+)\] /`. `]` is the only character a check name may not contain.
- the body after the space is free text (language not pinned); consumers must not parse past the boundary
- aggregation: warn/fail subset only, in check order; per-check fix text (where an implementation carries it, field name implementation-local, e.g. `fix`, or inline in `detail`) is NOT assumed to exist
- provenance: ciceroyang/dsh-doctor 0.5.2 (proposal); moonquake2004/dsh-doctor, dsh-win32 (review)

## History & attribution

Drafted by @ciceroyang (ciceroyang/dsh-doctor); reviewed by @sjh9714 (dsh-win32)
and @moonquake2004 (moonquake2004/dsh-doctor). Thread: discussion #1719.
Envelope foundation: @zoahdev's original design. The `skip` status and the
"exit codes are CLI-scoped" rule originated from @sjh9714's shipping report.
The v1.1 remediation field came from ciceroyang/dsh-doctor 0.5.1's human-mode
fix suggestions, generalized with moonquake2004's keyed-boundary refinement
and sjh9714's boundary-not-charset correction.
