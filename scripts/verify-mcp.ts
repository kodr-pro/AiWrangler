import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"

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
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, "..", "dist", "mcp.js"), serverRoot],
  // cwd with no config of its own: a dir-less call must use the startup root
  // above, not whatever directory the suite was launched from.
  cwd: import.meta.dirname,
  // Fail closed if elicitation is not used, so this suite never opens a desktop dialog.
  env: childEnv({ AIWRANGLER_OS_DIALOG: "off" }),
})
type ElicitMode = "decline" | "deny-form" | "approve"
let elicitMode: ElicitMode = "decline"
let elicitCount = 0
let lastElicitMessage = ""
const client = new Client({ name: "verify-mcp", version: "0.0.0" }, { capabilities: { elicitation: { form: {} } } })
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  elicitCount++
  const params = request.params as { message?: string; requestedSchema?: unknown }
  lastElicitMessage = params.message ?? ""
  const schema = JSON.stringify(params.requestedSchema ?? {})
  if (!schema.includes("approve") || !schema.includes("deny")) {
    return { action: "decline" as const }
  }
  if (elicitMode === "decline") return { action: "decline" as const }
  if (elicitMode === "deny-form") return { action: "accept" as const, content: { decision: "deny" } }
  return { action: "accept" as const, content: { decision: "approve" } }
})
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
check("ack tool is not advertised as silent", ackTool?.annotations?.readOnlyHint !== true)
check("override tool is not advertised as silent", overrideTool?.annotations?.readOnlyHint !== true)
check(
  "ack description says arguments do not approve",
  (ackTool?.description ?? "").includes("do not approve") && (ackTool?.description ?? "").includes("elicitation"),
)
check(
  "override description says arguments do not apply",
  (overrideTool?.description ?? "").includes("do not apply") && (overrideTool?.description ?? "").includes("elicitation"),
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

// --- human approval is elicitation, not the tool arguments ---
writeFileSync(join(fixture, "keys.ts"), "export const rotationIntervalSeconds = 42\n")

const human = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const humanText = (human.content as { text: string }[])[0]!.text
check("key-material diff flags RULE-10 human finding", humanText.includes("RULE-10") && humanText.includes("human"), humanText.split("\n")[0])
const diffHash = humanText.match(/diff: ([0-9a-f]{16})/)?.[1]
check("report carries a diff hash", diffHash !== undefined)

function ledgerEntries(): { kind: string; confirmation?: string; by?: string; source?: string; diffHash?: string; rules?: string[] }[] {
  return readFileSync(join(fixture, ".aiwrangler", "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; confirmation?: string; by?: string; source?: string; diffHash?: string; rules?: string[] })
}
function ledgerKinds(): string[] {
  return ledgerEntries().map((entry) => entry.kind)
}

const beforeList = elicitCount
const pending = await client.callTool({ name: "wrangler_ack", arguments: { dir: fixture } })
const pendingText = (pending.content as { text: string }[])[0]!.text
check("ack list mode shows pending findings", pending.isError !== true && pendingText.includes("RULE-10") && pendingText.includes("human"), pendingText.split("\n")[0])
check("ack list tells the owner how to approve", pendingText.includes("aiwrangler ack") && pendingText.includes("cannot answer"))
check("ack list does not elicit", elicitCount === beforeList)

const beforeBad = elicitCount
const ackBad = await client.callTool({
  name: "wrangler_ack",
  arguments: { dir: fixture, rules: ["RULE-10"], note: "agent self-ack", diffHash: "ffffffffffffffff" },
})
const ackBadText = (ackBad.content as { text: string }[])[0]!.text
check("unknown diff hash is rejected before elicitation", ackBad.isError === true && ackBadText.includes("not found") && elicitCount === beforeBad, ackBadText)
check("rejected hash appended no ledger ack", !ledgerKinds().includes("ack"))

elicitMode = "decline"
const declined = await client.callTool({
  name: "wrangler_ack",
  arguments: { dir: fixture, rules: ["RULE-10"], note: "please review the rotation interval" },
})
const declinedText = (declined.content as { text: string }[])[0]!.text
check("elicitation decline is a tool error", declined.isError === true && declinedText.includes("declined") && !declinedText.includes("acknowledged:"), declinedText)
check("decline prompt showed findings, rules, diff hash, and note", lastElicitMessage.includes("RULE-10") && lastElicitMessage.includes(diffHash ?? "missing") && lastElicitMessage.includes("rotation interval"), lastElicitMessage)
check("declined ack appended nothing", !ledgerKinds().includes("ack"))

elicitMode = "deny-form"
const formDeny = await client.callTool({
  name: "wrangler_ack",
  arguments: { dir: fixture, rules: ["RULE-10"], note: "form deny" },
})
const formDenyText = (formDeny.content as { text: string }[])[0]!.text
check("accepting the form with Deny does not ack", formDeny.isError === true && formDenyText.includes("declined") && !ledgerKinds().includes("ack"), formDenyText)

const afterRefuse = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const afterRefuseText = (afterRefuse.content as { text: string }[])[0]!.text
check("refused ack leaves the human finding unacknowledged", afterRefuseText.includes("RULE-10") && !afterRefuseText.includes("owner-acknowledged"))

const readOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture } })
const readOvText = (readOv.content as { text: string }[])[0]!.text
check("override read mode reports none active", readOv.isError !== true && readOvText.includes("none active"), readOvText.split("\n")[0])
const beforeRead = elicitCount
check("override read does not elicit", elicitCount === beforeRead)

