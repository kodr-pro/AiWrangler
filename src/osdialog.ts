// Native desktop confirmation. The agent does not receive a token it can replay.
// Headless sessions and AIWRANGLER_OS_DIALOG=off fail closed (no write).
import { spawn } from "node:child_process"

export type OsDialogResult = "approve" | "deny" | "unavailable"

const DIALOG_TIMEOUT_MS = 3 * 60 * 1000

function hasLinuxGui(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.MIR_SOCKET)
}

function runCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let settled = false
    const finish = (result: { code: number | null; stdout: string; missing: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ code: null, stdout, missing: false })
    }, DIALOG_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, missing: err.code === "ENOENT" })
    })
    child.on("close", (code) => {
      finish({ code, stdout, missing: false })
    })
  })
}

async function osascript(summary: string): Promise<OsDialogResult> {
  const script = [
    "on run argv",
    "set prompt to item 1 of argv",
    'set r to display dialog prompt buttons {"Deny", "Approve"} default button "Deny" with title "AiWrangler" with icon caution',
    "return button returned of r",
    "end run",
  ].join("\n")
  const result = await runCommand("osascript", ["-e", script, "--", summary])
  if (result.missing) return "unavailable"
  if (result.code === 0 && result.stdout.includes("Approve")) return "approve"
  return "deny"
}

async function zenity(summary: string): Promise<OsDialogResult | "missing"> {
  const result = await runCommand("zenity", [
    "--question",
    "--title=AiWrangler",
    "--ok-label=Approve",
    "--cancel-label=Deny",
    "--width=480",
    "--text",
    summary,
  ])
  if (result.missing) return "missing"
  return result.code === 0 ? "approve" : "deny"
}

async function kdialog(summary: string): Promise<OsDialogResult | "missing"> {
  const result = await runCommand("kdialog", ["--title", "AiWrangler", "--yesno", summary])
  if (result.missing) return "missing"
  return result.code === 0 ? "approve" : "deny"
}

async function linuxDialog(summary: string): Promise<OsDialogResult> {
  if (!hasLinuxGui()) return "unavailable"
  const zen = await zenity(summary)
  if (zen !== "missing") return zen
  const kde = await kdialog(summary)
  if (kde !== "missing") return kde
  return "unavailable"
}

async function windowsDialog(summary: string): Promise<OsDialogResult> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$r = [System.Windows.Forms.MessageBox]::Show($env:AIWRANGLER_PROMPT, 'AiWrangler', 'YesNo', 'Warning', 'Button2')",
    "if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 1 }",
  ].join("\n")
  const result = await runCommand("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    ...process.env,
    AIWRANGLER_PROMPT: summary,
  })
  if (result.missing) return "unavailable"
  if (result.code === null) return "deny"
  return result.code === 0 ? "approve" : "deny"
}

/** Ask the desktop user. Returns unavailable when no dialog can be shown. */
export async function confirmOsDialog(summary: string): Promise<OsDialogResult> {
  if (process.env.AIWRANGLER_OS_DIALOG === "off") return "unavailable"
  const text = summary.length > 3500 ? summary.slice(0, 3500) + "\n…" : summary
  if (process.platform === "darwin") return osascript(text)
  if (process.platform === "win32") return windowsDialog(text)
  if (process.platform === "linux" || process.platform === "freebsd" || process.platform === "openbsd") return linuxDialog(text)
  return "unavailable"
}
