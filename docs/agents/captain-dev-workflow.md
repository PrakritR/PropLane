# Captain development workflow

The single workflow contract is [AGENTS-prakrit.md](AGENTS-prakrit.md):
work on the assigned standing lane, validate, push the lane, then wait for the
captain's `/promote prakrit`. The ordered release rungs are `/promote main`,
`/promote staging`, and `/promote staging to production`.

Read [the ship gate](../ship-gate.md) for required review/testing evidence and
[deployment workflow](deployment-workflow.md) for environment and migration safety.
[Sandbox review](sandbox-open-review.md) owns user-facing review URLs.
Akhil's [separate process](AGENTS-akhil.md) is unchanged.
