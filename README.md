# AiWrangler

**Ground-truth guardrails for coding agents.**

AiWrangler sits beside your coding agent and judges its plans and diffs
against the documents that actually govern your project: your protocol
spec, your review rules, your divergence rulings, your open questions.
Deterministic checks run first and offline; a calibrated semantic judge
handles everything regexes cannot. Every verdict cites its ground truth,
and every decision is written to an append-only audit ledger. Findings
that touch secrets or one-way doors come back `HUMAN REVIEW`. That verdict
stays closed until the owner runs `aiwrangler ack` outside the agent.
The agent can list what is pending; it cannot approve it.

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
The agent also has two read-only tools: `wrangler_ack` lists pending
`HUMAN REVIEW` findings and the diff hash, and `wrangler_override` reports
active runtime overrides. Neither tool can approve a finding or change a
gate. The owner does that with the `aiwrangler` CLI (`aiwrangler ack`,
`aiwrangler override`), which confirms on a TTY and records that
provenance in the ledger. Overrides expire on the next PASS, so strict is
always the resting state. `wrangler_loop_reset` still clears the retry
breaker from the agent.

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
the agent to run the gates at the right moments. `wrangler_ack` and
`wrangler_override` are list and report only. Approving a `HUMAN REVIEW`
or changing gates is `aiwrangler ack` / `aiwrangler override` in a
terminal, not an opencode tool.

### Any MCP client (Cursor, Claude Code, Windsurf, ...)

`aiwrangler-mcp` is a stdio MCP server. Agent tools are `wrangler_config`,
`wrangler_plan`, `wrangler_check`, read-only `wrangler_ack` (list pending
human findings), read-only `wrangler_override` (report overrides), and
`wrangler_loop_reset`. One server serves every workspace: each tool
accepts an optional `dir` argument (the workspace root), falling back to
the server's startup directory or `AIWRANGLER_DIR`.

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

### Owner commands (`aiwrangler`)

Approving a `HUMAN REVIEW` and changing gates are not agent tools. After
`npm link`, the owner runs them in a terminal:

```
aiwrangler ack --rules RULE-10 --note "rotation interval reviewed"
aiwrangler ack                          # list pending findings and the diff hash
aiwrangler override --set '{"gates":{"docDrift":false}}' --note "why"
aiwrangler override                     # report active overrides
aiwrangler override --clear
```

When stdin is a TTY, the command prints what it is about to record and
writes only after the owner types `yes`. When stdin is not a TTY, it
refuses unless the owner passes `--yes`. The ledger records `by: "cli"`
on acks and `source: "cli"` on overrides, plus `confirmation` of `tty` or
`yes-flag`. Acks are bound to the diff hash, void on any diff change, and
block-severity findings are never ackable. Overrides auto-expire on the
next PASS.

Passing `rules`, `note`, or `diffHash` to the MCP or opencode
`wrangler_ack` tool, or `set` / `clear` / `note` to `wrangler_override`,
is rejected and writes nothing. `wrangler_loop_reset` is still an agent
tool: it clears the retry breaker and does not approve findings or change
gates. Verify with `npm run verify:mcp` and `npm run verify:cli`.

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

- The MCP server is local stdio only: no port, no token surface. It cannot
  acknowledge `HUMAN REVIEW` findings or change gates. Those writes happen
  only through the `aiwrangler` CLI, which requires a TTY confirmation or
  an explicit owner `--yes`, and the ledger records which one. A
  shell-capable agent can still invoke the CLI with `--yes`; that path is
  recorded as `confirmation: "yes-flag"`, distinct from a terminal prompt
  (`tty`). It is not an MCP or opencode tool, and those tools refuse the
  same request.
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
| `ledger.jsonl` | append-only audit log of every gate run, finding, verdict, ack, and override, including CLI confirmation provenance |
| `loop-state.json` | circuit-breaker cycles |
| `diffs/<hash>.txt` | capped snapshot of the exact diff each check judged |
| `cache/` | content-addressed semantic answers (replay without re-billing) |
| `runtime-overrides.json` | active runtime overrides, if any (auto-expire on PASS) |

## Development

```
npm run build        # library, owner CLI, and MCP server bundles
npm run typecheck
npm run verify:p0    # config, corpus parsing, hash stability
npm run verify:mcp   # MCP handshake; ack and override writes are refused
npm run verify:cli   # owner CLI ack/override, TTY and --yes provenance, diff-hash binding
```

`verify:p1` through `verify:p5` cover rule detection, the plan gate, the
semantic battery, the tool surface, and the seeded golden set; they run
against the fixture corpus in `evals/corpus/` and need no private state.
Live semantic checks activate automatically when `TYPESAFE_API_KEY` is set.

## Support

If AiWrangler catches something your review would have missed, you can buy
the author a coffee:

```
EVM: 0xa8F045c97BaB4AEF16B5e2d84DE16f581D1C7654
```

## License

GPL-3.0. See [LICENSE](LICENSE).
