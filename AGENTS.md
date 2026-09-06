# AGENTS.md

Single-file opencode plugin (`suspend-inhibit.ts`) that keeps `gnome-session-inhibit` alive
(bound to a finite lease) while any opencode session is busy, so GNOME does not suspend the
machine during long agent runs.

## Commands

- Typecheck: `bun run typecheck` (tsc `--noEmit`, strict).
- Smoke test: `bun test/suspend-inhibit.test.ts` — run as a plain script, **not** `bun test <file>`
  (the file has no `test()` cases, so the bun test runner would fail it).
- Runtime is Bun 1.x only (uses `Bun.spawn`, `Bun.which`, `Bun.$`; `tsconfig` types = `["bun-types"]`).
  No Node runtime support; keep new code on Bun APIs.

## The test is a live GNOME-session test

`test/suspend-inhibit.test.ts` drives the plugin with synthetic events and asserts against the
**real running GNOME session**: it spawns actual `gnome-session-inhibit` entries (visible in
`gnome-session-inhibit -l`) and waits for lease expiry. Prerequisites: a logged-in GNOME session
with `gnome-session-inhibit` on PATH. It cannot pass headless, in CI, or over SSH without a
session bus. It takes ~15–20s and uses a short `leaseSeconds` (8) plus a distinctive reason
(`opencode-suspend-inhibit-selftest`) so its entries are identifiable.

## Plugin shape and loading (hard-won gotchas)

- Written to the **V1 legacy API**: default-export `async (input, options) => Hooks` returning
  `{ event, dispose }`. Do not convert to the V2 `{ id, effect }` shape: the V2 context has no
  event hooks or client.
- Import of `@opencode-ai/plugin` is **type-only** (`import type`), so the plugin has zero runtime
  dependencies — no npm install is needed to deploy it.
- Modern opencode builds' `plugins/`-dir auto-discovery only accepts V2 plugin modules and
  **silently drops V1 function plugins** (`ConfigExternalPlugin` decodes a strict module shape and
  `Effect.ignoreCause` swallows failures). This plugin therefore only loads when referenced in the
  `plugin` config field as a `file://` URL of the `.ts` file, e.g.
  `"plugin": ["file:///…/suspend-inhibit.ts"]`. Deployment is expected via home-manager (the
  global `opencode.json` is a read-only nix-store symlink; the user-owned `opencode.jsonc` next to
  it is the editable global override).
- Startup must stay non-blocking: seeding from `client.session.status({})` is fire-and-forget with
  a 3s timeout. An `await` on it during plugin init hangs opencode startup indefinitely (the
  in-process status call can stall before the server listens). Keep it that way.
- Under `opencode run` the plugin is loaded **twice** (two instances → two identical inhibitors).
  This is harmless and intentional; do not attempt cross-instance dedup.

## Behavior contract

- `event` hook tracks `session.status` (`busy`/`retry` → inhibit, `idle` → release) and the
  deprecated `session.idle` event.
- Each inhibitor runs `gnome-session-inhibit --app-id opencode --reason <reason> --inhibit
  <actions> sleep <leaseSeconds>` (default lease 120s) and is renewed every lease/2 while busy;
  when idle, renewals stop and the lease expires by itself — this is the crash-safety mechanism.
- GNOME ≥3.32 CLI takes the command positionally; older builds require `--command`. Detection is
  via `gnome-session-inhibit --help`.
- Options come from the config tuple form (actions/reason/leaseSeconds); env overrides:
  `OPENCODE_SUSPEND_INHIBIT_ACTIONS`, `OPENCODE_SUSPEND_INHIBIT_REASON`. Options beat env.

## Repo state

Git repo is freshly initialized with **no commits** and **no `.gitignore`** — `node_modules/` and
`bun.lock` are untracked. Do not commit `node_modules/` unless a `.gitignore` is added first.