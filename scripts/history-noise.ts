import { loadConfig, expandPath } from "../src/config.js"
import { repoDirs, recentCommits, commitDiff } from "../src/git/diff.js"
import { checkRepoDiff } from "../src/gates/deterministic/rules.js"

const loaded = loadConfig(process.cwd(), {})
const dirs = repoDirs(loaded.config, loaded.root)
const byRule = new Map<string, number>()
const samples = new Map<string, string[]>()
for (const { repo, dir } of dirs.slice(0, 5)) {
  for (const c of recentCommits(dir, 10)) {
    const files = commitDiff(dir, c.sha)
    if (files.length === 0) continue
    for (const f of checkRepoDiff({ repo, repoDir: dir, files }, loaded.config)) {
      byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1)
      if ((samples.get(f.rule)?.length ?? 0) < 3) {
        samples.set(f.rule, [...(samples.get(f.rule) ?? []), `${repo}/${f.file}:${f.line} | ${f.evidence.slice(0, 70)}`])
      }
    }
  }
}
for (const [rule, n] of [...byRule].sort()) {
  console.log(`${rule}: ${n}`)
  for (const s of samples.get(rule) ?? []) console.log(`   ${s}`)
}
