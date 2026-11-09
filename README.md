# Renovate automation in n8n

All runtime automation uses n8n nodes, encrypted n8n credentials and a native Data Table. There is no helper service or additional running container.

PR listing, individual PR reads, review listing and repository metadata use native GitHub nodes. All GitHub requests use the encrypted **Renovate — GitHub App** credential, which handles installation-token creation and refresh. Targeted HTTP Request nodes cover CI checks/statuses, failed-job retries, pending-review submission, SHA-bound approvals/merges and branch cleanup. The installed GitHub node's merge action lacks an expected-SHA parameter; its review-create action passes `commitId` without translating it to GitHub's `commit_id`. These operations retain explicit REST request bodies to preserve commit safeguards. No custom GitHub node package is installed.

## Workflows

There are four workflows. Place them in one n8n folder if you want them grouped.

- **Check CI and approve**: scheduled parent workflow.
- **Merge queue**: scheduled parent workflow.
- **Repository configuration**: call-only workflow holding the repository list.
- **Shared policy worker**: call-only workflow used by both parents.

By default the CI monitor runs at :00 every hour and the merge queue at :15 and :45. The staggered schedules avoid routine repository-lock contention. The cron expressions are `0 0 * * * *` for CI and `0 15,45 * * * *` for merging, in the n8n instance timezone. Exports and the generator default to inactive and `dryRun: true` for safe installation. **Run settings** is a Code node on each parent workflow's canvas. Manual execution in the UI uses draft subworkflows; production runs use published versions.

## Behaviour

The monitor checks every hour. It considers open, non-draft PRs from the configured `renovateLogin` account whose source branch belongs to the configured repository. All observed CI checks and commit statuses must finish successfully; neutral/skipped check runs are accepted if at least one check or status succeeded. Missing or pending CI does not count as green.

Approval applies to the exact inspected commit. GitHub must return an APPROVED review for that commit, and a subsequent read must confirm it before the workflow records success. An existing pending review by this app for the same commit is submitted instead of creating another review. The first confirmed approval queues one Discord notification per PR. Rebases still require a valid approval on the current head, but do not send another approval notification; legacy per-commit notification records are recognized. Failed GitHub Actions jobs are retried once per workflow run and head commit, using GitHub's failed-jobs retry endpoint. A later failed attempt creates one persistent Discord notification. Unmapped/external failing checks are reported for manual attention. New commits get independent retry tracking.

The merge worker selects the oldest eligible PR with a current approval by this app, all observed CI green, no outstanding changes-requested review, and clean GitHub mergeability. It rechecks CI and pins the merge API request to the inspected head SHA. GitHub branch rules remain enforced; the app is not configured to bypass them.

Merge timing is controlled only by scheduled checks at :15 and :45. At most one eligible PR per repository is merged per run, using the configured `mergeMethod`, with a repository lock preventing concurrent workers. There is no elapsed-time cooldown or closed-PR history scan. Manual runs can merge immediately, and merges by other actors do not postpone the next scheduled check. `lastMerge` remains audit metadata.

After merging, the worker deletes the source branch only if it still points to the merged head SHA. Default branches and fork branches are never deleted. A deletion API failure retains cleanup state and blocks another merge until cleanup succeeds. Every successful merge produces a Discord notification, including branch-deletion status and the scheduled merge-check times.

## Persistent state and results

In n8n, open **Data tables → Renovate automation state**. Each repository has one row:

- `repository`: full `owner/repo` name.
- `lockOwner`: owning execution ID, blank when idle.
- `state`: JSON retry history, pending merge recovery, notification outbox and last merge time.
- `lastResult`, `lastRunAt`: sanitized final decisions and completion time.

A conditional Data Table update claims a blank lock. Checkpoints and release also require the owning execution ID. Two overlapping executions cannot own the same repository. A failed claim raises a visible error without external actions. Native GitHub list nodes always output an item, so empty PR/review lists reach normalization and allow normal lock release. Repository locks never expire automatically: after a crash, confirm the owning execution has stopped and inspect pending merge/retry intents before clearing `lockOwner` manually. Never clear a live execution's lock.

GitHub App private keys and Discord webhook URLs are in encrypted n8n credentials. Native GitHub App authentication creates and refreshes short-lived installation tokens without passing them through workflow items. Successful/manual payload storage remains disabled; parent workflows retain failures for diagnosis. Use `lastResult` for retained outcomes; live/manual executions show node output during testing. `build-native.mjs` reads the source secrets from `/secrets` when it creates those credentials; keep those files out of this repository.

Discord outbox delivery is retried on later polls. Delivery failures block further work rather than silently dropping messages. A network failure after Discord accepted a message can result in a duplicate on retry; cross-service delivery cannot guarantee exactly-once notification.

## Add another repository

1. Install the GitHub App on the repository.
2. In the state table, insert a row with `repository` set to the full name, `lockOwner` blank, and `state` equal to `{"prs":{},"lastMerge":null,"outbox":[]}`. Note its row ID.
3. Add an entry to **Repositories — edit here** in the configuration workflow. Set `repository`, `installationId`, `rowId`, `renovateLogin`, and `mergeMethod`. The worker's native GitHub and HTTP Request nodes use the credential for a single GitHub App installation. A repository on a different installation needs its own GitHub App credential and matching worker routing.
4. Run both parent workflows manually with `dryRun: true` to inspect decisions.

## Enable real automation after review

1. Keep the scheduled workflows inactive while reviewing their dry-run output.
2. Publish the two call-only workflows: configuration and shared worker. They have no autonomous schedules.
3. Change `dryRun` to `false` in **Run settings** of the monitor and merge workflows.
4. Publish those two scheduled workflows when ready to allow real approvals, CI retries, merges, deletions and Discord messages.

## Tests

Run the offline tests with `node --test *.test.mjs`. They cover CI classification, retry intent persistence, retry deduplication, one approval notification per PR across rebases and legacy records, notification retry, pending-review recovery, approval response/read-back verification, stale/dismissed approval rejection, changed heads, merge SHA binding, one merge per invocation without time gating, uncertain merge recovery, safe branch deletion and native pagination.

`test-native-lock.mjs` checks the Data Table locking against a live n8n instance, using a disposable table that it deletes afterwards. `check-discord.mjs` checks that the Discord webhook is reachable without sending a message.

Workflow JSON exports are in `workflows/`. They reference the credential IDs of the instance they were exported from and contain no private key or webhook URL. `build-native.mjs` regenerates inactive workflows from `native-policy.mjs`; it is an installation tool, not a runtime dependency.
