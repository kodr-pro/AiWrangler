import { render } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import { html } from "htm/preact"
import {
  api,
  apiText,
  getToken,
  type GateEntry,
  type StatusResponse,
  type CacheListResponse,
  type CacheEntryResponse,
  type CorpusResponse,
  type LoopResponse,
  type AnswerValue,
} from "./api.js"

type Tab = "overview" | "activity" | "control" | "reference"

/* ---------------------------------------------------------------- plain English */

const RULE_EXPLAIN: Record<string, string> = {
  "RULE-10": "This change touches keys, seals, digests, or disclosure. House policy: a person must read it before it merges, even if it looks correct.",
  SEVERITY: "If this code is wrong, the damage lands on consensus, execution, state, or trust paths: serious blast radius.",
  "RULE-1": "Somewhere, bad input quietly becomes a default value instead of an error. Failures should be loud.",
  "RULE-2": "New public API in a reviewed repo. The public surface is a commitment; it needs an enumerated-surface argument.",
  "RULE-3": "The agent claimed the code does something the diff does not visibly do.",
  "RULE-4": "A trust boundary slip: code acts on an unvalidated claim that arrived from outside.",
  "RULE-5": "An error message does not name the thing that failed.",
  "RULE-6": "House style violation (em dash, AI trailer, or a relative path into a sibling repo).",
  "RULE-7": "A deferred-work marker with no named backend: nobody is accountable for resolving it.",
  "RULE-8": "New behavior shipped without a test that would catch it breaking.",
  SCOPE: "The diff does things the task never asked for.",
  INJECT: "Possible prompt steering: the diff contains text addressed to the AI reviewer. Inspect before trusting the other verdicts.",
  HALLUC: "A comment describes behavior the code does not have.",
  SELFREPORT: "The agent's status claims contradict the actual build/test output.",
}

const VERDICT_EXPLAIN: Record<string, string> = {
  in_scope: "everything the diff adds is required by the task",
  silent_default: "no silent defaults hide parse/validation failures",
  trust_boundary: "external claims are validated before use",
  diff_steering: "no text aimed at the AI reviewer",
  error_names_culprit: "every new error names what failed",
  doc_comments_truthful: "comments match the code",
  test_exercises_behavior: "the new tests exercise the new behavior",
  self_report_matches: "status claims match the tool output",
  retry_progress: "this attempt responds to earlier findings",
  input_steering: "the task text is genuine work, not reviewer-directed",
  task_covered: "the corpus governs this task",
  amb_failure_behavior: "the task states what happens on failure",
  amb_acceptance: "the task has a checkable done-condition",
  amb_boundary: "the task bounds where the change applies",
  severity: "damage blast radius if the code is wrong (0 none … 3 severe)",
}

const VERDICT_LABEL: Record<string, string> = {
  in_scope: "in scope",
  silent_default: "no silent defaults",
  trust_boundary: "trust boundary held",
  diff_steering: "no steering text",
  error_names_culprit: "errors name the culprit",
  doc_comments_truthful: "comments truthful",
  test_exercises_behavior: "tests exercise behavior",
  self_report_matches: "status claims match output",
  retry_progress: "attempt addresses findings",
  input_steering: "task is genuine work",
  task_covered: "corpus covers task",
  amb_failure_behavior: "failure behavior stated",
  amb_acceptance: "done-condition stated",
  amb_boundary: "change boundary stated",
}

/* statements where a HIGH value is the good outcome; others: low is bad */
const HIGH_IS_GOOD = new Set([
  "in_scope",
  "silent_default",
  "trust_boundary",
  "diff_steering",
  "input_steering",
  "doc_comments_truthful",
  "error_names_culprit",
  "test_exercises_behavior",
  "self_report_matches",
  "retry_progress",
  "task_covered",
  "amb_failure_behavior",
  "amb_acceptance",
  "amb_boundary",
])

const SEVERITY_ORDER: Record<string, number> = { human: 0, block: 1, review: 2 }

function explainRule(rule: string): string {
  return RULE_EXPLAIN[rule] ?? "flagged by the ground-truth corpus; see the cited section for the requirement."
}

