# Working with PropLane's captain

Prakrit's agents work on their three assigned standing lanes. A request is
implemented and verified on its lane; it does not need a separate visual plan
approval. Scope, decisions, acceptance checks and status belong in the pane.
No Linear ticket unless requested. See the authoritative
[Prakrit workflow](../agents/AGENTS-prakrit.md).

Each lane hands off its commit, actual test results and localhost Review URL.
The captain types these commands in order in the lane's pane:

```
/promote prakrit
/promote main
/promote staging
/promote staging to production
```

Integration includes full no-mistakes and security review. Release retains
staging QA, database target/backup/migration verification, production preflight,
Vercel verification and iOS TestFlight distribution/App Store checks.
A branch fix is not a production fix. [The ship gate](../ship-gate.md) defines
the evidence; [deployment workflow](../agents/deployment-workflow.md) defines targets.

For an explicitly requested Linear export, choose the destination:
`npm run linear:export -- --ticket PRP-180 --out /tmp/PRP-180.md`.
Akhil uses [his separate process](../agents/AGENTS-akhil.md).
