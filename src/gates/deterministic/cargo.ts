import { spawn, type ChildProcess } from "node:child_process"

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], signal: opts.signal })
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          proc.kill("SIGKILL")
        }, opts.timeoutMs)
      : undefined
    proc.stdout?.on("data", (d) => (stdout += d.toString()))
    proc.stderr?.on("data", (d) => (stderr += d.toString()))
    const done = (code: number | null, extra = "") => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr: stderr + extra, timedOut })
    }
    proc.on("error", (err) => done(null, String(err)))
    proc.on("close", (code) => done(code))
  })
}

export function tail(text: string, lines: number): string {
  const arr = text.trimEnd().split("\n")
  return arr.length <= lines ? text.trimEnd() : arr.slice(-lines).join("\n")
}

export interface TestStats {
  passed: number
  failed: number
  suites: number
}

export function summarizeTests(output: string): TestStats {
  const passed = [...output.matchAll(/test result: \w+\. (\d+) passed/g)].reduce((n, m) => n + Number(m[1]), 0)
  const failed = [...output.matchAll(/test result: \w+\. \d+ passed; (\d+) failed/g)].reduce((n, m) => n + Number(m[1]), 0)
  const suites = (output.match(/test result:/g) ?? []).length
  return { passed, failed, suites }
}

export interface CargoStep {
  label: string
  ok: boolean
  summary: string
  errors: string[]
  output: string
}

export async function cargoCheck(
  repoDir: string,
  opts: { package?: string; release?: boolean; tests?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CargoStep[]> {
  const args = ["--color", "never"]
  if (opts.package) args.push("-p", opts.package)
  const steps: CargoStep[] = []

  const checkArgs = ["check", ...args]
  const check = await run(["cargo", ...checkArgs], { cwd: repoDir, timeoutMs: opts.timeoutMs ?? 10 * 60_000, ...(opts.signal ? { signal: opts.signal } : {}) })
  const checkOut = check.stdout + "\n" + check.stderr
  steps.push({
    label: "cargo check",
    ok: !check.timedOut && check.code === 0,
    summary: check.timedOut ? "TIMED OUT" : check.code === 0 ? "OK" : `FAILED (exit ${check.code})`,
    errors: errorLines(checkOut),
    output: checkOut,
  })
  if (!steps[0]!.ok) return steps

  if (opts.tests) {
    const test = await run(["cargo", "test", ...args], { cwd: repoDir, timeoutMs: opts.timeoutMs ?? 10 * 60_000, ...(opts.signal ? { signal: opts.signal } : {}) })
    const testOut = test.stdout + "\n" + test.stderr
    const t = summarizeTests(testOut)
    steps.push({
      label: "cargo test",
      ok: !test.timedOut && test.code === 0,
      summary: test.timedOut ? "TIMED OUT" : test.code === 0 ? `OK: ${t.suites} suite(s), ${t.passed} passed, ${t.failed} failed` : `FAILED (exit ${test.code})`,
      errors: errorLines(testOut),
      output: testOut,
    })
  }
  return steps
}

export function errorLines(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => /\berror(\[|:)/i.test(l) || /^failures:$/m.test(l) || /test result: FAILED/i.test(l))
    .slice(0, 30)
}

export interface Diagnostic {
  file: string
  line: number | null
  col: number | null
  severity: string
  message: string
  code: string | null
  isRootCauseCandidate: boolean
}

export function parseCargoJson(output: string): Diagnostic[] {
  const diags: Diagnostic[] = []
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (msg?.reason !== "compiler-message" || !msg.message) continue
    const m = msg.message
    const spans: any[] = Array.isArray(m.spans) ? m.spans : []
    const primary = spans.find((s) => s.is_primary) ?? spans[0]
    diags.push({
      file: primary?.file_name ?? "",
      line: primary?.line_start ?? null,
      col: primary?.column_start ?? null,
      severity: m.level ?? "unknown",
      message: m.message ?? "",
      code: m.code?.code ?? null,
      isRootCauseCandidate: (m.level === "error" && (!m.code || !CASCADING_CODES.includes(m.code.code))) || m.level === "error: aborting",
    })
  }
  return diags
}

const CASCADING_CODES = ["E0432", "E0433", "E0603", "E0560"]
