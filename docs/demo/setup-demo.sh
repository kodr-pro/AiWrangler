#!/usr/bin/env bash
# Build the throwaway demo repo the GIF records against: a tiny workspace
# with the fixture corpus as ground truth and one deliberately bad edit.
# Trigger strings are assembled at runtime so this script's own text does
# not trip the deterministic rules when committed here.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
demo_root="${DEMO_ROOT:-/tmp/aiwrangler-demo}"
repo="$demo_root/demo-repo"

if [ -e "$demo_root" ]; then
  echo "refusing to touch existing $demo_root; remove it yourself or set DEMO_ROOT" >&2
  exit 1
fi
mkdir -p "$repo/worker/src" "$repo/.aiwrangler"

# corpus: the fixture ground truth ships with the repo
for f in spec.md rules.md divergences.md questions.md plan.md; do
  cp "$repo_root/evals/corpus/$f" "$repo/$f"
done

# demo sessions are copied next to the repo so the tape can cat them by
# absolute path after cd
cp "$repo_root/docs/demo/s1-config.ndjson" "$demo_root/s1-config.ndjson"
cp "$repo_root/docs/demo/s2-plan.ndjson" "$demo_root/s2-plan.ndjson"
cp "$repo_root/docs/demo/s3-check.ndjson" "$demo_root/s3-check.ndjson"

cat > "$repo/aiwrangler.config.json" <<'EOF'
{
  "model": "jev-1.13.0",
  "egress": { "semantic": true, "warnOncePerSession": false },
  "corpus": {
    "spec": "spec.md",
    "rules": "rules.md",
    "divergences": "divergences.md",
    "questions": "questions.md",
    "plan": "plan.md"
  },
  "repos": { "super": ".", "members": ["worker"], "reviewed": [] }
}
EOF

cat > "$repo/worker/src/len.rs" <<'EOF'
// Length field reader for the worker codec.
pub fn read_len(bytes: &[u8]) -> u32 {
    let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    n
}
EOF

printf '.aiwrangler/\n' > "$repo/.gitignore"

git -C "$repo" init -q
git -C "$repo" -c user.email=demo@aiwrangler -c user.name=demo add -A
git -C "$repo" -c user.email=demo@aiwrangler -c user.name=demo commit -qm "baseline"

# the bad edit: silent default plus a comment claiming the opposite
python3 - "$repo/worker/src/len.rs" <<'PY'
import sys
from pathlib import Path

trig = ".unwrap" + "_or(0)"
Path(sys.argv[1]).write_text(
    "pub fn read_len(bytes: &[u8]) -> u32 {\n"
    "    // Returns an error on malformed length\n"
    "    let n = bytes.try_into()" + trig + "\n"
    "}\n"
)
PY

echo "demo repo ready: $repo (dirty worker/src/len.rs)"
