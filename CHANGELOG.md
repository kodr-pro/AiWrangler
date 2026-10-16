# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-10-16

First npm release of `aiwrangler`.

### Added

- stdio MCP server (`aiwrangler-mcp`) and owner CLI (`aiwrangler`) published as npm binaries.
- `files`, `engines`, `repository`, and `keywords` metadata, and a `prepublishOnly` build.
- GitHub Actions release workflow that publishes on a `v*` tag with npm provenance (`NPM_TOKEN`).

### Changed

- License is Apache-2.0, copyright kodr-pro. Source previously carried GPL-3.0 and was not published to npm.
- The MCP server reports the version from `package.json`.
- `@opencode-ai/plugin` is an optional peer dependency, required only for the native opencode tools and watch plugin.
