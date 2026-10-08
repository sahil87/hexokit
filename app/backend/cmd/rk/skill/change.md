# HexoKit skill: change

Use when the user wants a large repository change coordinated through one operator:
**dedicated tmux server → operator → worker worktrees → integration branch → PR → main**.
This is a workflow for operating HexoKit, shipped as `rk skill change` with the binary.
Honor the repository's instructions and the user's existing authorization throughout.

## Establish the change

Derive or confirm the host, absolute repository path, target remote/branch, scope and
acceptance checks. Use the user's target branch; otherwise derive the remote default.
Check live `inventory` first for an operator already coordinating this same change.
Reuse that work instead of spawning a duplicate. IDs are scoped to a host and server.
Tools on one MCP endpoint operate only on that host; a server label is not an SSH host.

Assign a unique server label and integration branch, such as `payments-retry` and
`change/payments-retry`. Labels allow 1–64 letters, digits, underscores or hyphens.
Record the actual identities; examples here are placeholders, never facts to assume.

## Bootstrap through MCP

| Step | Tool and inputs | Evidence to retain |
|------|-----------------|--------------------|
| Discover | `inventory {}` | Observation time, server names, operator pane/window if present |
| Create | `new_server {"name":"payments-retry"}` | `{report:"created",server,ephemeral:false}` |
| Open operator | `operator {"server":"payments-retry","dir":"/abs/repo"}` | `{window,server,created,dir?,dir_rung?}` |
| Hand off | `operator_request {"server":"payments-retry","template":"user-message","window":"@N","text":"…"}` | Request receipt; replace `@N` with the returned operator window |
| Inspect | `inventory {"server":"payments-retry","agents_only":true}` | Live identities, cwd, lifecycle and errors |
| Ask for status | `operator_request {"server":"payments-retry","template":"brief-me"}` | Submission receipt; operator's subsequent report is separate |

Leave `ephemeral` false for durable project work: ephemeral servers skip snapshots
and can be bulk reaped. A live name collision is a refusal, not a successful reuse.
Inspect before retrying creation or a timed-out operator launch: it may already exist.
An existing operator is returned with `created:false`; `dir` does not relocate it.
Verify its pane cwd and existing assignment before handing it a new project.
Server creation needs tmux; launching the operator needs fab and its configured provider.
`operator_request` needs the daemon. Report a missing dependency or login wall precisely;
do not create credentials or silently redirect the job to another host.

CLI equivalents (JSON receipts have the standard `ok`/`result` envelope):

```sh
rk mux inventory --json
rk mux new payments-retry --json
rk operator -L payments-retry --dir /abs/repo --json
rk operator request user-message -L payments-retry --window @N --text '<handoff>' --json
```

## Handoff contract

Send one work item containing repository path, server label, target remote/branch,
integration branch, scope, acceptance checks and the next authorized action.
Tell the operator to read this topic and own coordination through completion:

> Work on /abs/repo on server payments-retry. Target origin/main; integrate on
> change/payments-retry. Implement <scope>; prove <acceptance checks>. Read
> `rk skill change`. Create an isolated integration worktree from the verified
> target head. Split useful independent work into worker branches/worktrees,
> collect their result artifacts, integrate completed work, resolve conflicts,
> run combined validation and raise one integration PR. Report blockers and the
> PR URL. <Merge when checks pass if authorized, otherwise return it for review.>
> Keep the server, panes and worktrees until cleanup is requested.

Resolve the bracketed choices from the user's instructions before delivery.
After bootstrap the user steers the operator; the operator coordinates workers.
Do not send the same request to worker panes as well. Use `user-message` for
conversation; it is never queued. Other fitting templates protect a busy operator
by queueing. A successful request means accepted/queued, not that the work finished.

## Operator execution

1. Inspect git status, repository instructions and existing worktrees. Fetch the
   selected remote and record the target head SHA. Create a separate integration
   worktree/branch from that SHA using the repository's supported worktree tool.
   Keep the user's checkout intact. Operate with explicit worktree paths.
2. Create only useful workers, with bounded tasks and separate worktrees/branches
   based on the integration branch. Give each worker scope, acceptance checks and
   an absolute result-file path. Use `rk riff`/fab per repository conventions;
   verify readiness before delivery (`rk skill messaging`). A parked login needs
   human attention. After delivery, use lifecycle/file waits, not readiness probes.
3. Track ownership and dependencies. A worker result names its branch, commit SHA,
   changed files, checks run and blockers. Commit and inspect the result before
   integrating; `idle` alone does not mean ready to merge. Coordinate overlapping
   changes before integration and keep uncommitted work out of merges.
4. Integrate ready branches into the integration worktree, following the repo's
   merge policy. Resolve conflicts there, verify the intended commits and inspect
   the combined diff against the current target. Run required combined checks.
   Changes to the target branch or integration diff invalidate affected checks.
5. Push the integration branch and create/update one PR against the target. Its
   description covers the final behavior, worker contributions and validation.
   Archive completed changes only when requested and according to repo rules;
   review and validate the combined archive diff in the integration PR too.
6. If merging is authorized, verify the current PR head, required checks/reviews,
   branch policy and conflicts, then use the repository's normal merge method.
   Record the merged commit and verify it is in the remote target. Otherwise
   report the reviewable PR and the exact remaining action. Never force push main.

## Durable status and completion

Keep coordination artifacts outside the committed product diff, for example under
the absolute git common directory at `hexokit/change/<server>/`. Record scope,
target SHA, integration branch/worktree, operator identity, each worker's identities,
result paths/commits/checks, integration checks, PR URL, blockers and observation time.
Update the artifact at milestones and report a short summary in the operator chat.

Read result files with the available host/file tools; `inventory` reports lifecycle,
not task completion or merge readiness, and MCP request receipts contain no reply.
Use `capture` to judge a stuck screen, not to parse a transcript or proof of success.
A partial inventory is incomplete evidence: retain errors and follow up on that host.

The final report names the PR, checks, integration head and remaining blockers.
Claim merged only after verifying the remote target contains the merge. Preserve
panes/worktrees for follow-up; committing archives never implies runtime cleanup.
