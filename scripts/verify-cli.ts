// Owner CLI: ack and override writes, TTY / --yes provenance, diff-hash binding.
// Also proves the built opencode tools refuse the same writes.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { pathToFileURL } from "node:url"
import { checkGate, configReport } from "../src/core.js"
import { runCli } from "../src/cli.js"
import type { AckLedgerEntry, LedgerEntry, OverrideLedgerEntry } from "../src/ledger.js"

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  ok    ${name}\n`)
  } else {
    failures++
    process.stdout.write(`  FAIL  ${name}${detail ? `: ${detail}` : ""}\n`)
  }
}

const root = join(import.meta.dirname, "..")
const cliBin = join(root, "dist", "cli.js")
const toolsPath = join(root, "dist", "tools.js")
if (!existsSync(cliBin) || !existsSync(toolsPath)) {
  console.error("dist/cli.js or dist/tools.js missing; run npm run build")
  process.exit(1)
}

const fixture = join(root, ".verify-cli-fixture")
rmSync(fixture, { recursive: true, force: true })
mkdirSync(join(fixture, ".aiwrangler"), { recursive: true })
writeFileSync(
  join(fixture, "aiwrangler.config.json"),
  JSON.stringify({
    model: "stub",
    egress: { semantic: false, warnOncePerSession: false },
    corpus: { spec: "spec.md", rules: "rules.md" },
  }),
)
const corpusDir = join(root, "evals", "corpus")
writeFileSync(join(fixture, "spec.md"), readFileSync(join(corpusDir, "spec.md"), "utf8"))
writeFileSync(join(fixture, "rules.md"), readFileSync(join(corpusDir, "rules.md"), "utf8"))
writeFileSync(join(fixture, ".gitignore"), ".aiwrangler/\n")
execFileSync("git", ["init", "-q"], { cwd: fixture })
execFileSync("git", ["add", "-A"], { cwd: fixture })
execFileSync("git", ["-c", "user.email=v@cli", "-c", "user.name=cli", "commit", "-qm", "fixture"], { cwd: fixture })

function ledger(): LedgerEntry[] {
  const path = join(fixture, ".aiwrangler", "ledger.jsonl")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry)
}

function acks(): AckLedgerEntry[] {
  return ledger().filter((e): e is AckLedgerEntry => e.kind === "ack")
}

function overrides(): OverrideLedgerEntry[] {
  return ledger().filter((e): e is OverrideLedgerEntry => e.kind === "override")
}

function runBin(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliBin, ...args], {
      encoding: "utf8",
      timeout: 5000,
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, stdout, stderr: "" }
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
    const text = (value: string | Buffer | undefined) => (value === undefined ? "" : value.toString())
    return { code: e.status ?? 1, stdout: text(e.stdout), stderr: text(e.stderr) }
  }
}

function captureIO(isTTY: boolean) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean }
  input.isTTY = isTTY
  const out: string[] = []
  const err: string[] = []
  const output = new PassThrough()
  const error = new PassThrough()
  output.on("data", (chunk) => out.push(chunk.toString()))
  error.on("data", (chunk) => err.push(chunk.toString()))
  return { input, output, error, stdout: () => out.join(""), stderr: () => err.join("") }
}

async function runInjected(args: string[], isTTY: boolean, answer?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = captureIO(isTTY)
  const [cmd, ...rest] = args
  if (!cmd) throw new Error("missing command")
  const pending = runCli([cmd, "--dir", fixture, ...rest], io)
  if (answer !== undefined) {
    io.input.write(answer.endsWith("\n") ? answer : answer + "\n")
  }
  const code = await Promise.race([
    pending,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("cli hung")), 3000)),
  ])
  return { code, stdout: io.stdout(), stderr: io.stderr() }
}

process.stdout.write("CLI verification: owner ack/override outside MCP\n")

writeFileSync(join(fixture, "keys.ts"), "export const rotationIntervalSeconds = 42\n")
const first = await checkGate(fixture, { task: "cli verify" })
check("dirty key file is not a pass", first.includes("RULE-10") && first.includes("human"), first.split("\n")[0])
const recorded = ledger().filter((e) => (e.kind === "check" || e.kind === "plan") && e.diffHash !== undefined).at(-1)
const diffHash = recorded && "diffHash" in recorded ? recorded.diffHash : undefined
check("ledger stored a diff hash", typeof diffHash === "string" && /^[0-9a-f]{16,}$/.test(diffHash))

const refused = runBin(["ack", "--dir", fixture, "--rules", "RULE-10", "--note", "agent pipe"])
check("non-tty ack without --yes exits non-zero", refused.code !== 0, `code=${refused.code}`)
check("non-tty ack without --yes is refused", refused.stderr.includes("refusing") && !refused.stdout.includes("acknowledged:"), refused.stderr)
check("refused ack wrote nothing", acks().length === 0)

const badHash = runBin(["ack", "--dir", fixture, "--rules", "RULE-10", "--diff-hash", "not-a-hash", "--yes"])
check("invalid diff hash rejected", badHash.code !== 0 && badHash.stderr.includes("invalid diffHash"), badHash.stderr)
check("invalid diff hash wrote nothing", acks().length === 0)

const unknown = runBin(["ack", "--dir", fixture, "--rules", "RULE-10", "--diff-hash", "ffffffffffffffff", "--yes"])
check("unknown diff hash rejected", unknown.code !== 0 && unknown.stderr.includes("not found"), unknown.stderr)
check("unknown diff hash wrote nothing", acks().length === 0)

const tools = (await import(pathToFileURL(toolsPath).href)) as {
  wrangler_ack: { execute: (args: { rules?: string[]; note?: string; diffHash?: string }, ctx: { directory: string }) => Promise<string> }
  wrangler_override: {
    execute: (
      args: { set?: { gates?: Record<string, boolean>; activePolicy?: string }; clear?: boolean; note?: string },
      ctx: { directory: string },
    ) => Promise<string>
  }
}
const ctx = { directory: fixture }
const listed = await tools.wrangler_ack.execute({}, ctx)
check("opencode ack tool lists pending findings", listed.includes("RULE-10") && listed.includes("cannot acknowledge"), listed.split("\n")[0])
const agentAck = await tools.wrangler_ack.execute(
  { rules: ["RULE-10"], note: "opencode self-ack", ...(typeof diffHash === "string" ? { diffHash } : {}) },
  ctx,
)
check("opencode ack tool refuses writes", agentAck.includes("refusing") && !agentAck.includes("acknowledged:"), agentAck)
check("opencode ack tool wrote nothing", acks().length === 0)

const approved = runBin(["ack", "--dir", fixture, "--rules", "RULE-10", "--note", "owner reviewed the rotation interval", "--yes"])
check("cli --yes ack exits 0", approved.code === 0, approved.stderr)
check("cli --yes ack reports the record", approved.stdout.startsWith("acknowledged:") && approved.stdout.includes("confirmation: yes-flag"), approved.stdout)
const ack = acks().at(-1)
check(
  "ledger ack is cli provenance bound to the recorded diff",
  ack?.by === "cli" && ack.confirmation === "yes-flag" && ack.diffHash === diffHash && ack.rules.includes("RULE-10") && (ack.note ?? "").includes("rotation"),
  JSON.stringify(ack),
)

const after = await checkGate(fixture, { task: "cli verify" })
check("post-ack check records owner acknowledgment", after.includes("owner-acknowledged"), after.split("\n").slice(0, 8).join(" | "))

const declined = await runInjected(["ack", "--rules", "RULE-10", "--note", "nope"], true, "no")
check("tty decline writes nothing", declined.code !== 0 && declined.stderr.includes("not confirmed") && acks().length === 1, declined.stderr)

const typed = await runInjected(["ack", "--rules", "*", "--note", "typed yes"], true, "yes")
check("tty yes exits 0", typed.code === 0, typed.stderr + typed.stdout)
check("tty yes stdout names the confirmation", typed.stdout.includes("confirmation: tty"), typed.stdout)
const ttyAck = acks().at(-1)
check("ledger records the tty confirmation", ttyAck?.by === "cli" && ttyAck.confirmation === "tty" && ttyAck.rules.includes("*"), JSON.stringify(ttyAck))

writeFileSync(join(fixture, "keys.ts"), "export const rotationIntervalSeconds = 43\n")
const changed = await checkGate(fixture, { task: "cli verify" })
check("diff change voids the ack", changed.includes("RULE-10") && !changed.includes("owner-acknowledged"), changed.split("\n").slice(0, 6).join(" | "))

const setRefused = runBin(["override", "--dir", fixture, "--set", '{"gates":{"docDrift":false}}', "--note", "pipe"])
check("non-tty override without --yes is refused", setRefused.code !== 0 && setRefused.stderr.includes("refusing"), setRefused.stderr)
check("refused override wrote no file", !existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))

const agentOverride = await tools.wrangler_override.execute({ set: { gates: { docDrift: false } }, note: "opencode" }, ctx)
check("opencode override tool refuses writes", agentOverride.includes("refusing") && !agentOverride.includes("ACTIVE"), agentOverride)
const agentClear = await tools.wrangler_override.execute({ clear: true }, ctx)
check("opencode override clear is refused", agentClear.includes("refusing"))
check("opencode override wrote no ledger entry", overrides().length === 0)

const badPolicy = runBin(["override", "--dir", fixture, "--set", '{"activePolicy":"yolo"}', "--yes"])
check("unknown policy rejected", badPolicy.code !== 0 && badPolicy.stderr.includes("invalid overrides"), badPolicy.stderr)
check("rejected policy wrote no file", !existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))

const setOk = runBin(["override", "--dir", fixture, "--set", '{"gates":{"docDrift":false}}', "--note", "owner disabled doc drift", "--yes"])
check("cli --yes override exits 0", setOk.code === 0, setOk.stderr)
check("cli --yes override reports PASS expiry and confirmation", setOk.stdout.includes("expire on next PASS") && setOk.stdout.includes("confirmation: yes-flag"), setOk.stdout)
const ovFile = JSON.parse(readFileSync(join(fixture, ".aiwrangler", "runtime-overrides.json"), "utf8")) as {
  expiresOn: string
  overrides: { gates?: Record<string, boolean> }
  note?: string
}
check("override file expires on pass", ovFile.expiresOn === "pass" && ovFile.overrides.gates?.docDrift === false && (ovFile.note ?? "").includes("doc drift"))
const ovEntry = overrides().at(-1)
check(
  "ledger override is cli provenance",
  ovEntry?.source === "cli" && ovEntry.confirmation === "yes-flag" && (ovEntry.changes as { gates?: { docDrift?: boolean } }).gates?.docDrift === false,
  JSON.stringify(ovEntry),
)

check("override reflected in effective config", configReport(fixture).includes("off  check.docDrift"))
const report = runBin(["override", "--dir", fixture])
check("override report is read-only and shows the gate", report.code === 0 && report.stdout.includes("docDrift") && report.stdout.includes("expiresOn: pass"), report.stdout)

const clearRefused = runBin(["override", "--dir", fixture, "--clear"])
check("non-tty clear without --yes is refused", clearRefused.code !== 0 && clearRefused.stderr.includes("refusing"), clearRefused.stderr)
check("refused clear leaves the file", existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))

const cleared = runBin(["override", "--dir", fixture, "--clear", "--note", "owner restored strict", "--yes"])
check("cli --yes clear exits 0", cleared.code === 0 && cleared.stdout.includes("cleared by cli") && cleared.stdout.includes("confirmation: yes-flag"), cleared.stderr + cleared.stdout)
check("clear removes the overrides file", !existsSync(join(fixture, ".aiwrangler", "runtime-overrides.json")))
const clearEntry = overrides().at(-1)
check(
  "ledger records the manual clear with confirmation",
  clearEntry?.source === "cli" && clearEntry.confirmation === "yes-flag" && (clearEntry.changes as { cleared?: string }).cleared === "manual",
  JSON.stringify(clearEntry),
)
check("config restored after clear", configReport(fixture).includes("on   check.docDrift"))

const help = runBin(["--help"])
check("help exits 0 and names both commands", help.code === 0 && help.stdout.includes("aiwrangler ack") && help.stdout.includes("aiwrangler override"))

rmSync(fixture, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nCLI FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
process.stdout.write("\nCLI verification passed\n")
