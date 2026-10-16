#!/usr/bin/env node
// Owner CLI for HUMAN REVIEW acks and runtime overrides.
// In Cursor and opencode the MCP server asks in the editor instead.
// --yes is rejected: a flag is not a human.
//
//   aiwrangler ack [--dir DIR] [--rules RULE[,RULE...]] [--note TEXT] [--diff-hash HEX]
//   aiwrangler override [--dir DIR] [--set JSON] [--clear] [--note TEXT]
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { parseArgs, type ParseArgsConfig } from "node:util"
import { confirmHuman, YES_FLAG_REFUSAL } from "./confirm.js"
import { acknowledgeFindings, listPendingAck, planAck, planOverride, reportOverrides, resolveGateDir, writeOverrides } from "./core.js"
import { RuntimeOverridesSchema, type RuntimeOverrides } from "./overrides.js"

export interface CliIO {
  input: Readable & { isTTY?: boolean }
  output: Writable
  error: Writable
}

const HELP = `aiwrangler — owner commands for HUMAN REVIEW acks and runtime overrides.

Inside Cursor or opencode, prefer the MCP tools: a write asks you in the
editor (elicitation) or a desktop dialog. This CLI is the terminal path.
It asks you to type yes on a TTY. --yes does not authorize a write.

Usage:
  aiwrangler ack [--dir DIR] [--rules RULE[,RULE...]] [--note TEXT] [--diff-hash HEX]
  aiwrangler override [--dir DIR] [--set JSON] [--clear] [--note TEXT]

ack with no --rules lists pending human findings and the diff hash.
override with no --set or --clear reports active overrides.
Acks bind to that diff hash and void when the diff changes.
Overrides expire on the next PASS verdict.
`

function isGateError(text: string): boolean {
  return /^aiwrangler\b/.test(text)
}

function emit(stream: Writable, text: string): void {
  stream.write(text.endsWith("\n") ? text : text + "\n")
}