function relTime(ts: string): string {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function timeShort(ts: string): string {
  return ts.replace("T", " ").slice(5, 19)
}

function shortHash(h: string | undefined): string {
  return h ? h.slice(0, 10) : "-"
}

/* ---------------------------------------------------------------- shared bits */

function Chip({ kind, children }: { kind: string; children: preact.ComponentChildren }): preact.VNode {
  return html`<span class="chip ${kind}">${children}</span>`
}

function actionChip(action: string): preact.VNode {
  const map: Record<string, string> = { pass: "pass", fix: "work", human: "human", degraded: "muted", clarify: "work" }
  return html`<${Chip} kind=${map[action] ?? "info"}>${action}<//>`
}

function Bar({ value, label, explain, highIsGood }: { value: number; label: string; explain?: string; highIsGood: boolean }): preact.VNode {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  const risk = highIsGood ? 1 - value : value
  const color = risk >= 0.7 ? "var(--bad)" : risk >= 0.45 ? "var(--warn)" : "var(--ok)"
  return html`<div class="bar-row" title=${explain ?? ""}>
    <span class="bar-label">${label}</span>
    <div class="bar"><div class="bar-fill" style=${{ width: `${pct}%`, background: color }} /></div>
    <span class="bar-val">${value.toFixed(2)}</span>
  </div>`
}

/* ---------------------------------------------------------------- state derivation */

interface Derived {
  latestCheck: GateEntry | null
  level: "attention" | "acked" | "clear" | "work" | "unverified" | "idle"
  attention: LedgerFindingView[]
  ackForLatest: { ts: string; rules: string[]; note?: string } | null
}

interface LedgerFindingView {
  rule: string
  severity: string
  subject: string
  acknowledged?: boolean
}

function derive(entries: GateEntry[], acks: { ts: string; diffHash: string; rules: string[]; note?: string }[]): Derived {
  const checks = entries.filter((e) => e.kind === "check")
  const latestCheck = checks[0] ?? null
  const ackForLatest =
    latestCheck?.diffHash ? acks.filter((a) => a.diffHash === latestCheck.diffHash).slice(-1)[0] ?? null : null
  if (!latestCheck) return { latestCheck: null, level: "idle", attention: [], ackForLatest: null }
  const attention = (latestCheck.findings ?? [])
    .filter((f) => f.severity === "human" && !f.acknowledged)
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
  if (latestCheck.action === "human" && attention.length > 0) {
    return { latestCheck, level: ackForLatest ? "acked" : "attention", attention, ackForLatest }
  }
  if (latestCheck.action === "pass") return { latestCheck, level: "clear", attention, ackForLatest }
  if (latestCheck.action === "fix") return { latestCheck, level: "work", attention, ackForLatest }
  return { latestCheck, level: "unverified", attention, ackForLatest }
}

/* ---------------------------------------------------------------- app shell */

function App(): preact.VNode {
  const [tab, setTab] = useState<Tab>("overview")
  const [connected, setConnected] = useState(false)
  const [tick, setTick] = useState(0)
  const [tokenOk, setTokenOk] = useState<boolean | null>(null)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [entries, setEntries] = useState<GateEntry[]>([])
  const [loopData, setLoopData] = useState<LoopResponse | null>(null)
  const bump = useRef<number | null>(null)

  useEffect(() => {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`)
    source.onopen = () => {
      setConnected(true)
      setTokenOk(true)
    }
    source.onerror = () => setConnected(false)
    source.onmessage = () => {
      if (bump.current !== null) return
      bump.current = window.setTimeout(() => {
        bump.current = null
        setTick((t) => t + 1)
      }, 400)
    }
    return () => source.close()
  }, [])

  useEffect(() => {
    Promise.all([api<StatusResponse>("/api/status"), api<{ entries: GateEntry[] }>("/api/ledger?limit=200"), api<LoopResponse>("/api/loop")])
      .then(([s, l, lo]) => {
        setStatus(s)
        setEntries(l.entries)
        setLoopData(lo)
        setTokenOk(true)
      })
      .catch((err) => {
        if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 401) setTokenOk(false)
      })
  }, [tick])

  const refresh = () => setTick((t) => t + 1)
  const d = useMemo(() => derive(entries, loopData?.acks ?? []), [entries, loopData])

  if (tokenOk === false) {
    return html`<div class="wrap"><div class="error-box">
      unauthorized: open the dashboard using the URL printed by <code>aiwrangler-webui</code> (it carries the token).
    </div></div>`
  }

  const cycles = status?.loop.cycles?.length ?? 0
  const maxCycles = status?.loop.maxCycles ?? 3
  const breakerOpen = cycles >= maxCycles

  return html`<div class="wrap">
    <header>
      <span class="brand">aiwrangler</span>
      <span class="muted">gate control panel</span>
      <span class="spacer"></span>
      ${status ? html`<${Chip} kind="info">policy ${status.config.activePolicy}${status.config.overridesActive ? " (overridden)" : ""}<//>` : null}
      ${status ? html`<${Chip} kind=${status.config.egressSemantic ? "warnchip" : "muted"}>semantic ${status.config.egressSemantic ? "on" : "off"}<//>` : null}
      ${cycles > 0 ? html`<${Chip} kind=${breakerOpen ? "human" : "info"}>retry ${cycles}/${maxCycles}<//>` : null}
      <span class="dot ${connected ? "on" : "off"}" title=${connected ? "live" : "disconnected"}></span>
    </header>

    ${d.level === "attention"
      ? html`<div class="hero attention">
          <div class="hero-main">${d.attention.length} finding${d.attention.length === 1 ? "" : "s"} need your eyes before this change can proceed</div>
          <div class="hero-sub">the gates routed the last check to human review: review the flagged lines below, then acknowledge</div>
        </div>`
      : null}
    ${d.level === "acked"
      ? html`<div class="hero acked">
          <div class="hero-main">acknowledged: waiting for the agent's next wrangler_check</div>
          <div class="hero-sub">you acknowledged this diff at ${timeShort(d.ackForLatest!.ts)}; the next check on this exact diff will pass. any edit voids the ack.</div>
        </div>`
      : null}
    ${d.level === "clear"
      ? html`<div class="hero clear">
          <div class="hero-main">all clear</div>
          <div class="hero-sub">last verified ${relTime(d.latestCheck!.ts)}: ${d.latestCheck!.examinedFiles ?? "?"} file(s) examined by the semantic battery</div>
        </div>`
      : null}
    ${d.level === "work"
      ? html`<div class="hero work">
          <div class="hero-main">fixes in progress</div>
          <div class="hero-sub">the agent's last check cited ${(d.latestCheck!.findings ?? []).length} finding(s) it must fix: nothing for you to do yet</div>
        </div>`
      : null}
    ${d.level === "unverified"
      ? html`<div class="hero unverified">
          <div class="hero-main">unverified</div>
          <div class="hero-sub">${(d.latestCheck!.reasons ?? ["the semantic layer could not run"])[0]}</div>
        </div>`
      : null}
    ${d.level === "idle"
      ? html`<div class="hero idle">
          <div class="hero-main">no checks recorded yet</div>
          <div class="hero-sub">the gates run when the agent calls wrangler_check: this panel will light up then</div>
        </div>`
      : null}
    ${breakerOpen
      ? html`<div class="hero breaker">
          <div class="hero-main">circuit breaker open: the agent has been told to stop retrying</div>
          <div class="hero-sub row">${(status?.loop.cycles ?? []).slice(-1)[0]?.topReasons.join(" · ")} <button onClick=${() => doAction("/api/loop/reset", { method: "POST" }, refresh)}>reset loop state</button></div>
        </div>`
      : null}

    <nav>
      ${(["overview", "activity", "control", "reference"] as Tab[]).map(
        (t) => html`<button class=${tab === t ? "active" : ""} onClick=${() => setTab(t)}>${t}</button>`,
      )}
    </nav>
    <main>
      ${tab === "overview" ? html`<${Overview} d=${d} loopData=${loopData} onAct=${refresh} />` : null}
      ${tab === "activity" ? html`<${Activity} entries=${entries} />` : null}
      ${tab === "control" ? html`<${ControlView} status=${status} onAct=${refresh} />` : null}
      ${tab === "reference" ? html`<${Reference} />` : null}
    </main>
    <footer>
      ${status ? html`dirty: ${status.dirty.length} file(s) · config: ${status.config.source} · corpus ${shortHash(status.corpus.hash)} · model ${status.config.model}` : "loading…"}
    </footer>
  </div>`
}

async function doAction(path: string, init: RequestInit, onDone: () => void, onMsg?: (m: string) => void): Promise<void> {
  try {
    await api(path, init)
    onMsg?.("done")
    onDone()
  } catch (err) {
    onMsg?.(`error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/* ---------------------------------------------------------------- overview */

function Overview({
  d,
  loopData,
  onAct,
}: {
  d: Derived
  loopData: LoopResponse | null
  onAct: () => void
}): preact.VNode {
  const latest = d.latestCheck
  return html`<div class="stack">
    ${d.level === "attention" ? html`<${AckPanel} latest=${latest} attention=${d.attention} onAct=${onAct} />` : null}

    ${latest ? html`<div class="card">
      <div class="card-title row spread"><span>last check</span><span class="row">${actionChip(latest.action!)} <span class="muted">${relTime(latest.ts)}</span></span></div>
      <div class="stat-row">
        <div class="stat"><div class="stat-val">${timeShort(latest.ts)}</div><div class="stat-key">when</div></div>
        <div class="stat"><div class="stat-val mono">${latest.sessionID ? latest.sessionID.slice(0, 14) : "-"}</div><div class="stat-key">session</div></div>
        <div class="stat"><div class="stat-val">${latest.examinedFiles ?? "-"}</div><div class="stat-key">files examined</div></div>
        <div class="stat"><div class="stat-val">${(latest.files ?? []).reduce((n, f) => n + f.added, 0)}</div><div class="stat-key">lines added</div></div>
        <div class="stat"><div class="stat-val">${latest.usage ? `${latest.usage.inputTokens}/${latest.usage.outputTokens}` : "-"}</div><div class="stat-key">tokens in/out</div></div>
        <div class="stat"><div class="stat-val">${latest.overridesActive ? "yes" : "no"}</div><div class="stat-key">overrides active</div></div>
      </div>
      ${latest.reasons && latest.reasons.length > 0
        ? html`<ul class="reasons">${latest.reasons.map((r) => html`<li>${r}</li>`)}</ul>`
        : null}
      ${(latest.files ?? []).length > 0
        ? html`<details><summary>${(latest.files ?? []).length} changed file(s): what the gates judged</summary>
            <ul class="files">${(latest.files ?? []).map((f) => html`<li class="mono">${f.repo}/${f.path} <span class="muted">+${f.added}/-${f.removed}</span></li>`)}</ul>
          </details>`
        : null}
    </div>` : null}

    ${latest && (latest.findings ?? []).length > 0
      ? html`<div class="card">
          <div class="card-title">all findings on the last check</div>
          ${(latest.findings ?? [])
            .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
            .map((f) => html`<${FindingRow} f=${f} latest=${latest} />`)}
        </div>`
      : null}

    ${latest && latest.verdicts && latest.verdicts.length > 0
      ? html`<div class="card">
          <div class="card-title">semantic verdicts <span class="muted">- the judge's probability for each statement; red = risk direction</span></div>
          ${latest.verdicts
            .filter((v) => !v.question.startsWith("claim_verifiable"))
            .map((v) =>
              v.question === "severity"
                ? html`<div class="bar-row" title=${VERDICT_EXPLAIN.severity}><span class="bar-label">blast radius if wrong</span><div class="bar"><div class="bar-fill sev" style=${{ width: `${Math.round((v.noul / 3) * 100)}%` }} /></div><span class="bar-val">${v.noul.toFixed(2)}/3</span></div>`
                : html`<${Bar} value=${v.noul} label=${VERDICT_LABEL[v.question] ?? v.question} explain=${VERDICT_EXPLAIN[v.question] ?? ""} highIsGood=${HIGH_IS_GOOD.has(v.question)} />`,
            )}
        </div>`
      : null}

    ${latest?.diffHash
      ? html`<${DiffViewer} entry=${latest} />`
      : null}

    ${(loopData?.acks ?? []).length > 0
      ? html`<div class="card"><div class="card-title">recent acknowledgements</div>
          <table><tbody>${(loopData?.acks ?? []).slice(-5).reverse().map(
            (a) => html`<tr><td>${relTime(a.ts)}</td><td class="mono">${shortHash(a.diffHash)}</td><td>${a.rules.join(", ")}</td><td class="muted">${a.note ?? ""}</td></tr>`,
          )}</tbody></table>
        </div>`
      : null}
  </div>`
}

function FindingRow({ f, latest }: { f: LedgerFindingView; latest: GateEntry | null }): preact.VNode {
  const [open, setOpen] = useState(false)
  const sevClass = f.severity === "human" ? "human" : f.severity === "block" ? "work" : "muted"
  return html`<div class="finding sev-${f.severity}">
    <div class="row spread">
      <div class="row">
        <${Chip} kind=${sevClass}>${f.severity}<//>
        <span class="mono rule">${f.rule}</span>
        <span class="mono subj">${f.subject}</span>
        ${f.acknowledged ? html`<${Chip} kind="pass">acknowledged<//>` : null}
      </div>
      <button class="ghost" onClick=${() => setOpen(!open)}>${open ? "hide" : "explain"}</button>
    </div>
    ${open
      ? html`<div class="finding-detail">
          <p>${explainRule(f.rule)}</p>
          ${latest?.diffHash && f.subject.includes(":") && !f.subject.startsWith("(")
            ? html`<${JumpLink} diffHash=${latest.diffHash} subject=${f.subject} />`
            : null}
        </div>`
      : null}
  </div>`
}

function JumpLink({ diffHash, subject }: { diffHash: string; subject: string }): preact.VNode {
  const [msg, setMsg] = useState("")
  return html`<button class="ghost" onClick=${() => {
    setMsg("opening snapshot…")
    window.dispatchEvent(new CustomEvent("wrangler:jump", { detail: { diffHash, subject } }))
    setMsg("")
  }}>view in judged diff</button>${msg ? html`<span class="muted"> ${msg}</span>` : null}`
}

/* ---------------------------------------------------------------- ack panel */

function AckPanel({ latest, attention, onAct }: { latest: GateEntry | null; attention: LedgerFindingView[]; onAct: () => void }): preact.VNode {
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(attention.map((f) => [`${f.rule}|${f.subject}`, true])),
  )
  const [note, setNote] = useState("")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelected(Object.fromEntries(attention.map((f) => [`${f.rule}|${f.subject}`, true])))
  }, [attention])

  const submit = () => {
    if (!latest?.diffHash) return
    const rules = [...new Set(attention.filter((f) => selected[`${f.rule}|${f.subject}`]).map((f) => f.rule))]
    if (rules.length === 0) {
      setMsg("select at least one finding")
      return
    }
    setBusy(true)
    api("/api/ack", { method: "POST", body: JSON.stringify({ diffHash: latest.diffHash, rules, ...(note ? { note } : {}) }) })
      .then(() => {
        setMsg("acknowledged: the agent's next wrangler_check on this exact diff will pass")
        setNote("")
        onAct()
      })
      .catch((err) => setMsg(`error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false))
  }

  return html`<div class="card attention-card">
    <div class="card-title">needs your eyes <span class="muted">- review each item, untick anything you want to keep blocking, then acknowledge</span></div>
    <div class="stack-s">
      ${attention.map((f) => {
        const key = `${f.rule}|${f.subject}`
        return html`<label class="check finding-pick">
          <input type="checkbox" checked=${selected[key] !== false} onChange=${(e: Event) => setSelected({ ...selected, [key]: (e.target as HTMLInputElement).checked })} />
          <span class="mono rule">${f.rule}</span>
          <span class="mono subj">${f.subject}</span>
          <span class="muted plain">${explainRule(f.rule)}</span>
        </label>`
      })}
    </div>
    <div class="row ack-controls">
      <input type="text" class="grow" value=${note} onInput=${(e: Event) => setNote((e.target as HTMLInputElement).value)} placeholder="optional note for the audit trail (what did you review?)" />
      <button class="primary" disabled=${busy} onClick=${submit}>${busy ? "recording…" : "acknowledge reviewed"}</button>
    </div>
    ${msg ? html`<p class="${msg.startsWith("error") ? "err" : "okmsg"}">${msg}</p>` : null}
    <p class="hint">acks apply to this exact diff (${shortHash(latest?.diffHash)}); any edit voids them; block-severity findings can never be acked</p>
  </div>`
}

/* ---------------------------------------------------------------- diff viewer with jump */

interface SnapshotSection {
  repo: string
  path: string
  lines: { n: number | null; text: string }[]
}

function parseSnapshot(text: string): SnapshotSection[] {
  const sections: SnapshotSection[] = []
  let current: SnapshotSection | null = null
  for (const line of text.split("\n")) {
    const head = line.match(/^## (\S+) (\S+) /)
    if (head) {
      current = { repo: head[1]!, path: head[2]!, lines: [] }
      sections.push(current)
      continue
    }
    if (!current) continue
    const add = line.match(/^\+(\d+)\| ?(.*)$/)
    if (add) current.lines.push({ n: Number(add[1]), text: add[2] ?? "" })
    else current.lines.push({ n: null, text: line })
  }
  return sections
}

function DiffViewer({ entry }: { entry: GateEntry }): preact.VNode {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [jump, setJump] = useState<{ repo: string; path: string; line: number } | null>(null)

  useEffect(() => {
    apiText(`/api/diffs/${entry.diffHash}`)
      .then(setSnapshot)
      .catch(() => setSnapshot(null))
  }, [entry.diffHash])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ diffHash: string; subject: string }>).detail
      setOpen(true)
      const m = detail.subject.match(/^([^/]+)\/(.*):(\d+)$/)
      if (m) setJump({ repo: m[1]!, path: m[2]!, line: Number(m[3]!) })
      else setJump(null)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const el = boxRef.current?.querySelector(".jump-target")
          el?.scrollIntoView({ block: "center", behavior: "smooth" })
        }),
      )
    }
    window.addEventListener("wrangler:jump", handler)
    return () => window.removeEventListener("wrangler:jump", handler)
  }, [])

  if (snapshot === null) return html`<div class="card"><p class="hint">no diff snapshot stored for this entry</p></div>`

  const sections = parseSnapshot(snapshot)

  return html`<div class="card">
    <div class="card-title row spread">
      <span>judged diff <span class="mono muted">${shortHash(entry.diffHash)}</span></span>
      <button class="ghost" onClick=${() => setOpen(!open)}>${open ? "collapse" : `show (${Math.round(snapshot.length / 1024)} KB)`}</button>
    </div>
    ${open
      ? html`<div class="snapshot" ref=${boxRef}>
          ${sections.map((s) => {
            const isActive = jump && s.repo === jump.repo && s.path === jump.path
            return html`<div class="snap-file">
              <div class="snap-head mono">${s.repo}/${s.path}</div>
              ${s.lines.map((l, i) =>
                l.n !== null && isActive && jump && l.n === jump.line
                  ? html`<div class="snap-line add jump-target" key=${i}>+${l.n}| ${l.text}</div>`
                  : l.n !== null
                    ? html`<div class="snap-line add" key=${i}>+${l.n}| ${l.text}</div>`
                    : html`<div class="snap-line ctx" key=${i}>${l.text}</div>`,
              )}
            </div>`
          })}
        </div>`
      : null}
  </div>`
}

