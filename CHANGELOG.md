# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
