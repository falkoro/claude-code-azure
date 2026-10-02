---
name: setup
description: Check and fix the prerequisites for the azure plugin — the az CLI, the azure-devops extension, the signed-in account, and the default Azure DevOps organization and project. Use when an az or az devops command fails with a missing extension, login, organization, or project, or when the user asks to set up or troubleshoot the azure plugin.
---

# Azure plugin setup check

Walk through these checks in order, run each read-only command directly, and stop at the first one that fails with the fix for it. Finish with a short status table: az CLI, azure-devops extension, Azure sign-in, Azure DevOps defaults, Azure DevOps access.

Never print, request, or store tokens or secrets. Do not run `az account get-access-token`. If the user wants to paste a personal access token (PAT) into the chat, stop them and point them to `az devops login`, which reads it from a hidden prompt.

## 1. az CLI

```bash
az version -o json
```

If `az` is not found, tell the user to install the Azure CLI (https://learn.microsoft.com/cli/azure/install-azure-cli) and start a new shell.

## 2. azure-devops extension

```bash
az extension show --name azure-devops --query version -o tsv
```

If it isn't installed, the fix is `az extension add --name azure-devops`. That changes the user's machine, so show the command and get an explicit yes before running it (see "Confirm before changing anything" below).

## 3. Signed-in account

```bash
az account show --query "{user:user.name, subscription:name, subscriptionId:id, tenant:tenantId}" -o json
```

If this says to run `az login`, the user has to sign in themselves because it is interactive. Suggest they type `! az login` in the prompt (add `--tenant <tenant>` if they use more than one tenant).

Pipeline approvals, stage retries, and log downloads use `az rest` with the user's Microsoft Entra ID sign-in, so they need `az login`. The other Azure DevOps commands also work with a PAT set up through `! az devops login --organization https://dev.azure.com/<org>`.

## 4. Azure DevOps defaults

```bash
az devops configure --list
```

Azure DevOps commands need an organization and usually a project. They take them from these defaults, from `--org` / `--project` flags, or, inside a clone of an Azure Repos repository, from the git remote.

If the organization or project is missing, ask the user for them and offer to run:

```bash
az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>
```

That writes to the user's az configuration, so confirm first.

## 5. Azure DevOps access

```bash
az devops project list --query "value[].name" -o json
```

A 401 or "TF400813" error means the signed-in identity has no access to that organization: check they used the right account or tenant, or set up a PAT with `az devops login`.

## Confirm before changing anything

Read-only commands run right away. For any command that changes state:

1. Show a **Planned change** block: what it changes, where, and the exact command.
2. Ask with AskUserQuestion (options: "Run it" and "Cancel"). Without that tool, ask in plain text and wait for an explicit yes.
3. Run exactly the command you showed, only after a clear yes, then report the result.

Claude Code may show its own permission prompt for the same command. That prompt is a second check and does not replace this one.