/* ---------------------------------------------------------------- activity */

function Activity({ entries }: { entries: GateEntry[] }): preact.VNode {
  const [selected, setSelected] = useState<GateEntry | null>(null)
  return html`<div class="split">
    <div class="pane">
      <table>
        <thead><tr><th></th><th>when</th><th>kind</th><th>outcome</th><th>summary</th></tr></thead>
        <tbody>
          ${entries.map((e) => {
            const summary =
              e.kind === "check"
                ? `${(e.findings ?? []).filter((f) => !f.acknowledged).length} finding(s) · ${e.examinedFiles ?? "?"} examined${e.overridesActive ? " · OVERRIDES" : ""}`
                : e.kind === "notice"
                  ? (e.message ?? "").slice(0, 60)
                  : e.kind === "override"
                    ? Object.keys(e.changes ?? {}).join(",") || "cleared"
                    : e.kind === "ack"
                      ? `rules: ${(e.rules ?? []).join(", ")}`
                      : `${(e.findings ?? []).length} finding(s)`
            return html`<tr class=${selected === e ? "sel" : ""} onClick=${() => setSelected(e)}>
              <td>${e.action ? actionChip(e.action) : html`<${Chip} kind="muted">${e.kind}<//>`}</td>
              <td title=${e.ts}>${relTime(e.ts)}</td>
              <td>${e.kind}</td>
              <td>${e.action ?? "-"}</td>
              <td class="summary">${summary}</td>
            </tr>`
          })}
        </tbody>
      </table>
    </div>
    <div class="pane">${selected ? html`<${EntryDetail} entry=${selected} />` : html`<p class="hint">select an entry to inspect it</p>`}</div>
  </div>`
}