elicitMode = "decline"
const setOv = await client.callTool({
  name: "wrangler_override",
  arguments: { dir: fixture, set: { gates: { docDrift: false } }, note: "agent self-override" },
})
const setOvText = (setOv.content as { text: string }[])[0]!.text
check("elicitation decline does not apply an override", setOv.isError === true && setOvText.includes("declined") && !setOvText.includes("ACTIVE"), setOvText)
check("override prompt shows the requested gate and note", lastElicitMessage.includes("docDrift") && lastElicitMessage.includes("agent self-override"))

const beforeBadPolicy = elicitCount
const badOv = await client.callTool({ name: "wrangler_override", arguments: { dir: fixture, set: { activePolicy: "yolo" } } })
const badOvText = (badOv.content as { text: string }[])[0]!.text
check("unknown policy is rejected before elicitation", badOv.isError === true && badOvText.includes("invalid overrides") && elicitCount === beforeBadPolicy, badOvText)

check("declined override wrote no runtime-overrides file", !existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))
check("declined override appended no ledger override", !ledgerKinds().includes("override"))
const cfgStill = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
check("docDrift stays on after declined override", ((cfgStill.content as { text: string }[])[0]!.text).includes("on   check.docDrift"))

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

// A client that never advertised form elicitation. The desktop dialog is off,
// so the write must fail closed instead of treating tool arguments as approval.
const bareTransport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, "..", "dist", "mcp.js"), serverRoot],
  cwd: import.meta.dirname,
  env: childEnv({ AIWRANGLER_OS_DIALOG: "off" }),
})
const bare = new Client({ name: "verify-mcp-no-elicit", version: "0.0.0" })
await bare.connect(bareTransport)
const acksBeforeBare = ledgerEntries().filter((entry) => entry.kind === "ack").length
const bareAck = await bare.callTool({
  name: "wrangler_ack",
  arguments: { dir: fixture, rules: ["RULE-10"], note: "no ui" },
})
const bareAckText = (bareAck.content as { text: string }[])[0]!.text
check(
  "client without elicitation cannot ack when the desktop dialog is off",
  bareAck.isError === true && bareAckText.includes("no human approval channel") && !bareAckText.includes("acknowledged:"),
  bareAckText,
)
check("that refusal appended no ack", ledgerEntries().filter((entry) => entry.kind === "ack").length === acksBeforeBare)
const bareOverride = await bare.callTool({
  name: "wrangler_override",
  arguments: { dir: fixture, set: { gates: { docDrift: false } }, note: "no ui" },
})
const bareOverrideText = (bareOverride.content as { text: string }[])[0]!.text
check(
  "client without elicitation cannot override when the desktop dialog is off",
  bareOverride.isError === true && bareOverrideText.includes("no human approval channel") && !bareOverrideText.includes("ACTIVE"),
  bareOverrideText,
)
check("that refusal wrote no runtime-overrides file", !existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))
await bare.close()

