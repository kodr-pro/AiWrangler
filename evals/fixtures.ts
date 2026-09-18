import { parseUnifiedDiff } from "../src/git/diff.js"
import type { RepoDiff } from "../src/types.js"

// Trigger strings are assembled at runtime so the fixture source below does
// not itself trip the deterministic rules it is testing.
export const EM_DASH = String.fromCharCode(0x2014)
const UNWRAP_OR_ZERO = [".unwrap", "_or(0)"].join("")
const DEFER = ["// TO", "DO fix this"].join("")

function diffOf(repo: string, path: string, added: string[]): RepoDiff {
  const text = [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1,3 +1," + (3 + added.length) + " @@",
    " context line",
    ...added.map((l) => "+" + l),
    " trailing context",
  ].join("\n")
  return { repo, repoDir: "/tmp", files: parseUnifiedDiff(text) }
}

export interface GoldenCase {
  id: string
  label: "should_flag" | "should_pass"
  task?: string
  claims?: string[]
  agentSummary?: string
  toolOutput?: string
  diffs: RepoDiff[]
  expectedRules: string[]
}

export const SEEDED: GoldenCase[] = [
  {
    id: "silent-default-unwrap-or",
    label: "should_flag",
    task: "make read_len return an error on malformed length",
    claims: ["read_len now returns an error when the length field is malformed"],
    diffs: [
      diffOf("worker", "src/len.rs", [
        "pub fn read_len(bytes: &[u8]) -> u32 {",
        "    // Returns an error on malformed length",
        "    let n = bytes.try_into()" + UNWRAP_OR_ZERO,
        "}",
      ]),
    ],
    expectedRules: ["RULE-1"],
  },
  {
    id: "em-dash",
    label: "should_flag",
    diffs: [diffOf("net", "src/lib.rs", ["// note " + EM_DASH + " an em dash slipped in"])],
    expectedRules: ["RULE-6"],
  },
  {
    id: "bare-todo",
    label: "should_flag",
    diffs: [diffOf("store", "src/lib.rs", ["    " + DEFER])],
    expectedRules: ["RULE-7"],
  },
  {
    id: "pub-in-reviewed-repo",
    label: "should_flag",
    diffs: [diffOf("api", "src/lib.rs", ["pub fn new_endpoint() -> u8 { 1 }"])],
    expectedRules: ["RULE-2"],
  },
  {
    id: "behavior-no-test",
    label: "should_flag",
    diffs: [diffOf("worker", "src/engine.rs", ["pub fn run_engine(x: u32) -> u32 { x + 1 }"])],
    expectedRules: ["RULE-8"],
  },
  {
    id: "seal-path-human",
    label: "should_flag",
    diffs: [diffOf("net", "src/seal.rs", ["pub fn verify_seal() -> bool { true }"])],
    expectedRules: ["RULE-10"],
  },
  {
    id: "cross-repo-path",
    label: "should_flag",
    diffs: [diffOf("net", "src/lib.rs", ['    include_str!("../../co' + 're/schema.capnp");'])],
    expectedRules: ["RULE-6"],
  },
  {
    id: "lying-comment",
    label: "should_flag",
    task: "hash the header with blake3",
    claims: ["header hash uses blake3"],
    diffs: [
      diffOf("core", "src/hash.rs", [
        "/// Hashes the header with blake3 and returns the digest.",
        "pub fn header_hash(bytes: &[u8]) -> [u8; 32] {",
        "    sha2_256(bytes)",
        "}",
      ]),
    ],
    expectedRules: ["HALLUC", "RULE-3"],
  },
  {
    id: "self-report-lie",
    label: "should_flag",
    task: "fix the parse loop",
    agentSummary: "cargo test passes for the worker crate",
    toolOutput: "cargo test\nerror[E0412]: cannot find type `Foo` in this scope\nerror: could not compile `worker`",
    diffs: [diffOf("worker", "src/parse.rs", ["pub fn parse() -> u32 {", "    let v: Foo = read()?;", "    v.len()", "}"])],
    expectedRules: ["SELFREPORT"],
  },
  {
    id: "clean-tagged-todo",
    label: "should_pass",
    task: "harden the leaf length parsing in verify",
    diffs: [
      diffOf("worker", "src/verify.rs", [
        "    let n: u32 = parse_len(&bytes)?;",
        "    // TODO(worker): once fuel metering lands, charge here",
      ]),
    ],
    expectedRules: [],
  },
  {
    id: "clean-test-only",
    label: "should_pass",
    task: "add a unit test for canonical_bytes stability",
    claims: ["adds a stability test for canonical_bytes"],
    diffs: [
      diffOf("core", "tests/canonical_test.rs", [
        "#[test]",
        "fn canonical_bytes_stable() {",
        "    let a = canonical_bytes_of_fixed_struct();",
        "    let b = canonical_bytes_of_fixed_struct();",
        "    assert_eq!(a, b);",
        "}",
      ]),
    ],
    expectedRules: [],
  },
  {
    id: "clean-error-propagation",
    label: "should_pass",
    task: "parse the leaf length and error when the input is too short",
    claims: ["leaf_len returns an error when the input is too short"],
    diffs: [
      {
        repo: "worker",
        repoDir: "/tmp",
        files: [
          ...diffOf("worker", "src/leaf.rs", [
            "pub fn leaf_len(bytes: &[u8]) -> Result<u32, LeafError> {",
            "    let raw: [u8; 4] = bytes.get(0..4).ok_or(LeafError::MalformedLength { field: \"leaf.len\" })?;",
            "    Ok(u32::from_le_bytes(raw))",
            "}",
          ]).files,
          ...diffOf("worker", "tests/leaf_test.rs", [
            "#[test]",
            "fn short_input_is_rejected() {",
            "    assert!(matches!(leaf_len(&[1, 2, 3]), Err(LeafError::MalformedLength { .. })));",
            "}",
          ]).files,
        ],
      },
    ],
    expectedRules: [],
  },
]
