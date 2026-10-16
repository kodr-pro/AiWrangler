// TTY confirmation for the owner CLI. There is no flag that skips this.
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
  "aiwrangler: refusing to write without a human at the terminal. Re-run in a TTY and type yes. --yes does not authorize a write. Nothing was recorded."

export const YES_FLAG_REFUSAL =
  "aiwrangler: --yes does not authorize a write. Type yes at the TTY prompt, or approve the in-editor elicitation or desktop dialog. Nothing was recorded."

export async function confirmHuman(opts: {
  prompt: string
  input?: Readable & { isTTY?: boolean }
  output?: Writable
}): Promise<ConfirmResult | ConfirmRefusal> {
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
