# AiWrangler

[![CI](https://github.com/kodr-pro/AiWrangler/actions/workflows/ci.yml/badge.svg)](https://github.com/kodr-pro/AiWrangler/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kodr%2Faiwrangler)](https://www.npmjs.com/package/@kodr/aiwrangler)

**Ground-truth guardrails for coding agents.**

AiWrangler sits beside your coding agent and judges its plans and diffs
against the documents that actually govern your project: your protocol
spec, your review rules, your divergence rulings, your open questions.
Deterministic checks run first and offline; Jev, the calibrated semantic
judge from [TypeSafe](https://typesafe.ai), handles everything regexes
cannot: whether the diff does what the task and summary claim, whether it
contradicts the spec, whether the plan takes a side in an unruled
disagreement. Every verdict cites its ground truth, and every decision is
written to an append-only audit ledger. Findings that touch secrets or
one-way doors come back `HUMAN REVIEW`. That verdict stays closed until a
person approves it in the editor, a desktop dialog, or a terminal. The
agent's tool arguments cannot approve it.

It is built for repos where "the agent said it passed" is not good enough.

## Quick start

The Jev semantic judge is the core of AiWrangler. Deterministic rules run
offline; Jev is what judges claims, scope, and contradictions against your
spec. Create a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys)
and export it:

```bash
export TYPESAFE_API_KEY=apikey_...
```

Without `TYPESAFE_API_KEY`, only the deterministic rules run. The semantic
judge stays off, and a check is marked degraded (`no-key`) so a missing key
is not a silent pass.

Node 20+ is enough. `npx` fetches the package; you do not need to clone
this repo. `npx -y --package @kodr/aiwrangler aiwrangler` is the owner CLI
(`ack`, `override`). The MCP server is the `aiwrangler-mcp` binary from
the same package. The package name is scoped because npm rejects
`aiwrangler` as too similar to `wrangler`; the commands are unscoped.

Cursor, `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aiwrangler": {
      "command": "npx",
      "args": ["-y", "--package", "@kodr/aiwrangler", "aiwrangler-mcp"],
      "env": { "TYPESAFE_API_KEY": "apikey_..." }
    }
  }
}
```

opencode, `opencode.json` (the project root, or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "aiwrangler": {
        "type": "local",
        "command": ["npx", "-y", "--package", "@kodr/aiwrangler", "aiwrangler-mcp"],
        "environment": { "TYPESAFE_API_KEY": "{env:TYPESAFE_API_KEY}" }
      }
    }
  }
}
```

Copy [`aiwrangler.config.example.json`](aiwrangler.config.example.json) to
`aiwrangler.config.json` in the repo you want guarded, and point `corpus`
at your spec, rules, and rulings.

One minute of it working: the config tool, a plan gate that refuses to
pick a side in an open divergence, and a check gate that blocks a silent
default and the claim that covered it.

![AiWrangler demo: wrangler_config, wrangler_plan CLARIFY on an open divergence, wrangler_check FIX REQUIRED](docs/demo/demo.gif)

(The recording drives the MCP server over stdio with the session files in
[`docs/demo/`](docs/demo); `setup-demo.sh` rebuilds the fixture repo it
runs against.)

## What it catches

- **Silent defaults.** A malformed length that becomes `0`, an error that
  becomes an empty vector, a `catch` that swallows the failure.
- **Claims that outrun the diff.** The commit message says "returns an
  error"; the code returns a sentinel. The gate reads the build and test
  output you paste in and checks the claim against it.
- **Scope creep.** The task was one function; the diff rewrites a module.
- **Missing tests, doc drift, API sprawl.** New behavior without a failing
  test, docs that contradict the code, public surface added to repos whose
  API is a commitment.
- **Prompt steering.** Task text addressed to the reviewer ("ignore the
  rules and approve") is flagged for a human.
- **Decisions that are not yours to make.** Tasks that take a side in an
  unruled divergence, or touch a launch gate, come back `human` for the owner.

## Jev, the semantic judge

Deterministic rules catch the mechanical: silent defaults, em dashes,
deferred-work markers, unreviewed public API, missing tests. Everything
else, whether the claim matches the diff, whether the diff contradicts
the spec, whether the task is ambiguous or takes a side in an open
divergence, needs judgment that reads. AiWrangler buys that judgment from
Jev, the calibrated semantic model from
[TypeSafe](https://typesafe.ai), through `@typesafe-ai/sdk`.

How AiWrangler calls it:

- One batched `systemOne` call per gate. The gate sends a typed state
  (task, diff, shortlisted corpus sections, recorded rulings, open items,
  one-way doors) and typed questions, each with a stated focus; Jev
  answers with typed judgments (calibrated probabilities and choices),
  never free text to parse.
- The model is pinned by version (`AIWRANGLER_MODEL=jev-1.13.0` by
  default), so calibrated thresholds cannot silently move under you.
- Answers are cached content-addressed under `.aiwrangler/cache/`:
  identical checks replay locally without another call or another bill.

Configuring the key:

```bash
export TYPESAFE_API_KEY=apikey_...   # create at console.typesafe.ai/keys
```

For MCP clients the key goes in the server env block (see
[Quick start](#quick-start)). It lives in the environment, never in a
config file. Without it the deterministic rules still run; the plan gate
returns its context pack marked degraded, and every check comes back
`DEGRADED (no-key)`. A missing key is never a silent pass.

What leaves the machine: task text, diff text, and corpus excerpts go to
`api.typesafe.ai`. A one-time warning prints before first use per
session, and `AIWRANGLER_EGRESS=off` is a deterministic-only, zero-egress
mode.

When Jev is slow or down:

| Jev state | Plan gate | Check gate |
|---|---|---|
| no key | degraded pass, context pack intact, reason `no-key` | `DEGRADED`, deterministic findings still listed |
| `AIWRANGLER_EGRESS=off` | same, reason `egress-off` | same |
| API error or timeout (60 s per call) | an error in place of a verdict; no blessing is issued | `DEGRADED` (`api-error`), deterministic findings still listed |
| slow | first call waits, up to the timeout | same; identical re-runs answer from the local cache |

The semantic layer fails open with an audible `DEGRADED` marker, never
silently, and the deterministic rules never stop running. Even a vacuous
check (nothing eligible to examine) returns `DEGRADED` rather than `PASS`.

## Evals

A seeded golden set plus mined clean history, run on every commit
(`npm run verify:p5`; live with a key, deterministic-only without).
Numbers from 2026-10-19 on the v0.1.0 tree, recorded in
[`evals/report.json`](evals/report.json):

| | live Jev | deterministic only |
|---|---|---|
| seeded catches | 9 of 9 | 9 of 9 |
| misses | 0 | 0 |
| false positives | 0 | 0 |
| clean diffs passed | 3 of 3 | 3 of 3 |
| mined clean history | 0 false positives on 3 merged commits | 0 on 3 |

The seeded set exercises the rule and claim batteries. The semantic layer
adds what only runs with a key: claim verification, spec contradiction,
comment truthfulness, and the plan-gate judgments; `verify:p2` requires a
task that takes a side in an open divergence to come back `CLARIFY`
(0.94 on the release tree), and a task implementing a ruled side to pass
carrying its ruling. Re-run everything with `npm test`.

## How it works

Three tools, one lifecycle:

| Tool | When the agent calls it | Result |
|---|---|---|
| `wrangler_config` | session start | effective config, gate flags, corpus summary |
| `wrangler_plan` | before writing code | `pass` / `clarify` / `human` + a cited context pack |
| `wrangler_check` | before declaring done | `PASS` / `FIX REQUIRED` / `HUMAN REVIEW` / `DEGRADED` |

The plan gate returns a ground-truth context pack (spec sections, recorded
rulings, one-way doors, open questions) the agent must honor while
implementing. The check gate returns a cited, actionable fix list; the
agent fixes, re-runs, and only then declares done. A retry circuit breaker
escalates when the same findings keep coming back.

All of it is written to an append-only ledger under `.aiwrangler/`.
`wrangler_ack` lists pending `HUMAN REVIEW` findings when called with no
write arguments. Passing rules asks the owner to acknowledge them.
`wrangler_override` reports active overrides, and passing `set` or `clear`
asks the owner to change them. In either case the arguments do not
authorize the write. The MCP server asks the client UI through MCP
elicitation (findings, rules, diff hash, and note). If that client has no
form elicitation, the server shows a native desktop dialog. The ledger
records which method the person used (`elicitation`, `os-dialog`, or
`tty`). Overrides expire on the next PASS, so strict is always the resting
state. `wrangler_loop_reset` still clears the retry breaker from the agent.

## Install

The published package is
[`@kodr/aiwrangler`](https://www.npmjs.com/package/@kodr/aiwrangler).
[Quick start](#quick-start) is the install path: a TypeSafe key, then `npx`.

A source checkout needs Node 20+ and, for whitepaper ingestion only,
`poppler-utils`:

```
git clone https://github.com/kodr-pro/AiWrangler.git
cd AiWrangler
npm install && npm run build
npm link
```

### opencode (native)

**OpenCode 2.x**: add the plugin package to `opencode.json` (global
`~/.config/opencode/opencode.json`, or the project's own):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "@kodr/aiwrangler" }]
}
```

