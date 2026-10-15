import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  ok    ${name}\n`)
  } else {
    failures++
    process.stdout.write(`  FAIL  ${name}${detail ? `: ${detail}` : ""}\n`)
  }
}

// minimal no-network fixture: a corpus + config so wrangler_config has ground truth to report
const fixture = join(import.meta.dirname, "..", ".verify-mcp-fixture")
rmSync(fixture, { recursive: true, force: true })
mkdirSync(join(fixture, ".aiwrangler"), { recursive: true })
writeFileSync(
  join(fixture, "aiwrangler.config.json"),
  JSON.stringify({
    model: "stub",
    egress: { semantic: false, warnOncePerSession: false },
    corpus: {
      spec: "spec.md",
      rules: "rules.md",
    },
  }),
)
// reuse the canonical verify-suite corpus so parser formats are exact
const corpusDir = join(import.meta.dirname, "..", "evals", "corpus")
writeFileSync(join(fixture, "spec.md"), readFileSync(join(corpusDir, "spec.md"), "utf8"))
writeFileSync(join(fixture, "rules.md"), readFileSync(join(corpusDir, "rules.md"), "utf8"))
writeFileSync(join(fixture, ".gitignore"), ".aiwrangler/\n.verify-mcp-fixture/\n")
execSync("git init -q && git add -A && git -c user.email=v@mcp -c user.name=mcp commit -qm fixture", { cwd: fixture })

process.stdout.write("MCP verification: stdio handshake + tools\n")

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, "..", "dist", "mcp.js")],
})
const client = new Client({ name: "verify-mcp", version: "0.0.0" })
await client.connect(transport)

const listed = await client.listTools()
const names = listed.tools.map((t) => t.name)
check("tools/list exposes the six gates", names.join(",") === "wrangler_config,wrangler_plan,wrangler_check,wrangler_ack,wrangler_override,wrangler_loop_reset", names.join(","))
check(
  "descriptions survive the wire",
  listed.tools.every((t) => (t.description ?? "").length > 80),
)

const cfg = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
const cfgText = (cfg.content as { type: string; text: string }[])[0]!.text
check("config discovers fixture", cfgText.includes("[discovered]"), cfgText.split("\n")[0])
check("corpus summary counts sections", cfgText.includes("spec=") && /\brule=\d+/.test(cfgText) && !cfgText.includes("spec=0"))
check("egress off reported", cfgText.includes("semantic=OFF"))

// dir-less call falls back to the server's startup root (this repo, which has a config)
const none = await client.callTool({ name: "wrangler_config", arguments: {} })
check("dir-less call falls back to server root", (none.content as { text: string }[])[0]!.text.includes("[discovered]"))

// check gate on the clean fixture: no dirty files -> deterministic pass, no Jev spend
const chk = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify" } })
const chkText = (chk.content as { text: string }[])[0]!.text
check("clean fixture check returns PASS", chkText.includes("AIWRANGLER PASS"), chkText.split("\n")[0])

// ledger recorded the check (server-side state wiring intact)
const ledger = readFileSync(join(fixture, ".aiwrangler", "ledger.jsonl"), "utf8").trim().split("\n")
const lastEntry = JSON.parse(ledger[ledger.length - 1]!)
check("check written to ledger", lastEntry.kind === "check" && lastEntry.action === "pass")

// plan gate with egress off degrades deterministically (no network) and still returns an action
const plan = await client.callTool({ name: "wrangler_plan", arguments: { dir: fixture, task: "make the widget irreversible" } })
const planText = (plan.content as { text: string }[])[0]!.text
check("plan returns an action", /AIWRANGLER PLAN: (PASS|CLARIFY|HUMAN|DEGRADED)/.test(planText), planText.split("\n")[0])

// --- human confirmation flow: dirty key-material file -> human finding -> ack -> acknowledged ---
// (egress-off routing sends human findings to DEGRADED by design; the ack
// wiring and semantics are what we assert here over the wire)
writeFileSync(join(fixture, "keys.ts"), "export const rotationIntervalSeconds = 42\n")

const human = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const humanText = (human.content as { text: string }[])[0]!.text
check("key-material diff flags RULE-10 human finding", humanText.includes("RULE-10") && humanText.includes("human"), humanText.split("\n")[0])
const diffHash = humanText.match(/diff: ([0-9a-f]{16})/)?.[1]
check("report carries a diff hash", diffHash !== undefined)

const pending = await client.callTool({ name: "wrangler_ack", arguments: { dir: fixture } })
const pendingText = (pending.content as { text: string }[])[0]!.text
check("ack list mode shows pending findings", pendingText.includes("RULE-10") && pendingText.includes("human"), pendingText.split("\n")[0])

const ackBad = await client.callTool({ name: "wrangler_ack", arguments: { dir: fixture, rules: ["RULE-10"], diffHash: "ffffffffffffffff" } })
check("unknown diffHash rejected", ((ackBad.content as { text: string }[])[0]!.text).includes("not found"))

const ack = await client.callTool({ name: "wrangler_ack", arguments: { dir: fixture, rules: ["RULE-10"], note: "fixture key reviewed by test" } })
const ackText = (ack.content as { text: string }[])[0]!.text
check("ack records owner approval", ackText.startsWith("acknowledged:"), ackText.split("\n")[0])

const after = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const afterText = (after.content as { text: string }[])[0]!.text
check("post-ack check records acknowledgment", afterText.includes("acknowledged"), afterText.split("\n")[0])

// any diff change voids the ack
writeFileSync(join(fixture, "keys.ts"), "export const rotationIntervalSeconds = 43\n")
const changed = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const changedText = (changed.content as { text: string }[])[0]!.text
check("diff change voids the ack", changedText.includes("RULE-10") && !changedText.includes("owner-acknowledged"))

// --- override control: set -> reflected in config -> reported -> cleared ---
const setOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture, set: { gates: { docDrift: false } }, note: "test override" } })
check("override set acknowledged", ((setOv.content as { text: string }[])[0]!.text).includes("ACTIVE"))

const cfgOv = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
const cfgOvText = (cfgOv.content as { text: string }[])[0]!.text
check("override reflected in effective config", cfgOvText.includes("off  check.docDrift"))

const readOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture } })
check("override read mode reports active", ((readOv.content as { text: string }[])[0]!.text).includes("docDrift"))

const badOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture, set: { activePolicy: "yolo" } } })
check("unknown policy rejected", ((badOv.content as { text: string }[])[0]!.text).includes("invalid overrides"))

const clrOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture, clear: true } })
check("override cleared", ((clrOv.content as { text: string }[])[0]!.text).includes("cleared"))
const cfgClr = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
check("config restored after clear", ((cfgClr.content as { text: string }[])[0]!.text).includes("on   check.docDrift"))

// --- circuit breaker: repeated identical findings escalate, loop reset clears ---
let escalated = false
for (let i = 0; i < 4; i++) {
  const rep = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify breaker" } })
  const t = (rep.content as { text: string }[])[0]!.text
  if (t.includes("CIRCUIT BREAKER OPEN")) {
    escalated = true
    break
  }
}
check("repeated findings open the circuit breaker", escalated)

const reset = await client.callTool({ name: "wrangler_loop_reset", arguments: { dir: fixture } })
check("loop reset reported", ((reset.content as { text: string }[])[0]!.text).includes("reset"))
const postReset = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify breaker" } })
const postResetText = (postReset.content as { text: string }[])[0]!.text
check("breaker closed after reset", postResetText.includes("RULE-10") && !postResetText.includes("CIRCUIT BREAKER OPEN"))

await client.close()

rmSync(fixture, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nMCP FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
process.stdout.write("\nMCP verification passed\n")
