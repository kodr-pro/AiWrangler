// Owner confirmation for ack/override writes. The CLI is the only caller.
// MCP and opencode tools never reach this: they cannot invent a confirmation.
import { createInterface } from "node:readline/promises"
import type { Readable, Writable } from "node:stream"
import type { HumanConfirmation } from "./ledger.js"

export interface ConfirmResult {
  ok: true
  confirmation: HumanConfirmation
}

export interface ConfirmRefusal {
  ok: false
  message: string
}

export const NON_TTY_REFUSAL =
  'aiwrangler: refusing to write without a human at the terminal. Re-run in a TTY and type yes, or pass --yes if you are the owner (recorded as confirmation "yes-flag"). Agents must not pass --yes.'

export async function confirmHuman(opts: {
  yes: boolean
  prompt: string
  input?: Readable & { isTTY?: boolean }
  output?: Writable
}): Promise<ConfirmResult | ConfirmRefusal> {
  if (opts.yes) return { ok: true, confirmation: "yes-flag" }
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  if (input.isTTY !== true) return { ok: false, message: NON_TTY_REFUSAL }
  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question(opts.prompt)).trim().toLowerCase()
    if (answer === "yes") return { ok: true, confirmation: "tty" }
    return { ok: false, message: "aiwrangler: not confirmed; nothing was recorded" }
  } finally {
    rl.close()
  }
}
