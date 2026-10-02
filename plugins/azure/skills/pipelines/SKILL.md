---
name: pipelines
description: Azure Pipelines through the az CLI — list recent runs, show a run's status with its failed stages, jobs, and failing log excerpt, rerun a pipeline or retry failed stages, and list, approve, or reject pending pipeline approvals. Use when the user asks about builds, pipeline runs, CI failures, deployments waiting for approval, or approving or rejecting a pipeline in Azure DevOps.
argument-hint: "[runs | <run-id> | rerun <run-id> | approvals | approve <approval> | reject <approval>]"
---

# Azure Pipelines

Request: $ARGUMENTS

With no request, list recent runs and pending approvals.

## Before you start

- Commands need the `azure-devops` extension and a default organization and project (or `--org` / `--project` flags). If a command fails because the extension, the sign-in, or the defaults are missing, follow the azure plugin's `setup` skill and tell the user what to fix.
- `az devops configure --list` shows the defaults. `<org-url>` below is the organization URL, such as `https://dev.azure.com/contoso`. `<org>` is its last segment, `contoso`.
- `az rest` calls use `--resource 499b84ac-1321-427f-aa17-267ca6975798`, the Azure DevOps application ID, so the request uses the user's `az login` session. They don't work with a PAT-only `az devops login`. In that case, give the user the run's web link instead.
- Use `-o json` with a `--query` projection and summarize the result. Don't paste raw JSON at the user.
- Never print or request tokens. Don't run `az account get-access-token`.

## Read-only: run these directly

### Recent runs

```bash
az pipelines runs list --top 10 --query-order QueueTimeDesc -o json \
  --query "[].{id:id, pipeline:definition.name, pipelineId:definition.id, number:buildNumber, branch:sourceBranch, status:status, result:result, queued:queueTime, by:requestedFor.displayName}"
```

Add filters as needed: `--pipeline-ids <id>`, `--branch <branch>`, `--result failed`, `--status inProgress`, `--requested-for <user>`. To find a pipeline's ID by name, run `az pipelines list --name "<name>" --query "[].{id:id, name:name}" -o json`.

Show the runs as a compact table, with failed runs marked clearly.

### One run: status, failures, and log excerpt

1. Run summary:

   ```bash
   az pipelines runs show --id <run-id> -o json \
     --query "{id:id, pipeline:definition.name, pipelineId:definition.id, number:buildNumber, branch:sourceBranch, commit:sourceVersion, status:status, result:result, project:project.name, started:startTime, finished:finishTime, by:requestedFor.displayName, web:_links.web.href}"
   ```

2. Failed stages, jobs, and tasks from the timeline:

   ```bash
   az devops invoke --area build --resource timeline \
     --route-parameters project=<project> buildId=<run-id> --api-version 7.1 -o json \
     --query "records[?result=='failed'].{type:type, name:name, stage:identifier, parentId:parentId, id:id, logUrl:log.url, errors:issues[?type=='error'].message}"
   ```

   Show the failure path, stage › job › task, with the error messages from `errors`. Records whose type is `Stage` carry the stage name to use for a stage retry in `stage`.

3. Log excerpt for each failed task that has a `logUrl`:

   ```bash
   az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 --url "<logUrl>" > "${TMPDIR:-/tmp}/azure-run-<run-id>-<record-id>.log"
   grep -n -B8 -A4 '##\[error\]' "${TMPDIR:-/tmp}/azure-run-<run-id>-<record-id>.log" | tail -n 60
   ```

   If no line has `##[error]`, show the last 40 lines instead (`tail -n 40`). Quote only the relevant excerpt, then say what most likely failed and point to the run's web link.

### Pending approvals

```bash
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --url "https://dev.azure.com/<org>/<project>/_apis/pipelines/approvals?state=pending&\$expand=steps&api-version=7.1" -o json \
  --query "value[].{id:id, pipeline:pipeline.name, runName:pipeline.owner.name, runId:pipeline.owner.id, created:createdOn, instructions:instructions, minApprovers:minRequiredApprovers, approvers:steps[].assignedApprover.displayName}"
```

List each approval with its pipeline, run, who can approve it, and its instructions. Other checks, such as business hours or required templates, can't be approved here. Point to the run's web page for those.

## State-changing: confirm first

Every command in this section needs the confirmation sequence in "Confirm before changing anything" below.

### Rerun a pipeline

This queues a new run of the same pipeline on the same branch. Take `pipelineId` and `branch` from `runs show`:

```bash
az pipelines run --id <pipeline-id> --branch <branch> -o json --query "{id:id, number:buildNumber, status:status, web:_links.web.href}"
```

### Retry failed stages of the same run

This retries one failed stage inside the existing run. Take `<stage>` from the `stage` field of a failed `Stage` record in the timeline:

```bash
az rest --method patch --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --url "https://dev.azure.com/<org>/<project>/_apis/build/builds/<run-id>/stages/<stage>?api-version=7.1" \
  --body '{"state": "retry", "forceRetryAllJobs": false}'
```

### Approve or reject an approval

```bash
az rest --method patch --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --url "https://dev.azure.com/<org>/<project>/_apis/pipelines/approvals?api-version=7.1" \
  --body '[{"approvalId": "<approval-id>", "status": "approved", "comment": "<comment>"}]'
```

Use `"status": "rejected"` to reject. Ask for a comment, or use an empty string. The response shows the approval's new status. If it is still `pending`, more approvers are required.

## Confirm before changing anything

Read-only commands (list, show, and GET requests) run right away. Every state-changing command follows these steps, even when the user asked for it in the same message:

1. Resolve every value first with read-only commands: IDs, names, organization, project, stage. Don't guess.
2. Show a **Planned change** block: the action, the target by name and ID (for example "Approve the *Production* stage of *web-app* run 20261002.3"), and the exact command or commands.
3. Ask with AskUserQuestion (options: "Run it" and "Cancel"). Without that tool, ask in plain text and wait for an explicit yes. Anything other than a clear yes means don't run it.
4. Run exactly what you showed. If anything in the plan changes, confirm again. One confirmation covers only the changes listed in that block.
5. Report the outcome from the command output.

Claude Code may also show its own permission prompt for these commands, because the plugin's hook asks for one. That prompt is a second check and does not replace this one.
