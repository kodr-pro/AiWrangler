# Review rules

Fixture review rules for the AiWrangler verify suite. One numbered entry per
rule; indented lines continue the entry.

1. Silent defaults are bugs. Malformed or missing values must become errors, never a substituted literal, empty container, or defaulted struct.

2. Public API in reviewed repos is a commitment. Adding public items requires an enumerated-surface argument naming what the existing surface is missing.

3. Claims must match the diff. If a commit message or PR body says the change does X, the diff must visibly do X; unmentioned behavior changes are findings too.

4. Documentation drift. Changed behavior requires updated docs in the same change; a doc that contradicts the code is a finding.

5. Scope discipline. A change addresses its task; drive-by rewrites and unrelated refactors ride in their own change.

6. House style. No em dashes in added lines; prose and comments wrap near 80 columns; no AI-identifying trailers in commit messages; no relative paths from one repo into a sibling, name the sibling instead.

7. Deferred work is tagged. A deferred item names the backend it waits on; an untagged deferred marker is a finding.

8. Behavior ships with tests. New behavior comes with a test that fails without it; test-only changes state what behavior they will pin.

9. Resource budgets state units and ownership. Declarations of fuel, budgets, or limits say what unit they measure and who pays.

10. Sensitive material gets human eyes. Changes touching secret material, signing roots, or data-reveal paths require human review even when mechanically correct.
