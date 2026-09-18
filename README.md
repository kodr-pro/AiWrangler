# AiWrangler

**Ground-truth guardrails for coding agents.**

AiWrangler sits beside your coding agent and judges its plans and diffs
against the documents that actually govern your project: your protocol
spec, your review rules, your divergence rulings, your open questions.
Deterministic checks run first and offline; a calibrated semantic judge
handles everything regexes cannot. Every verdict cites its ground truth,
every decision is written to an append-only audit ledger, and anything
touching secrets or one-way doors stops for a human.

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
  unruled divergence, or touch a launch gate, stop at the owner.

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

All of it is written to an append-only ledger under `.aiwrangler/`, and the
included dashboard turns that ledger into a live view with control:
acknowledge human reviews against the exact diff, toggle gates, adjust
thresholds, reset the breaker. Overrides expire on the next PASS, so strict
is always the resting state.

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
export { wrangler_config, wrangler_plan, wrangler_check } from "aiwrangler/tools"
```

`~/.config/opencode/plugins/wrangler-watch.ts`:

```ts
export { WranglerWatchPlugin } from "aiwrangler/plugin"
```

Restart opencode. The tools appear in every session, and the plugin nudges
the agent to run the gates at the right moments.

### Any other harness

The gates are a plain TypeScript library and the dashboard is a standalone
server, so any agent, editor, or CI can use them:

```ts
import { loadConfig, loadCorpus, runCheck } from "aiwrangler"
```

```
aiwrangler-webui /path/to/your/repo --open
```

## Quick start

1. Copy [`aiwrangler.config.example.json`](aiwrangler.config.example.json)
   to `aiwrangler.config.json` in the repository you want guarded.
2. Point its `corpus` block at your ground-truth documents. Missing files
   are skipped, so you can start with just a spec and grow from there.
3. Start the dashboard from the guarded repo:

```
aiwrangler-webui --open
```

It prints a URL with a token (`http://127.0.0.1:4478/?token=...`), opens
the dashboard, and live-follows every gate decision. The server and your
agent share nothing but the `.aiwrangler/` files.

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

- The dashboard is localhost-only by default, bearer-token auth on every
  route (timing-safe compare), no CDN or external assets, strict CSP.
- The semantic judge is pinned to a versioned model, so calibrated
  thresholds cannot silently move. Its one-time egress warning (task, diff,
  and spec text goes to `api.typesafe.ai`) surfaces before first use; set
  `AIWRANGLER_EGRESS=off` for a deterministic-only, zero-egress mode.
- Secrets stay in the environment (`TYPESAFE_API_KEY`). The ledger and
  cache contain your diff text; keep the bind address local.

## Configuration

`aiwrangler.config.json` (JSONC, schema-validated) is discovered from the
working directory upward, else `~/.config/aiwrangler/`. Every check is a
gate flag, all default on. Key blocks: `model`, `policies` (thresholds),
`egress`, `corpus`, `gates`, `webui`, `repos` (workspace layout for
multi-repo projects).

Precedence for effective config: **env vars > runtime overrides
(dashboard) > config file > defaults**.

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
| `ledger.jsonl` | append-only audit log of every gate run, finding, verdict, and override |
| `loop-state.json` | circuit-breaker cycles |
| `diffs/<hash>.txt` | capped snapshot of the exact diff each check judged |
| `cache/` | content-addressed semantic answers (replay without re-billing) |
| `runtime-overrides.json` | active dashboard overrides, if any (auto-expire on PASS) |
| `webui-token` | dashboard auth token |

## Development

```
npm run build        # library + dashboard bundle
npm run typecheck    # node + browser tsconfigs
npm run verify:p0    # config, corpus parsing, hash stability
npm run verify:webui # acks, override expiry, ledger fields
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
