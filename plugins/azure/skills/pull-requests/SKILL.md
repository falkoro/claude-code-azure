---
name: pull-requests
description: Azure Repos pull requests through the az CLI — list PRs (mine, assigned to me for review, or by repository), show a PR's description, changed files, reviewers and votes, policies, and comment threads, and post a comment or cast a vote. Use when the user asks about pull requests, code reviews, PR comments, or approving or rejecting a PR in Azure DevOps.
argument-hint: "[mine | review | repo <name> | <pr-id> | comment <pr-id> | vote <pr-id> <vote>]"
---

# Azure Repos pull requests

Request: $ARGUMENTS

With no request, list active PRs that I created and active PRs waiting for my review.

## Before you start

- Commands need the `azure-devops` extension and a default organization and project (or `--org` / `--project` flags). If a command fails because the extension, the sign-in, or the defaults are missing, follow the azure plugin's `setup` skill and tell the user what to fix.
- "Me" is the signed-in user: `az account show --query user.name -o tsv`. If the user signed in only with a PAT, ask for their Azure DevOps email address.
- Use `-o json` with a `--query` projection and summarize the result. Don't paste raw JSON at the user.
- Never print or request tokens. Don't run `az account get-access-token`.

## Read-only: run these directly

### List PRs

```bash
az repos pr list --status active --top 30 -o json \
  --query "[].{id:pullRequestId, title:title, repo:repository.name, author:createdBy.displayName, source:sourceRefName, target:targetRefName, draft:isDraft, created:creationDate}"
```

- Mine: add `--creator "<me>"`.
- Waiting for my review: add `--reviewer "<me>"`.
- One repository: add `--repository <name>`. List repositories with `az repos list --query "[].name" -o json`.
- Other states: `--status completed`, `--status abandoned`, or `--status all`.

### Show one PR

1. Summary, description, and reviewers with their votes:

   ```bash
   az repos pr show --id <pr-id> -o json \
     --query "{id:pullRequestId, title:title, description:description, status:status, draft:isDraft, mergeStatus:mergeStatus, author:createdBy.displayName, source:sourceRefName, target:targetRefName, repo:repository.name, repoId:repository.id, project:repository.project.name, reviewers:reviewers[].{name:displayName, vote:vote, required:isRequired}}"
   ```

   Vote values: 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected.

2. Policies (build validation, minimum reviewers, linked work items, and so on):

   ```bash
   az repos pr policy list --id <pr-id> -o json \
     --query "[].{policy:configuration.type.displayName, status:status, blocking:configuration.isBlocking}"
   ```

3. Changed files: take the latest iteration, then list its changes:

   ```bash
   az devops invoke --area git --resource pullRequestIterations \
     --route-parameters project=<project> repositoryId=<repoId> pullRequestId=<pr-id> \
     --api-version 7.1 -o json --query "value[-1].id"
   az devops invoke --area git --resource pullRequestIterationChanges \
     --route-parameters project=<project> repositoryId=<repoId> pullRequestId=<pr-id> iterationId=<iteration> \
     --api-version 7.1 -o json --query "changeEntries[].{change:changeType, path:item.path}"
   ```

   Summarize as counts by change type plus the file list grouped by folder. If the user is in a local clone of the repository, `git fetch origin <source> <target>` followed by `git diff --stat origin/<target>...origin/<source>` gives line counts too.

4. Comment threads:

   ```bash
   az devops invoke --area git --resource pullRequestThreads \
     --route-parameters project=<project> repositoryId=<repoId> pullRequestId=<pr-id> \
     --api-version 7.1 -o json \
     --query "value[?!isDeleted && comments[0].commentType=='text'].{id:id, status:status, file:threadContext.filePath, line:threadContext.rightFileStart.line, comments:comments[].{by:author.displayName, text:content}}"
   ```

   Show active threads first, each with its file and line when it has one.

Present a PR as a short brief: title and status, description, change summary, reviewers and votes, blocking policies, and open threads.

## State-changing: confirm first

Every command in this section needs the confirmation sequence in "Confirm before changing anything" below.

### Post a comment

Write the request body to a temporary file, then post it. A new top-level comment:

```bash
f="${TMPDIR:-/tmp}/azure-pr-<pr-id>-comment.json"
cat > "$f" <<'JSON'
{"comments": [{"parentCommentId": 0, "content": "<comment text>", "commentType": 1}], "status": 1}
JSON
az devops invoke --area git --resource pullRequestThreads \
  --route-parameters project=<project> repositoryId=<repoId> pullRequestId=<pr-id> \
  --http-method POST --in-file "$f" --api-version 7.1 -o json --query "{thread:id, status:status}"
```

A reply in an existing thread posts `{"parentCommentId": 1, "content": "<comment text>", "commentType": 1}` to `--resource pullRequestThreadComments` with the extra route parameter `threadId=<thread-id>`. Make sure the JSON is valid, and escape quotes and newlines in the comment text.

### Cast a vote

```bash
az repos pr set-vote --id <pr-id> --vote <approve|approve-with-suggestions|wait-for-author|reject|reset> -o json \
  --query "{id:pullRequestId, title:title}"
```

## Confirm before changing anything

Read-only commands (list, show, and GET requests) run right away. Every state-changing command follows these steps, even when the user asked for it in the same message:

1. Resolve every value first with read-only commands: PR ID, repository, project, thread. Don't guess.
2. Show a **Planned change** block: the action, the PR by title and ID, the full comment text or the vote, and the exact command or commands.
3. Ask with AskUserQuestion (options: "Run it" and "Cancel"). Without that tool, ask in plain text and wait for an explicit yes. Anything other than a clear yes means don't run it.
4. Run exactly what you showed. If anything in the plan changes, including the comment wording, confirm again. One confirmation covers only the changes listed in that block.
5. Report the outcome from the command output.

Claude Code may also show its own permission prompt for these commands, because the plugin's hook asks for one. That prompt is a second check and does not replace this one.
