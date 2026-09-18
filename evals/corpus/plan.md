# Plan

Fixture plan for the AiWrangler verify suite. Sections whose title names a
one-way door or a launch gate become door sections in the corpus.

## One-way doors (fixture)

The wire format version is frozen for the first release; changing it is a
one-way door. The error taxonomy names are public API; renaming them is a
one-way door.

## Launch gate (fixture)

End to end: a sponsored node holds a lease, signs with the committee, and
its certificates verify against the published roots. A node whose lease
expired is an observer. Every rejection cites a typed error.
