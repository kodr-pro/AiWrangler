export interface MdSection {
  level: number
  title: string
  text: string
  line: number
}

export function splitMarkdown(md: string): MdSection[] {
  const lines = md.split("\n")
  const sections: MdSection[] = []
  let current: MdSection | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m) {
      if (current) sections.push(current)
      current = { level: m[1]!.length, title: m[2]!.trim(), text: "", line: i + 1 }
    } else if (current) {
      current.text += line + "\n"
    }
  }
  if (current) sections.push(current)
  return sections.map((s) => ({ ...s, text: s.text.trim() }))
}

export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}
