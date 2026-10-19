# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on
`github.com/kodr-pro/AiWrangler` (Report a security vulnerability). Do not
open a public issue for a suspected vulnerability. The maintainer
acknowledges reports within 7 days.

Supported: the current release line and `main`.

## Trust model

- The MCP server is local stdio. It does not listen on a port, serve HTTP,
  or accept network connections.
- Tool arguments never authorize an ack or an override. A write requires a
  person through MCP elicitation, a native desktop dialog, or a TTY
  confirmation; the ledger records which one. `--yes` is rejected by design
  and a non-TTY refuses.
- This is not a proof against a hostile client or a hostile desktop. A
  client that auto-accepts elicitation, or that lets the model fill the
  form, defeats the prompt: AiWrangler trusts the client to put the form in
  front of a person. `AIWRANGLER_OS_DIALOG=off` disables the dialog path
  (fail closed); it cannot approve anything.

## Data egress

Deterministic checks run offline. The semantic judge (Jev, through
`@typesafe-ai/sdk`) sends task text, diff text, and corpus excerpts to
`api.typesafe.ai` using `TYPESAFE_API_KEY` from the environment. A one-time
warning is printed before first use per session. For a deterministic-only,
zero-egress mode:

```
AIWRANGLER_EGRESS=off
```

A missing key, egress off, or an API failure downgrades the check verdict
to `DEGRADED` (deterministic findings only, with the reason recorded); it
never silently becomes a clean `PASS`.

## Secrets and local state

- `TYPESAFE_API_KEY` lives in the environment, never in a config file.
- `aiwrangler.config.json`, the append-only ledger, diff snapshots, and the
  semantic cache under `.aiwrangler/` are local files and contain your diff
  text. Keep `.aiwrangler/` and any private `aiwrangler.config.json` out of
  version control.
