# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.5 - 2026-10-24

### Security

- Updated transitive dependencies pulled in by `@modelcontextprotocol/sdk`:
  `body-parser` 2.3.0 -> 2.4.0 (via express) and `fast-uri` 3.1.8 -> 3.1.9
  (via ajv), clearing both advisories. Neither is reachable through the
  stdio transport this package ships; this is supply-chain hygiene so
  downstream `npm audit` runs stay clean.

## 0.1.4 - 2026-10-20

### Fixed

- The per-repo plugin trail (`<repo>/.aiwrangler/plugin.log`) is written
  again: the V2 plugin host's `console.error` can throw, and the logger
  called it before the file append inside one try block, so a guarded
  console suppressed the durable log entirely (sweeps, state, and nudges
  were unaffected). The file append now runs first and the console attempt
  is separately guarded.

## 0.1.3 - 2026-10-20

### Fixed

- OpenCode V2 package plugins load again: opencode resolves a
  `{"package": "@kodr/aiwrangler"}` entry through the package's `./server`
  export, falling back to the root. 0.1.2 exposed neither, so the plugin
  failed with "Plugin must export a default definition with an id and an
  effect or setup function". The package now maps `./server` (and keeps
  `./plugin`) at the plugin entry.
- The V2 definition no longer needs `@opencode/plugin` at runtime. opencode's
  package-plugin cache installs the package without optional peers, so
  `Plugin.define` (an identity function in 2.1.1) now falls back to
  pass-through when the SDK is absent; the default export always carries
  `id`/`setup` plus the V1 `server()` bridge. The V1 named export is
  unchanged.
- `verify:plugin` asserts the `./server` export mapping and the default
  export's `id`/`setup` unconditionally.

## 0.1.2 - 2026-10-20

### Added

- OpenCode V2 plugin entrypoint. `@kodr/aiwrangler/plugin` now default-exports
  a V2 plugin (id `aiwrangler.nudge`) alongside the unchanged V1 named export
  `WranglerWatchPlugin`: add `@kodr/aiwrangler` to the `plugins` array in
  `opencode.json`. On session completion (`session.execution.succeeded`, with
  V1's `session.idle` kept as a deduped fallback) it runs the deterministic
  gates against the dirty diff and nudges the session to fix blocking
  findings (fingerprint-deduped, capped at `gates.session.maxNudges`, one
  nudge per completion even with multiple opencode locations loaded
  (single-actor lease on plugin storage). Session directories come from the
  event's location, and diagnostics go to `<repo>/.aiwrangler/plugin.log`.
  The V2 half activates only when `@opencode/plugin` resolves; V1 installs
  keep working unchanged.
- `runDeterministic`, `formatFindings`, and `diffFingerprint` are now exported
  from the package root (previously internal, forcing external consumers to
  import from `src/` paths).
- `verify:plugin` (part of `npm test`) asserts the built dual entrypoint:
  V1 named export, V2 `id`/`setup`, and the `server()` bridge.

### Changed

- `@opencode/plugin` (>=2.1.1) is an optional peer dependency, like
  `@opencode-ai/plugin`: neither host SDK is required at install time.

## 0.1.1 - 2026-10-19

### Added

- README demo recording (`docs/demo/demo.gif`): config, a plan gate that
  escalates a task taking a side in an open divergence, and a check gate
  that blocks a silent default and the claim that covered it. Rendered
  with the published package; the tape and session files ship alongside.
- Clean-machine install verified on a virgin node:20 container: owner CLI
  via npx, Cursor config shape, and Claude Code 2.1.197 reporting the
  server Connected.

## 0.1.0 - 2026-10-16

First npm release of `aiwrangler`, published as `@kodr/aiwrangler`.

### Added

- stdio MCP server (`aiwrangler-mcp`) and owner CLI (`aiwrangler`) published as npm binaries.
- `files`, `engines`, `repository`, and `keywords` metadata, and a `prepublishOnly` build.
- The package publishes as `@kodr/aiwrangler`: npm's name-similarity policy
  rejects an unscoped `aiwrangler` as too close to `wrangler`. The binaries
  are unscoped (`aiwrangler`, `aiwrangler-mcp`), and bin paths carry no
  `./` prefix, which npm v12 flags as invalid and drops from the manifest.
- GitHub Actions release workflow that publishes on a `v*` tag through npm
  trusted publishing (OIDC, no long-lived token; provenance automatic).
  0.1.0 was bootstrapped with a one-time interactive local publish because
  a trusted publisher can only be attached to an existing package; the
  workflow skips versions already on npm, so re-tagging stays green.
- `SECURITY.md` and GitHub issue templates.
- README: a Jev section (call shape, key configuration, slow and down
  behavior), an eval table, and a reproducible MCP-over-stdio demo under
  `docs/demo/` (session files, setup script, vhs tape).

### Changed

- License is Apache-2.0, copyright kodr-pro. Source previously carried GPL-3.0 and was not published to npm.
- The MCP server reports the version from `package.json`.
- `verify:p2` no longer expects escalation for a task that implements the ruled
  side of divergence D-1 (MuSig2 is the recorded ruling); it now asserts
  pass-with-ruling-context and adds a check that a task taking a side in the
  open D-3 divergence is escalated.
- `@opencode-ai/plugin` is an optional peer dependency, required only for the native opencode tools and watch plugin.