The plugin is inert in repos without an `aiwrangler.config.json` (or
`AIWRANGLER_CONFIG`), and when `gates.session.nudge` is off. On session
completion it runs the deterministic gates against the dirty diff and
injects a fix-nudge into the session (fingerprint-deduped, capped at
`gates.session.maxNudges`, exactly one nudge per completion even when
several opencode locations are loaded. Its diagnostics land in
`<repo>/.aiwrangler/plugin.log`.

**OpenCode 1.x (legacy)**: make the package resolvable from the opencode
config dir (the `npm link` above covers it), then add two small files.
`~/.config/opencode/plugins/wrangler-watch.ts` re-exports the named export:

```ts
export { WranglerWatchPlugin } from "@kodr/aiwrangler/plugin"
```

`~/.config/opencode/tools/wrangler.ts` re-exports the native tools:

```ts
export { wrangler_config, wrangler_plan, wrangler_check, wrangler_ack, wrangler_override, wrangler_loop_reset } from "@kodr/aiwrangler/tools"
```

Restart opencode. The MCP server and the plugin compose and do not overlap:
MCP gives the tools on demand (`wrangler_config`, `wrangler_check`,
acknowledgements), and the plugin adds the automatic nudge loop at session
completion. `@opencode-ai/plugin` and `@opencode/plugin` are both optional
peer dependencies: the host provides the one it runs, and the MCP server
and the `aiwrangler` CLI load neither. Prefer the MCP server
inside opencode for approvals: it can show an elicitation form in the
editor. The 1.x native tools have no MCP session, so a write falls back
to a desktop dialog. Neither path treats the agent's arguments as a yes.

### Any MCP client (Cursor, Claude Code, Windsurf, ...)

`aiwrangler-mcp` is a stdio MCP server. Tools are `wrangler_config`,
`wrangler_plan`, `wrangler_check`, `wrangler_ack`, `wrangler_override`, and
`wrangler_loop_reset`. Ack and override list or report when called without
write arguments. A write argument asks the person through MCP elicitation,
then a desktop dialog if the client did not advertise form elicitation.
One server serves every workspace: each tool accepts an optional `dir`
argument (the workspace root), falling back to the server's startup
directory or `AIWRANGLER_DIR`.

Cursor and opencode configs are in [Quick start](#quick-start). The same
`npx` command works for Claude Code:

```
claude mcp add aiwrangler -- npx -y --package @kodr/aiwrangler aiwrangler-mcp
```

A source checkout can pass `node dist/mcp.js` instead of `npx`.

Pair it with a rule in your agent's instructions (e.g.
`~/.cursor/rules/aiwrangler.mdc`) that pins the lifecycle: call
`wrangler_config` at session start, `wrangler_plan` before writing code,
`wrangler_check` before declaring done, and stop on `HUMAN REVIEW`.

### Owner approval

A write happens only after a person accepts one of these channels. The
agent's tool arguments are never that acceptance.

1. **MCP elicitation** (Cursor, opencode MCP, and any client that advertises
   `elicitation.form`). The server sends `elicitation/create` with the
   findings, rules, diff hash, and note. The client UI shows Approve / Deny.
   The ledger records `confirmation: "elicitation"`. Decline, cancel, and an
   accepted form whose decision is Deny do not write. A client that
   advertises elicitation but then errors or times out also does not write,
   and does not fall through to the desktop dialog.
2. **Desktop dialog**, only when the client has no form elicitation.
   macOS uses `osascript`, Linux uses `zenity` then `kdialog` when a display
   is set, and Windows uses a PowerShell message box. The ledger records
   `confirmation: "os-dialog"`. `AIWRANGLER_OS_DIALOG=off` disables the
   dialog and fails closed. There is no localhost approval URL: the agent
   would see the token and could redeem it.
3. **Terminal**, `aiwrangler ack` / `aiwrangler override` after `npm link`.
   On a TTY the owner types `yes`. `--yes` is rejected and records nothing.
   A non-TTY refuses. The ledger records `by` / `source` `"cli"` and
   `confirmation: "tty"`.

```
aiwrangler ack --rules RULE-10 --note "rotation interval reviewed"
aiwrangler ack                          # list pending findings and the diff hash
aiwrangler override --set '{"gates":{"docDrift":false}}' --note "why"
aiwrangler override                     # report active overrides
aiwrangler override --clear
```

Acks bind to the diff hash, void when the diff changes, and never cover
block-severity findings. Overrides expire on the next PASS.
`wrangler_loop_reset` is still an agent tool: it clears the retry breaker
and does not approve findings or change gates. Verify with
`npm run verify:mcp` and `npm run verify:cli`.

Which client uses which path, checked against current docs:

| Client | Path |
|---|---|
| Cursor MCP | Elicitation is documented as supported ([Cursor MCP docs](https://cursor.com/docs/mcp)). The editor window is the reliable place to look. Forum reports still describe the Agents window hiding the form inside a collapsed tool row, failing to route it when several windows are open, and older Windows hangs. If the UI never answers, AiWrangler records nothing. |
| opencode MCP | v2 docs ([Input requests](https://opencode.ai/v2/docs/mcp-servers/)) say a server elicitation is shown as a form, and dismissing it cancels. The changelog records spec-compliant elicitation capabilities. An earlier release advertised `elicitation.form` and then ignored `elicitation/create` until timeout ([opencode#51856](https://github.com/anomalyco/opencode/issues/51856)); that hang fails closed here. |
| opencode native tools | No MCP session, so the desktop dialog is the only in-editor-adjacent path. |
| No elicitation and no desktop | The write is refused. The owner uses the TTY CLI. |

### Any other harness

The gates are a plain TypeScript library, so any agent, editor, or CI can
use them:

```ts
import { loadConfig, loadCorpus, runCheck } from "@kodr/aiwrangler"
```

## Configure a repository

1. Copy [`aiwrangler.config.example.json`](aiwrangler.config.example.json)
   to `aiwrangler.config.json` in the repository you want guarded.
2. Point its `corpus` block at your ground-truth documents. Missing files
   are skipped, so you can start with just a spec and grow from there.
3. Add the MCP server (or opencode tools) to your agent, and pin the
   lifecycle in its instructions: `wrangler_config` at session start,
   `wrangler_plan` before code, `wrangler_check` before done.

## Ground truth

AiWrangler is only as good as the documents it enforces. It reads plain
Markdown you already own:

- a **protocol spec** (numbered sections, optionally linked to paper
  chapters)
- **review rules** (the standards every diff is held to)
- a **divergence register** (recorded rulings are the effective truth;
  open divergences block tasks from taking a side)
- **open questions** (answered ones become rulings; open ones escalate)
- a **plan** with one-way doors and launch gates
- a **whitepaper** PDF, ingested once and cached

Precedence: ruled divergences and answered questions override the paper;
the paper overrides the derived spec and rules. Unruled divergences never
silently win; they are themselves flag-worthy.

A small synthetic corpus lives in [`evals/corpus/`](evals/corpus) as a
working example and format reference.

## Security posture

- The MCP server is local stdio only: no port, no token, no approval URL.
  Tool arguments never authorize an ack or an override. A write requires
  MCP elicitation accepted in the client UI, a native desktop dialog, or
  the owner typing `yes` at the CLI. The ledger records which one. `--yes`
  does not authorize a write.
- That is not a proof against a hostile client or a hostile desktop. A
  client that auto-accepts elicitation, or lets the model fill the form,
  defeats the prompt: AiWrangler trusts the client to put the form in front
  of a person. An agent that can click the desktop dialog, or that can
  allocate a PTY and type `yes` at `aiwrangler`, can still approve. Those
  paths are recorded as `os-dialog` and `tty`. `AIWRANGLER_OS_DIALOG=off`
  only disables the dialog; it cannot approve.
- The semantic judge is pinned to a versioned model, so calibrated
  thresholds cannot silently move. Its one-time egress warning (task, diff,
  and spec text goes to `api.typesafe.ai`) surfaces before first use; set
  `AIWRANGLER_EGRESS=off` for a deterministic-only, zero-egress mode.
- Secrets stay in the environment (`TYPESAFE_API_KEY`). The ledger and
  cache are local files under `.aiwrangler/` and contain your diff text.
  The server does not listen on a port.
- Reporting and the full trust model: [SECURITY.md](SECURITY.md). Issues
  use the [issue templates](.github/ISSUE_TEMPLATE); questions go to
  Discussions.

## Configuration

`aiwrangler.config.json` (JSONC, schema-validated) is discovered from the
working directory upward, else `~/.config/aiwrangler/`. Every check is a
gate flag, all default on. Key blocks: `model`, `policies` (thresholds),
`egress`, `corpus`, `gates`, `repos` (workspace layout for
multi-repo projects).

Precedence for effective config: **env vars > runtime overrides
(owner command `aiwrangler override`) > config file > defaults**.

```
AIWRANGLER_CONFIG=/path/to/config.json
AIWRANGLER_POLICY=strict|permissive
AIWRANGLER_EGRESS=off          # deterministic only, zero egress
AIWRANGLER_DISABLE=docDrift,ambiguity
AIWRANGLER_ENABLE=docDrift
AIWRANGLER_MODEL=jev-1.13.0
```

## State on disk (`<repo>/.aiwrangler/`)

| File | Meaning |
|---|---|
| `ledger.jsonl` | append-only audit log of every gate run, finding, verdict, ack, and override, including `confirmation` of `elicitation`, `os-dialog`, or `tty` |
| `loop-state.json` | circuit-breaker cycles |
| `diffs/<hash>.txt` | capped snapshot of the exact diff each check judged |
| `cache/` | content-addressed semantic answers (replay without re-billing) |
| `runtime-overrides.json` | active runtime overrides, if any (auto-expire on PASS) |
| `watch-state.json` | session-nudge loop state: last diff fingerprint, nudge count, green announcement |
| `plugin.log` | tail-truncated diagnostics from the opencode nudge plugin |

## Development

```
npm run build        # library, owner CLI, and MCP server bundles
npm run typecheck
npm test             # verify:p0–p4, verify:mcp, verify:cli, and verify:plugin (what CI gates on)
npm run verify:p0    # config, corpus parsing, hash stability
npm run verify:mcp   # MCP handshake; mock client accepts and declines elicitation
npm run verify:cli   # TTY confirmation, --yes refusal, injected desktop dialog, diff-hash binding
npm run verify:plugin # built dual entrypoint: V1 named export + V2 default export
```

`verify:p1` through `verify:p4` cover rule detection, the plan gate, the
semantic battery, and the tool surface. `verify:p5` is the seeded golden-set
eval: it exits non-zero while recall is below 1, so CI runs it for the log
and does not gate on it. All of them run against the fixture corpus in
`evals/corpus/` and need no private state. `npm test` expects a prior
`npm run build` (`verify:p4`, `verify:mcp`, and `verify:cli` execute the bundles in `dist/`).
Live semantic checks activate automatically when `TYPESAFE_API_KEY` is set.

## License

Apache-2.0. Copyright 2026 kodr-pro. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
