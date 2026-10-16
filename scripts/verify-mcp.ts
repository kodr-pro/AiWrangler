import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
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

// Startup root is the committed corpus, not the repo root. The repo-root
// aiwrangler.config.json is gitignored on purpose, so a clean clone has nothing
// for a dir-less call to discover there. evals/corpus ships a fixture config.
const serverRoot = join(import.meta.dirname, "..", "evals", "corpus")
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, "..", "dist", "mcp.js"), serverRoot],
  // cwd with no config of its own: a dir-less call must use the startup root
  // above, not whatever directory the suite was launched from.
  cwd: import.meta.dirname,
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
const ackTool = listed.tools.find((t) => t.name === "wrangler_ack")
const overrideTool = listed.tools.find((t) => t.name === "wrangler_override")
check("ack tool is advertised read-only", ackTool?.annotations?.readOnlyHint === true)
check("override tool is advertised read-only", overrideTool?.annotations?.readOnlyHint === true)
check(
  "ack description does not offer a write",
  (ackTool?.description ?? "").includes("cannot acknowledge") && !(ackTool?.description ?? "").includes("records an owner acknowledgment"),
)
check(
  "override description does not offer a write",
  (overrideTool?.description ?? "").includes("cannot set or clear") && !(overrideTool?.description ?? "").includes("ONLY after explicit user approval"),
)

const cfg = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
const cfgText = (cfg.content as { type: string; text: string }[])[0]!.text
check("config discovers fixture", cfgText.includes("[discovered]"), cfgText.split("\n")[0])
check("corpus summary counts sections", cfgText.includes("spec=") && /\brule=\d+/.test(cfgText) && !cfgText.includes("spec=0"))
check("egress off reported", cfgText.includes("semantic=OFF"))

// dir-less call falls back to the server's startup root (evals/corpus)
const none = await client.callTool({ name: "wrangler_config", arguments: {} })
const noneText = (none.content as { text: string }[])[0]!.text
check(
  "dir-less call falls back to server root",
  noneText.includes("[discovered]") && noneText.includes(join("evals", "corpus", "aiwrangler.config.json")),
  noneText.split("\n")[0],
)

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

// --- agent cannot ack or override. List/report still work. Writes are the CLI. ---
writeFileSync(join(fixture, "keys.ts"), "export const rotationIntervalSeconds = 42\n")

const human = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const humanText = (human.content as { text: string }[])[0]!.text
check("key-material diff flags RULE-10 human finding", humanText.includes("RULE-10") && humanText.includes("human"), humanText.split("\n")[0])
const diffHash = humanText.match(/diff: ([0-9a-f]{16})/)?.[1]
check("report carries a diff hash", diffHash !== undefined)

function ledgerKinds(): string[] {
  return readFileSync(join(fixture, ".aiwrangler", "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { kind: string }).kind)
}

const pending = await client.callTool({ name: "wrangler_ack", arguments: { dir: fixture } })
const pendingText = (pending.content as { text: string }[])[0]!.text
check("ack list mode shows pending findings", pending.isError !== true && pendingText.includes("RULE-10") && pendingText.includes("human"), pendingText.split("\n")[0])
check("ack list tells the owner to use the CLI", pendingText.includes("aiwrangler ack") && pendingText.includes("cannot acknowledge"))

const ackAttempt = await client.callTool({
  name: "wrangler_ack",
  arguments: { dir: fixture, rules: ["RULE-10"], note: "agent self-ack", diffHash: "ffffffffffffffff" },
})
const ackAttemptText = (ackAttempt.content as { text: string }[])[0]!.text
check("mcp ack write is a tool error", ackAttempt.isError === true)
check(
  "mcp ack write is refused and does not enter the ack path",
  ackAttemptText.includes("refusing") && !ackAttemptText.includes("acknowledged:") && !ackAttemptText.includes("not found"),
  ackAttemptText,
)
check("mcp ack write appended no ledger ack", !ledgerKinds().includes("ack"), ledgerKinds().join(","))

const afterRefuse = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const afterRefuseText = (afterRefuse.content as { text: string }[])[0]!.text
check("refused ack leaves the human finding unacknowledged", afterRefuseText.includes("RULE-10") && !afterRefuseText.includes("owner-acknowledged"))

const readOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture } })
const readOvText = (readOv.content as { text: string }[])[0]!.text
check("override read mode reports none active", readOv.isError !== true && readOvText.includes("none active"), readOvText.split("\n")[0])

const setOv = await client.callTool({
  name: "wrangler_override",
  arguments: { dir: fixture, set: { gates: { docDrift: false } }, note: "agent self-override" },
})
const setOvText = (setOv.content as { text: string }[])[0]!.text
check("mcp override set is a tool error", setOv.isError === true)
check("mcp override set is refused", setOvText.includes("refusing") && !setOvText.includes("ACTIVE") && !setOvText.includes("invalid overrides"), setOvText)

const badOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture, set: { activePolicy: "yolo" } } })
const badOvText = (badOv.content as { text: string }[])[0]!.text
check("mcp unknown policy is refused rather than validated as a write", badOv.isError === true && badOvText.includes("refusing") && !badOvText.includes("invalid overrides"))

const clrOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture, clear: true, note: "agent clear" } })
const clrOvText = (clrOv.content as { text: string }[])[0]!.text
check("mcp override clear is refused", clrOv.isError === true && clrOvText.includes("refusing") && !clrOvText.includes("cleared"))

check("mcp override wrote no runtime-overrides file", !existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))
check("mcp override appended no ledger override", !ledgerKinds().includes("override"), ledgerKinds().join(","))
const cfgStill = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
check("docDrift stays on after refused override", ((cfgStill.content as { text: string }[])[0]!.text).includes("on   check.docDrift"))

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
