import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig, findConfigFile } from "./config.js"
import { loadCorpus } from "./groundtruth/corpus.js"
import { runDeterministic, formatFindings } from "./gates/deterministic/index.js"
import { diffFingerprint } from "./loop.js"
import { setJevWarnSink } from "./jev/client.js"
import { Ledger } from "./ledger.js"
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

interface WatchState {
  lastFingerprint: string
  nudges: number
  greenAnnounced: boolean
}

export const WranglerWatchPlugin: Plugin = async ({ client, directory }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "aiwrangler-watch", level, message } }).catch(() => {})

  if (!directory || (!findConfigFile(directory) && !process.env.AIWRANGLER_CONFIG)) {
    return {}
  }

  let loaded
  try {
    loaded = loadConfig(directory)
  } catch (err) {
    void log("error", `aiwrangler config failed to load; watch plugin inactive: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
  const statePath = join(loaded.root, ".aiwrangler", "watch-state.json")

  setJevWarnSink((message) => {
    void log("warn", message)
    client.tui
      .showToast({ body: { title: "aiwrangler", message, variant: "warning", duration: 8000 } })
      .catch(() => {})
    try {
      new Ledger(loaded.config, loaded.root).append({ ts: new Date().toISOString(), kind: "notice", message })
    } catch {
      /* ledger unavailable; the app log above still captured it */
    }
  })
  let watch: WatchState = { lastFingerprint: "", nudges: 0, greenAnnounced: false }
  try {
    if (existsSync(statePath)) watch = { ...watch, ...(JSON.parse(readFileSync(statePath, "utf8")) as WatchState) }
  } catch {
    watch = { lastFingerprint: "", nudges: 0, greenAnnounced: false }
  }
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(watch), "utf8")
  }

  async function nudge(sessionID: string, text: string) {
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
    } catch (err) {
      void log("warn", `nudge failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    event: async ({ event }) => {
      const e = event as { type?: string; properties?: Record<string, any> }
      if (e.type !== "session.idle") return
      const props = e.properties ?? {}
      const sessionID = String(props.sessionID ?? props.id ?? "")
      if (!sessionID) return

      try {
        const loaded = loadConfig(directory!)
        if (!loaded.config.gates.session.nudge) return
        const report = await runDeterministic(loaded.config, loaded.root, { cargo: false })
        const fingerprint = diffFingerprint(
          report.repoDiffs
            .flatMap((d) => d.files.map((f) => f.path + String(f.hunks.length)))
            .join("|"),
        )
        if (fingerprint === watch.lastFingerprint) return
        watch.lastFingerprint = fingerprint

        const blocking = report.findings.filter((f) => f.severity === "block" || f.severity === "human")
        if (blocking.length > 0 && watch.nudges < loaded.config.gates.session.maxNudges) {
          watch.nudges++
          watch.greenAnnounced = false
          save()
          await nudge(
            sessionID,
            [
              "aiwrangler gate: deterministic findings on the current dirty files. Fix these before finishing, then run the wrangler_check tool for the full battery:",
              "",
              formatFindings(blocking),
            ].join("\n"),
          )
          return
        }

        if (report.repoDiffs.length > 0 && blocking.length === 0 && !watch.greenAnnounced && watch.nudges > 0) {
          watch.greenAnnounced = true
          save()
          await nudge(
            sessionID,
            "aiwrangler gate: previous deterministic findings are resolved. Run the wrangler_check tool for the full semantic battery before declaring done.",
          )
        }
        if (report.repoDiffs.length === 0) {
          watch.nudges = 0
          watch.greenAnnounced = false
          save()
        }
      } catch (err) {
        void log("warn", `idle check error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