elicitMode = "approve"
const approved = await client.callTool({
  name: "wrangler_ack",
  arguments: { dir: fixture, rules: ["RULE-10"], note: "owner reviewed the rotation interval" },
})
const approvedText = (approved.content as { text: string }[])[0]!.text
check(
  "accepted elicitation records the ack",
  approved.isError !== true && approvedText.startsWith("acknowledged:") && approvedText.includes("confirmation: elicitation"),
  approvedText,
)
check(
  "accept prompt showed the rule, diff hash, and note",
  lastElicitMessage.includes("RULE-10") && lastElicitMessage.includes(diffHash ?? "missing") && lastElicitMessage.includes("rotation interval"),
  lastElicitMessage,
)
const ack = ledgerEntries().filter((entry) => entry.kind === "ack").at(-1)
check(
  "ledger ack is mcp provenance with elicitation confirmation",
  ack?.by === "mcp" && ack.confirmation === "elicitation" && (ack.rules ?? []).includes("RULE-10") && (ack.diffHash ?? "").startsWith(diffHash ?? "missing"),
  JSON.stringify(ack),
)
const afterAck = await client.callTool({ name: "wrangler_check", arguments: { dir: fixture, task: "mcp verify ack flow" } })
const afterAckText = (afterAck.content as { text: string }[])[0]!.text
check("accepted ack marks the finding owner-acknowledged", afterAckText.includes("owner-acknowledged"), afterAckText.split("\n").slice(0, 8).join(" | "))

elicitMode = "approve"
const setOk = await client.callTool({
  name: "wrangler_override",
  arguments: { dir: fixture, set: { gates: { docDrift: false } }, note: "owner disabled doc drift" },
})
const setOkText = (setOk.content as { text: string }[])[0]!.text
check(
  "accepted elicitation applies the override",
  setOk.isError !== true && setOkText.includes("ACTIVE") && setOkText.includes("confirmation: elicitation"),
  setOkText,
)
const ovFile = JSON.parse(readFileSync(join(fixture, ".aiwrangler", "runtime-overrides.json"), "utf8")) as {
  expiresOn: string
  overrides: { gates?: Record<string, boolean> }
}
check("override file expires on pass", ovFile.expiresOn === "pass" && ovFile.overrides.gates?.docDrift === false)
const ovEntry = ledgerEntries().filter((entry) => entry.kind === "override").at(-1) as {
  source?: string
  confirmation?: string
  changes?: { gates?: { docDrift?: boolean } }
} | undefined
check(
  "ledger override is mcp provenance with elicitation confirmation",
  ovEntry?.source === "mcp" && ovEntry.confirmation === "elicitation" && ovEntry.changes?.gates?.docDrift === false,
  JSON.stringify(ovEntry),
)
const cfgOff = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
check("docDrift is off after accepted override", ((cfgOff.content as { text: string }[])[0]!.text).includes("off  check.docDrift"))

elicitMode = "decline"
const clearDeclined = await client.callTool({
  name: "wrangler_override",
  arguments: { dir: fixture, clear: true, note: "not yet" },
})
const clearDeclinedText = (clearDeclined.content as { text: string }[])[0]!.text
check(
  "declined clear leaves the override in place",
  clearDeclined.isError === true && clearDeclinedText.includes("declined") && existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")),
  clearDeclinedText,
)
check("clear prompt asks to restore the strict state", lastElicitMessage.includes("clear runtime overrides"))

elicitMode = "approve"
const cleared = await client.callTool({
  name: "wrangler_override",
  arguments: { dir: fixture, clear: true, note: "owner restored strict" },
})
const clearedText = (cleared.content as { text: string }[])[0]!.text
check(
  "accepted elicitation clears the override",
  cleared.isError !== true && clearedText.includes("cleared by mcp") && clearedText.includes("confirmation: elicitation"),
  clearedText,
)
check("clear removes the overrides file", !existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))
const clearEntry = ledgerEntries().filter((entry) => entry.kind === "override").at(-1) as {
  source?: string
  confirmation?: string
  changes?: { cleared?: string }
} | undefined
check(
  "ledger records the manual clear with elicitation confirmation",
  clearEntry?.source === "mcp" && clearEntry.confirmation === "elicitation" && clearEntry.changes?.cleared === "manual",
  JSON.stringify(clearEntry),
)
const cfgOn = await client.callTool({ name: "wrangler_config", arguments: { dir: fixture } })
check("docDrift is on after accepted clear", ((cfgOn.content as { text: string }[])[0]!.text).includes("on   check.docDrift"))

await client.close()

rmSync(fixture, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nMCP FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
process.stdout.write("\nMCP verification passed\n")
