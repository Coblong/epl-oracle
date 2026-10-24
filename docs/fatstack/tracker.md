# Tracker: GitHub

Repository: Coblong/epl-oracle.
Use the authenticated gh CLI. The GitHub connector is an alternative.

## Operations

- Read: gh issue view <number> --repo Coblong/epl-oracle --comments
- List: gh issue list --repo Coblong/epl-oracle --state open --limit 1000 --json number,title,labels
- Create: gh issue create --repo Coblong/epl-oracle --title "<title>" --body-file <file>
- Comment: gh issue comment <number> --repo Coblong/epl-oracle --body-file <file>
- Transition: gh issue edit <number> --repo Coblong/epl-oracle --add-label "<new>" --remove-label "<old>"
- Close: gh issue close <number> --repo Coblong/epl-oracle

Verify every write by reading the affected issue or PR.
Use body files for multiline text.

## Statuses

| Status | GitHub representation |
| --- | --- |
| ready | Open issue with ready label |
| in progress | Open issue with in-progress label |
| in review | Open issue with in-review label and linked ready PR |
| done | Closed issue with completed, merged implementation |

Keep status labels mutually exclusive.
A ready label does not override unfinished dependencies.
Follow the invoked implementation skill's authorization rules.

## Dependencies

Record blocking issues under a "Blocked by" heading.
Existing "Dependencies" sections remain valid.
Start dependent work only after blockers are merged into its base,
unless the user explicitly agrees to stacked development.

## Pull requests

- Base: main.
- Branch: codex/issue-<number>-<slug>.
- Use an isolated checkout for each implementation worker.
- Link the issue with Closes #<number>.
- Create PRs in ready state.
- Reply to and resolve addressed PR comments after verifying fixes.
- Merge only with explicit user authorization.
- Verify merged changes and issue status before starting dependents.

## Checks

- Install dependencies: npm ci.
- Full suite: npm test.
- PostgreSQL integration: npm test with TEST_DATABASE_URL pointing
  to an isolated test database.
- CI provisions PostgreSQL 17 and runs npm ci followed by npm test.
- Report skipped or unavailable checks explicitly.
- Follow ticket-specific verification requirements.

## Milestones

Use native GitHub milestones named:
<feature-slug> M<N>: <name>.

Record the native milestone number, URL and goal in the feature's
requirements.md. Phase numbers are not native milestone numbers.
Obtain approval before milestone writes.

- List all:
  gh api --paginate 'repos/Coblong/epl-oracle/milestones?state=all&per_page=100'
- Create:
  gh api --method POST repos/Coblong/epl-oracle/milestones --input <json-file>
- Assign:
  gh issue edit <number> --repo Coblong/epl-oracle --milestone "<exact-title>"
- List all members:
  gh api --paginate 'repos/Coblong/epl-oracle/issues?milestone=<number>&state=all&per_page=100'
  Exclude pull requests and retain open and closed issues.
- Update:
  gh api --method PATCH repos/Coblong/epl-oracle/milestones/<number> --input <json-file>

Reuse recorded milestone identities, including closed milestones.
