# Divergence register

Fixture divergences for the AiWrangler verify suite. RULED entries are the
effective truth; open entries block taking a side.

## Committee certificates

D-1 Signature scheme for committee certificates.

Whether certificates use FROST-style threshold signing or MuSig2 aggregation.
Both were implementable when filed.

**RULED (fixture, 2026-01-15): MuSig2.** Aggregation is deterministic given
the contribution set, which keeps certificate verification branch-free. FROST
remains the fallback if contribution ordering ever becomes observable.

D-2 Certificate verification failure detail.

How much detail a failed verification reveals to the submitter: the failing
contribution index, or only a boolean rejection.

**RULED (fixture, 2026-01-20): index only.** Operators need the index to
diagnose a misbehaving signer; full contribution contents stay private.

## State store

D-3 Snapshot retention window.

How many MVCC versions a snapshot may pin before the store forces a refresh.
No ruling yet; proposals range from exact pinning to a fixed window.