function parseRules(values: string[] | undefined): string[] {
  if (!values) return []
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function readFlags(argv: string[], options: ParseArgsConfig["options"]): ReturnType<typeof parseArgs> {
  return parseArgs({ args: argv, options, strict: true, allowPositionals: false })
}

async function runAck(argv: string[], io: CliIO): Promise<number> {
  let flags: ReturnType<typeof parseArgs>
  try {
    flags = readFlags(argv, {
      dir: { type: "string" },
      rules: { type: "string", multiple: true },
      note: { type: "string" },
      "diff-hash": { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    })
  } catch (err) {
    emit(io.error, `aiwrangler: ${err instanceof Error ? err.message : String(err)}`)
    emit(io.error, HELP)
    return 1
  }
  if (flags.values.help === true) {
    emit(io.output, HELP)
    return 0
  }
  if (flags.values.yes === true) {
    emit(io.error, YES_FLAG_REFUSAL)
    return 1
  }
  const dir = resolveGateDir(typeof flags.values.dir === "string" ? flags.values.dir : undefined)
  const ruleArgs = Array.isArray(flags.values.rules) ? flags.values.rules.filter((r): r is string => typeof r === "string") : undefined
  const rules = parseRules(ruleArgs)
  const note = typeof flags.values.note === "string" ? flags.values.note : undefined
  const diffHash = typeof flags.values["diff-hash"] === "string" ? flags.values["diff-hash"] : undefined
  if (ruleArgs === undefined) {
    if (note !== undefined || diffHash !== undefined) {
      emit(io.error, "aiwrangler: --note and --diff-hash require --rules; nothing was recorded")
      return 1
    }
    const text = listPendingAck(dir)
    emit(isGateError(text) ? io.error : io.output, text)
    return isGateError(text) ? 1 : 0
  }
  if (rules.length === 0) {
    emit(io.error, 'aiwrangler: --rules must name at least one rule id (or "*"); nothing was recorded')
    return 1
  }
  const planned = planAck(dir, { rules, ...(note !== undefined ? { note } : {}), ...(diffHash !== undefined ? { diffHash } : {}) })
  if (!planned.ok) {
    emit(io.error, planned.message)
    return 1
  }
  const confirmed = await confirmHuman({
    prompt: planned.summary + "\nType yes to confirm: ",
    input: io.input,
    output: io.output,
  })
  if (!confirmed.ok) {
    emit(io.error, confirmed.message)
    return 1
  }
  const text = acknowledgeFindings(dir, {
    rules: planned.rules,
    diffHash: planned.diffHash,
    confirmation: confirmed.confirmation,
    by: "cli",
    ...(planned.note !== undefined ? { note: planned.note } : {}),
  })
  emit(isGateError(text) ? io.error : io.output, text)
  return isGateError(text) ? 1 : 0
}

async function runOverride(argv: string[], io: CliIO): Promise<number> {
  let flags: ReturnType<typeof parseArgs>
  try {
    flags = readFlags(argv, {
      dir: { type: "string" },
      set: { type: "string" },
      clear: { type: "boolean", default: false },
      note: { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    })
  } catch (err) {
    emit(io.error, `aiwrangler: ${err instanceof Error ? err.message : String(err)}`)
    emit(io.error, HELP)
    return 1
  }
  if (flags.values.help === true) {
    emit(io.output, HELP)
    return 0
  }
  if (flags.values.yes === true) {
    emit(io.error, YES_FLAG_REFUSAL)
    return 1
  }
  const dir = resolveGateDir(typeof flags.values.dir === "string" ? flags.values.dir : undefined)
  const note = typeof flags.values.note === "string" ? flags.values.note : undefined
  const setRaw = typeof flags.values.set === "string" ? flags.values.set : undefined
  const clear = flags.values.clear === true
  if (clear && setRaw !== undefined) {
    emit(io.error, "aiwrangler: pass only one of --set or --clear; nothing was changed")
    return 1
  }
  if (!clear && setRaw === undefined) {
    if (note !== undefined) {
      emit(io.error, "aiwrangler: --note applies to --set or --clear; nothing was changed")
      return 1
    }
    const text = reportOverrides(dir)
    emit(isGateError(text) ? io.error : io.output, text)
    return isGateError(text) ? 1 : 0
  }
  let set: RuntimeOverrides | undefined
  if (setRaw !== undefined) {
    let raw: unknown
    try {
      raw = JSON.parse(setRaw)
    } catch (err) {
      emit(io.error, `aiwrangler: --set must be JSON (${err instanceof Error ? err.message : String(err)})`)
      return 1
    }
    const parsed = RuntimeOverridesSchema.safeParse(raw)
    if (!parsed.success) {
      emit(io.error, `aiwrangler: invalid overrides: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
      return 1
    }
    set = parsed.data
  }
  const planned = planOverride(dir, {
    ...(clear ? { clear: true } : {}),
    ...(set !== undefined ? { set } : {}),
    ...(note !== undefined ? { note } : {}),
  })
  if (!planned.ok) {
    emit(io.error, planned.message)
    return 1
  }
  if (planned.kind === "noop") {
    emit(io.output, planned.message)
    return 0
  }
  const confirmed = await confirmHuman({
    prompt: planned.summary + "\nType yes to confirm: ",
    input: io.input,
    output: io.output,
  })
  if (!confirmed.ok) {
    emit(io.error, confirmed.message)
    return 1
  }
  const text = writeOverrides(dir, {
    confirmation: confirmed.confirmation,
    by: "cli",
    ...(planned.kind === "clear" ? { clear: true } : { set: planned.set }),
    ...(planned.note !== undefined ? { note: planned.note } : {}),
  })
  emit(isGateError(text) ? io.error : io.output, text)
  return isGateError(text) ? 1 : 0
}

export async function runCli(argv: string[], io?: Partial<CliIO>): Promise<number> {
  const full: CliIO = {
    input: io?.input ?? process.stdin,
    output: io?.output ?? process.stdout,
    error: io?.error ?? process.stderr,
  }
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    emit(full.output, HELP)
    return cmd === undefined ? 1 : 0
  }
  if (cmd === "ack") return runAck(rest, full)
  if (cmd === "override") return runOverride(rest, full)
  emit(full.error, `aiwrangler: unknown command '${cmd}'`)
  emit(full.error, HELP)
  return 1
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code)
    })
    .catch((err) => {
      process.stderr.write(`aiwrangler: fatal: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}
