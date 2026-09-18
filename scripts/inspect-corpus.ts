import { loadCorpusFrom } from "../src/index.js"

const { corpus } = loadCorpusFrom(process.cwd())
const byKind = new Map<string, number>()
for (const s of corpus.sections) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1)
console.log("sections by kind:", Object.fromEntries(byKind))
console.log("")
console.log("ruled entries:")
for (const s of corpus.sections.filter((x) => x.status === "ruled" || x.status === "answered")) {
  console.log(`  ${s.id} [${s.status}] ${s.title.slice(0, 70)}`)
  console.log(`    ruling: ${(s.ruling ?? "").slice(0, 100)}`)
}
console.log("")
console.log("paper sections:", corpus.sections.filter((s) => s.kind === "paper").map((s) => s.id).join(" "))
const ix = corpus.sections.find((s) => s.id === "PAPER-IX-E")
console.log("")
console.log("sample PAPER-IX-E:", ix ? ix.title + " | " + ix.text.slice(0, 140).replace(/\n/g, " ") : "MISSING")
const d24 = corpus.sections.find((s) => s.id === "DIV-D-24")
console.log("sample DIV-D-24:", d24 ? `[${d24.status}] ${d24.title.slice(0, 80)}` : "MISSING")
const doors = corpus.sections.filter((s) => s.kind === "door")
console.log("doors:", doors.map((d) => d.id).join(" "))
