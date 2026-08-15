# dsh-doctor

One-command health check for DeepSeek Harness local environments. A zero-dependency implementation of the community-requested "dsh doctor" idea (official Discussions #1719).

## Usage

    npx github:ciceroyang/dsh-doctor
    node doctor.mjs --json

## Checks

- node version (>=18 usable; >=22.15 required for historical session-log reading)
- pnpm presence (dsh plugin depends on it)
- dsh on PATH
- DSH_HOME / settings.yaml existence and writability (with sudo-ownership hint)
- profile manifest integrity (per-profile bundle counts, corrupt ones flagged)
- session log count (multi-frame zstd health)
- built-in zstd availability
- port 3080 availability

Every check reports ok / warn / fail with an actionable fix.

## Quick answers doctor encodes

- pnpm not found on PATH → npm i -g pnpm (mirror for restricted networks)
- "cannot save confirmation state" toast → settings.yaml not writable, fix ownership
- plugin tree failed to load → locate the entry via --dump-config, verify with a manual node import
- historical sessions unreadable → Node < 22.15 has no built-in zstd

## References

- Proposal: official Discussions #1719
- Field guide with real pitfalls: https://github.com/ciceroyang/dsh-report-studio/blob/main/docs/tutorial-zh.md
