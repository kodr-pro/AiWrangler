export function stripCommentsAndStrings(code: string): string {
  const out: string[] = []
  let i = 0
  const n = code.length
  let line = 1
  let col = 0

  const push = (ch: string) => {
    out.push(ch)
    if (ch === "\n") {
      line++
      col = 0
    } else col++
  }
  const blank = (ch: string) => {
    if (ch === "\n") out.push("\n")
    else out.push(" ")
    if (ch === "\n") {
      line++
      col = 0
    } else col++
  }
  const startsWith = (s: string) => code.startsWith(s, i)

  while (i < n) {
    const c = code[i]!

    if (startsWith("//")) {
      while (i < n && code[i] !== "\n") {
        blank(code[i]!)
        i++
      }
      continue
    }
    if (startsWith("/*")) {
      blank("/")
      blank("*")
      i += 2
      while (i < n && !startsWith("*/")) {
        blank(code[i]!)
        i++
      }
      blank("*")
      blank("/")
      i += 2
      continue
    }
    let rawHashes = 0
    if (c === "r" || c === "b") {
      let j = i + (c === "b" ? 1 : 0)
      if (code[j] === "r") {
        j++
        let hashes = 0
        while (code[j] === "#") {
          hashes++
          j++
        }
        if (hashes > 0 && code[j] === '"') {
          const closer = `"` + "#".repeat(hashes)
          const end = code.indexOf(closer, j + 1)
          const stop = end === -1 ? n : end + closer.length
          while (i < stop) {
            blank(code[i]!)
            i++
          }
          continue
        }
      }
    }
    if (c === '"') {
      blank('"')
      i++
      while (i < n && code[i] !== '"') {
        if (code[i] === "\\") {
          blank("\\")
          i++
          if (i < n) {
            blank(code[i]!)
            i++
          }
          continue
        }
        blank(code[i]!)
        i++
      }
      blank('"')
      i++
      continue
    }
    if (c === "'") {
      let j = i + 1
      let len = 0
      while (j < n && code[j] !== "'" && code[j] !== "\n" && len < 4) {
        if (code[j] === "\\") j++
        j++
        len++
      }
      if (j < n && code[j] === "'") {
        while (i <= j) {
          blank(code[i]!)
          i++
        }
        continue
      }
    }
    push(c)
    i++
  }
  return out.join("")
}
