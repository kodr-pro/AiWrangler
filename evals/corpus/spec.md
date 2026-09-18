# Example protocol spec

Fixture ground truth for the AiWrangler verify suite. Synthetic content: it
exists so retrieval and gate checks run anywhere, and as a format reference
for your own corpus.

## 1. Transport framing (I)

Every message on the wire carries a version, a length, and a payload digest.
The length field is parsed strictly: a truncated or oversized length is a
framing error and must surface as an error, never as a zero or defaulted
value.

## 2. Error propagation (II)

Malformed input, unreadable state, and failed preconditions are errors. Map
them to typed errors at the boundary; do not coerce them into default
values, empty containers, or silent success.

## 4. State store (IV)

The state store is multi-version: MVCC keeps multiple versions per key so
readers take a consistent snapshot without blocking writers. Every read is
versioned; every write creates a new version; garbage collection only
retires versions no active snapshot can observe.

## 12. Committee signatures (XII)

Committee certificates are threshold signatures. The signing scheme, the
aggregation of contributions, and the verification path are governed by the
rulings below; a certificate that fails verification is rejected with a
typed error identifying the failing contribution.

## 17. Observability (XVII)

Every subsystem exports counters for accepted, rejected, and errored work.
Dashboards and alerts read those counters; nothing infers health from
silence.

## 18. Node admission and governance (XVIII)

A node joins through an admission lease granted by governance seats. Seats
are held for a fixed term, votes are weighted by seat count, and admission
changes require a majority. Lease expiry demotes the node to observer until
governance renews it.