function EntryDetail({ entry }: { entry: GateEntry }): preact.VNode {
  return html`<div>
    <h3>${entry.kind} · ${entry.action ?? ""} <span class="muted">${timeShort(entry.ts)}</span></h3>
    ${entry.message ? html`<p class="notice">${entry.message}</p>` : null}
    ${entry.kind === "override" ? html`<pre class="pre">${JSON.stringify(entry.changes ?? {}, null, 2)}</pre>` : null}
    ${entry.kind === "ack" ? html`<p>ack <span class="mono">${shortHash(entry.diffHash)}</span>: rules ${(entry.rules ?? []).join(", ")}</p>` : null}
    ${entry.reasons && entry.reasons.length > 0 ? html`<h4>reasons</h4><ul class="reasons">${entry.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : null}
    ${(entry.findings ?? []).length > 0
      ? html`<h4>findings</h4>${(entry.findings ?? [])
          .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
          .map((f) => html`<div class="finding sev-${f.severity}"><div class="row"><${Chip} kind=${f.severity === "human" ? "human" : f.severity === "block" ? "work" : "muted"}>${f.severity}<//> <span class="mono rule">${f.rule}</span> <span class="mono subj">${f.subject}</span>${f.acknowledged ? html`<${Chip} kind="pass">ack<//>` : null}</div></div>`)}`
      : null}
    ${entry.verdicts && entry.verdicts.length > 0
      ? html`<h4>verdicts</h4>${entry.verdicts.filter((v) => !v.question.startsWith("claim_verifiable")).map((v) =>
          html`<${Bar} value=${v.noul} label=${VERDICT_LABEL[v.question] ?? v.question} explain=${VERDICT_EXPLAIN[v.question] ?? ""} highIsGood=${HIGH_IS_GOOD.has(v.question)} />`,
        )}`
      : null}
  </div>`
}

/* ---------------------------------------------------------------- control */

function ControlView({ status, onAct }: { status: StatusResponse | null; onAct: () => void }): preact.VNode {
  const [gates, setGates] = useState<Record<string, boolean>>({})
  const [policy, setPolicy] = useState("strict")
  const [actionT, setActionT] = useState("0.8")
  const [reviewT, setReviewT] = useState("0.5")
  const [egress, setEgress] = useState(true)
  const [note, setNote] = useState("")
  const [msg, setMsg] = useState("")

  useEffect(() => {
    if (!status) return
    setGates(Object.fromEntries(status.gates.map((g) => [g.gate, g.on])))
    setPolicy(status.config.activePolicy)
    setActionT(String(status.config.thresholds.actionThreshold))
    setReviewT(String(status.config.thresholds.reviewThreshold))
    setEgress(status.config.egressSemantic)
  }, [status])

  if (!status) return html`<p class="hint">loading status…</p>`

  const save = () => {
    const changed = Object.fromEntries(Object.entries(gates).filter(([k, v]) => (status.gates.find((g) => g.gate === k)?.on ?? false) !== v))
    const body: Record<string, unknown> = {}
    if (Object.keys(changed).length > 0) body.gates = changed
    if (policy !== status.config.activePolicy) body.activePolicy = policy
    if (egress !== status.config.egressSemantic) body.egressSemantic = egress
    const at = Number(actionT)
    const rt = Number(reviewT)
    if (!Number.isNaN(at) && at !== status.config.thresholds.actionThreshold) body.actionThreshold = at
    if (!Number.isNaN(rt) && rt !== status.config.thresholds.reviewThreshold) body.reviewThreshold = rt
    if (note.trim()) body.note = note.trim()
    if (Object.keys(body).length === 0) {
      setMsg("nothing to change")
      return
    }
    api("/api/overrides", { method: "PUT", body: JSON.stringify({ overrides: body }) })
      .then(() => {
        setMsg("overrides written: they expire on the next PASS")
        onAct()
      })
      .catch((err) => setMsg(`error: ${err instanceof Error ? err.message : String(err)}`))
  }

  const clear = () =>
    doAction("/api/overrides", { method: "DELETE" }, onAct, setMsg)

  return html`<div class="stack">
    <div class="card">
      <div class="card-title">runtime overrides
        ${status.config.overridesActive ? html`<${Chip} kind="human">active: expires on next PASS<//>` : html`<${Chip} kind="pass">none active<//>`}
      </div>
      <p class="hint">changes here take effect on the agent's next wrangler_check (tools reload config on every call). env vars always win. strict is the resting state: overrides self-destruct on the next PASS, and every change lands in the audit trail.</p>
      ${status.config.overrides ? html`<pre class="pre">${JSON.stringify(status.config.overrides, null, 2)}</pre>` : null}
      <div class="row">
        <button class="primary" onClick=${save}>apply overrides</button>
        <button onClick=${clear}>clear overrides</button>
        <span class="${msg.startsWith("error") ? "err" : "okmsg"}">${msg}</span>
      </div>
    </div>
    <div class="card">
      <div class="card-title">gates <span class="muted">- each check the agent's work passes through</span></div>
      <div class="gate-grid">
        ${status.gates.map(
          (g) => html`<label class="check"><input type="checkbox" checked=${gates[g.gate] ?? g.on} onChange=${(e: Event) => setGates({ ...gates, [g.gate]: (e.target as HTMLInputElement).checked })} /> ${g.gate}</label>`,
        )}
      </div>
    </div>
    <div class="card">
      <div class="card-title">policy &amp; thresholds</div>
      <div class="row">
        <label>policy
          <select value=${policy} onChange=${(e: Event) => setPolicy((e.target as HTMLSelectElement).value)}>
            ${status.config.policies.map((p) => html`<option value=${p}>${p}</option>`)}
          </select>
        </label>
        <label>action threshold <input type="number" min="0" max="1" step="0.05" value=${actionT} onInput=${(e: Event) => setActionT((e.target as HTMLInputElement).value)} /></label>
        <label>review threshold <input type="number" min="0" max="1" step="0.05" value=${reviewT} onInput=${(e: Event) => setReviewT((e.target as HTMLInputElement).value)} /></label>
        <label class="check"><input type="checkbox" checked=${egress} onChange=${(e: Event) => setEgress((e.target as HTMLInputElement).checked)} /> semantic egress <span class="muted">(diff text leaves the machine)</span></label>
      </div>
      <label class="row">audit note <input class="grow" type="text" value=${note} onInput=${(e: Event) => setNote((e.target as HTMLInputElement).value)} placeholder="why are you changing this?" /></label>
    </div>
  </div>`
}

/* ---------------------------------------------------------------- reference */

function Reference(): preact.VNode {
  const [sub, setSub] = useState<"cache" | "corpus" | "sessions">("cache")
  const [entries, setEntries] = useState<GateEntry[]>([])
  useEffect(() => {
    api<{ entries: GateEntry[] }>("/api/ledger?limit=300")
      .then((r) => setEntries(r.entries))
      .catch(() => {})
  }, [])
  return html`<div class="stack">
    <div class="row">
      ${(["cache", "corpus", "sessions"] as const).map((s) => html`<button class=${sub === s ? "active" : ""} onClick=${() => setSub(s)}>${s}</button>`)}
    </div>
    ${sub === "cache" ? html`<${CacheView} />` : null}
    ${sub === "corpus" ? html`<${CorpusView} />` : null}
    ${sub === "sessions" ? html`<${SessionsView} entries=${entries} />` : null}
  </div>`
}

function CacheView(): preact.VNode {
  const [list, setList] = useState<CacheListResponse | null>(null)
  const [detail, setDetail] = useState<CacheEntryResponse | null>(null)
  useEffect(() => {
    api<CacheListResponse>("/api/cache")
      .then(setList)
      .catch(() => {})
  }, [])
  return html`<div class="card"><div class="card-title">jev answer cache <span class="muted">- what the judge answered, reused without re-billing tokens</span></div>
    <div class="split tight">
      <table>
        <thead><tr><th>key</th><th>tokens</th><th>questions</th></tr></thead>
        <tbody>
          ${(list?.entries ?? []).map(
            (e) => html`<tr onClick=${() => api<CacheEntryResponse>(`/api/cache/${e.key}`).then(setDetail).catch(() => {})}>
              <td class="mono">${e.key.slice(0, 10)}…</td>
              <td>${e.usage.inputTokens}/${e.usage.outputTokens}</td>
              <td>${e.questions.length}</td>
            </tr>`,
          )}
        </tbody>
      </table>
      <div>
        ${detail
          ? html`<div class="stack-s">
              <p class="hint">${detail.entry.model} · ${detail.entry.usage.inputTokens}/${detail.entry.usage.outputTokens} tokens</p>
              ${Object.entries(detail.entry.answers).map(([q, a]) => html`<${AnswerView} question=${q} answer=${a} />`)}
            </div>`
          : html`<p class="hint">select a cache entry</p>`}
      </div>
    </div>
  </div>`
}

function AnswerView({ question, answer }: { question: string; answer: AnswerValue }): preact.VNode {
  const label = VERDICT_LABEL[question] ?? question
  if (answer.kind === "noul")
    return html`<${Bar} value=${answer.noul} label=${label} explain=${VERDICT_EXPLAIN[question] ?? ""} highIsGood=${HIGH_IS_GOOD.has(question)} />`
  if (answer.kind === "choice")
    return html`<div class="stack-s">
      <div><span class="mono">${label}</span> → <${Chip} kind="info">${answer.choice}<//> conf ${answer.confidence.toFixed(2)}</div>
      ${Object.entries(answer.probabilities).map(([k, v]) => html`<${Bar} value=${v} label=${k} highIsGood=${false} />`)}
    </div>`
  return html`<div class="stack-s">
    <div><span class="mono">${label}</span> → score ${answer.score.toFixed(2)} (conf ${answer.confidence.toFixed(2)})</div>
    ${Object.entries(answer.probabilities).map(([k, v]) => html`<${Bar} value=${v} label=${k} highIsGood=${false} />`)}
  </div>`
}

function CorpusView(): preact.VNode {
  const [data, setData] = useState<CorpusResponse | null>(null)
  const [filter, setFilter] = useState("all")
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    api<CorpusResponse>("/api/corpus")
      .then(setData)
      .catch(() => {})
  }, [])
  const kinds = ["all", ...new Set((data?.sections ?? []).map((s) => s.kind))]
  const shown = (data?.sections ?? []).filter((s) => filter === "all" || s.kind === filter)
  return html`<div class="card"><div class="card-title">ground-truth corpus <span class="muted">- everything the gates cite</span></div>
    <div class="row">${kinds.map((k) => html`<button class=${filter === k ? "active" : ""} onClick=${() => setFilter(k)}>${k}</button>`)}<span class="muted">${shortHash(data?.hash)}</span></div>
    <div class="stack">
      ${shown.map(
        (s) => html`<div class="rulecard">
          <div class="row spread">
            <span><${Chip} kind="info">${s.kind}<//> <span class="mono">${s.id}</span> ${s.title}</span>
            <button class="ghost" onClick=${() => setOpen({ ...open, [s.id]: !open[s.id] })}>${open[s.id] ? "collapse" : "expand"}</button>
          </div>
          ${open[s.id] ? html`<pre class="pre scroll">${s.text}${s.ruling ? `\n\nRULING: ${s.ruling}` : ""}</pre>` : null}
        </div>`,
      )}
    </div>
  </div>`
}

function SessionsView({ entries }: { entries: GateEntry[] }): preact.VNode {
  const groups = useMemo(() => {
    const map = new Map<string, GateEntry[]>()
    for (const e of entries) {
      const key = e.sessionID ?? "(untagged)"
      map.set(key, [...(map.get(key) ?? []), e])
    }
    return [...map.entries()]
  }, [entries])
  return html`<div class="card"><div class="card-title">sessions <span class="muted">- checks grouped by the opencode session that ran them</span></div>
    <div class="stack">
      ${groups.length === 0 ? html`<p class="hint">no tagged checks yet (session tagging is recorded by the new tools)</p>` : null}
      ${groups.map(([sid, es]) => html`<div>
          <div class="mono card-subtitle">${sid}</div>
          <table><tbody>
            ${es.map((e) => html`<tr><td title=${e.ts}>${relTime(e.ts)}</td><td>${e.kind}</td><td>${e.action ? actionChip(e.action) : "-"}</td><td class="muted">${(e.findings ?? []).length} finding(s)</td></tr>`)}
          </tbody></table>
        </div>`)}
    </div>
  </div>`
}

render(html`<${App} />`, document.getElementById("app")!)
