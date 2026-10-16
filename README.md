# AiWrangler

[![CI](https://github.com/kodr-pro/AiWrangler/actions/workflows/ci.yml/badge.svg)](https://github.com/kodr-pro/AiWrangler/actions/workflows/ci.yml)

**Ground-truth guardrails for coding agents.**

AiWrangler sits beside your coding agent and judges its plans and diffs
against the documents that actually govern your project: your protocol
spec, your review rules, your divergence rulings, your open questions.
Deterministic checks run first and offline; a calibrated semantic judge
handles everything regexes cannot. Every verdict cites its ground truth,
and every decision is written to an append-only audit ledger. Findings
that touch secrets or one-way doors come back `HUMAN REVIEW`. That verdict
stays closed until a person approves it in the editor, a desktop dialog,
or a terminal. The agent's tool arguments cannot approve it.

It is built for repos where "the agent said it passed" is not good enough.

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

Requires Node 20+ and, for whitepaper ingestion only, `poppler-utils`.

```
git clone https://github.com/kodr-pro/AiWrangler.git
cd AiWrangler
npm install && npm run build
npm link
```

### opencode (native)

Make the package resolvable from the opencode config dir (the `npm link`
above covers it), then add two small files:

`~/.config/opencode/tools/wrangler.ts`:

```ts
export { wrangler_config, wrangler_plan, wrangler_check, wrangler_ack, wrangler_override, wrangler_loop_reset } from "aiwrangler/tools"
```

`~/.config/opencode/plugins/wrangler-watch.ts`:

```ts
export { WranglerWatchPlugin } from "aiwrangler/plugin"
```

Restart opencode. The tools appear in every session, and the plugin nudges
the agent to run the gates at the right moments. Prefer the MCP server
inside opencode for approvals: it can show an elicitation form in the
editor. The native tools above have no MCP session, so a write falls back
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

Cursor, global MCP config: (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "aiwrangler": { "command": "node", "args": ["/path/to/AiWrangler/dist/mcp.js"] }
  }
}
```

or: `cursor mcp add --global aiwrangler -- node /path/to/AiWrangler/dist/mcp.js`

Claude Code:

```
claude mcp add aiwrangler -- node /path/to/AiWrangler/dist/mcp.js
```

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
import { loadConfig, loadCorpus, runCheck } from "aiwrangler"
```

## Quick start

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

## Development

```
npm run build        # library, owner CLI, and MCP server bundles
npm run typecheck
npm test             # verify:p0–p4, verify:mcp, and verify:cli (what CI gates on)
npm run verify:p0    # config, corpus parsing, hash stability
npm run verify:mcp   # MCP handshake; mock client accepts and declines elicitation
npm run verify:cli   # TTY confirmation, --yes refusal, injected desktop dialog, diff-hash binding
```

`verify:p1` through `verify:p4` cover rule detection, the plan gate, the
semantic battery, and the tool surface. `verify:p5` is the seeded golden-set
eval: it exits non-zero while recall is below 1, so CI runs it for the log
and does not gate on it. All of them run against the fixture corpus in
`evals/corpus/` and need no private state. `npm test` expects a prior
`npm run build` (`verify:p4`, `verify:mcp`, and `verify:cli` execute the bundles in `dist/`).
Live semantic checks activate automatically when `TYPESAFE_API_KEY` is set.

## Support

If AiWrangler catches something your review would have missed, you can buy
the author a coffee:

```
EVM: 0xa8F045c97BaB4AEF16B5e2d84DE16f581D1C7654
```

## License

GPL-3.0. See [LICENSE](LICENSE).
