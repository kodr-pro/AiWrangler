// Human approval for ack/override writes. Tool arguments are not an input here.
import type { HumanConfirmation } from "./ledger.js"
import { confirmOsDialog, type OsDialogResult } from "./osdialog.js"

export type ElicitOutcome = "approve" | "deny" | "unsupported" | { error: string }

export interface ApprovalChannel {
  elicit?: (summary: string) => Promise<ElicitOutcome>
  osDialog?: (summary: string) => Promise<OsDialogResult>
}

export interface ApprovalGranted {
  ok: true
  confirmation: HumanConfirmation
}

export interface ApprovalRefused {
  ok: false
  message: string
}

export const OWNER_DECLINED = "aiwrangler: the owner declined. Nothing was recorded."

export const NO_APPROVAL_CHANNEL =
  "aiwrangler: no human approval channel is available. This client does not support MCP elicitation, and no desktop dialog could be shown. Nothing was recorded. The owner can run `aiwrangler ack` or `aiwrangler override` in a terminal and type yes."

/**
 * Ask the human. MCP elicitation wins when the client supports it.
 * Otherwise try a native OS dialog. Never treat the absence of a channel as a yes.
 */
export async function approveOwnerWrite(summary: string, channel: ApprovalChannel = {}): Promise<ApprovalGranted | ApprovalRefused> {
  if (channel.elicit) {
    const outcome = await channel.elicit(summary)
    if (outcome === "approve") return { ok: true, confirmation: "elicitation" }
    if (outcome === "deny") return { ok: false, message: OWNER_DECLINED }
    if (typeof outcome === "object") {
      return { ok: false, message: `aiwrangler: elicitation failed (${outcome.error}). Nothing was recorded.` }
    }
  }
  const dialog = channel.osDialog ?? confirmOsDialog
  const os = await dialog(summary)
  if (os === "approve") return { ok: true, confirmation: "os-dialog" }
  if (os === "deny") return { ok: false, message: "aiwrangler: the owner declined the desktop dialog. Nothing was recorded." }
  return { ok: false, message: NO_APPROVAL_CHANNEL }
}
