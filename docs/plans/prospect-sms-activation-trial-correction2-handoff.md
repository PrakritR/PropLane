# Prospect SMS activation trial correction 2 handoff

Date: 2026-09-12

## Goal and scope

Corrected TRIAL-FINAL-1 from
[`2026-09-12-prospect-sms-trial-bugbot-review.md`](../security/2026-09-12-prospect-sms-trial-bugbot-review.md)
on branch `prospect-sms-release` at unchanged HEAD
`b251d49f73c76f56804e14de956aea8ac66f7d5f`.

The correction changes only
`src/lib/agent/prospect-shadow-comparison.ts` and
`tests/unit/agent/prospect-shadow-comparison.test.ts`. This handoff is the only
additional file. Existing dirty source, test, review, and activation-plan files
were preserved. No external call, credential access, database operation, SMS
send, commit, push, or deployment was performed.

## Resulting behavior

The negative-evidence paths now compare conservative canonical decimal strings
instead of raw numeric token formatting. Canonicalization accepts plain integer
digits or standard comma thousands grouping, removes valid grouping commas, and
removes only trailing fractional zeroes. It preserves the currency marker and
percent suffix and does not use `Number`, floating-point parsing, or arithmetic.

Literal assertion proof remains unchanged, so formatting variants are not
promoted to `grounded`. With actual projected `get_listing_details` evidence for
Jain Home rent `$1,200`:

- `Jain Home rent is $1,200.` remains `grounded`.
- `Jain Home rent is $1200.` is `unknown` instead of `ungrounded`.
- `Jain Home rent is $1,200.00.` is `unknown` instead of `ungrounded`.
- A supported literal sentence followed by the equivalent `$1200` sentence is
  `unknown`, so the added-number path cannot restore the false negative.
- `Jain Home rent is $1,300.` remains `ungrounded`.

Signs, comparison operators, alternate currencies, percentages, malformed
spellings, URL case, cross-property assertions, negation, field swaps,
substrings, punctuation changes, and added unsupported claims retain the prior
conservative behavior and test coverage.

## Delegation and review

GPT-5.6 Terra implemented the scorer and unit-test correction. GPT-5.6 Luna
performed a separate read-only analysis and agreed that string-only
canonicalization in both `hasExactNumericMismatch` and
`hasAddedNumericClaim` is the safest bounded correction. Luna specifically
confirmed that literal grounding should remain unchanged and that signs,
operators, currency, and leading-zero distinctions must not be normalized.

## Validation

Focused unit test after the final frozen edit:

```sh
npx vitest run tests/unit/agent/prospect-shadow-comparison.test.ts
```

Exit 0: 1 file passed, 8 tests passed.

Scoped lint:

```sh
npx eslint src/lib/agent/prospect-shadow-comparison.ts tests/unit/agent/prospect-shadow-comparison.test.ts
```

Exit 0 with no output.

TypeScript:

```sh
NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit
```

Exit 0 with no output.

`git diff --check` for the two correction files exited 0 with no output.

Root reported the broad lint completed with exit 0 and 722 existing warnings,
with no errors. Root's concurrent full-unit run reported 1 failure among 9,980
passing tests because it loaded the comparison module while this correction was
being written; root owns the stable rerun after this freeze. The prior four
quiet-runtime failures all passed.

The repository-local feature-cycle document referenced by the installed skill,
`docs/agents/akhil-feature-cycle.md`, is absent from this worktree. The available
installed skill, root `AGENTS.md`, Akhil instructions, correction review, and
prior handoff governed this bounded pass. `.graphify/graph.json` is also absent,
so no graph refresh was performed.

## Fresh review

Run the final fresh Astra review against TRIAL-FINAL-1, this handoff, and the
current dirty diff. Root owns the stable broad rerun, keeper commit and push,
release gates, credentials, and any trial activation. External migration and
funded-model-key blockers remain outside this correction.
