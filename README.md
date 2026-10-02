# claude-code-azure

Azure and Azure DevOps plugin for Claude Code: pipelines and approvals, pull requests, work items, and Azure resources through the az CLI.

Ask Claude things like "why did last night's build fail?", "approve the production deployment", "what PRs are waiting for my review?", or "move bug 1423 to Active and link it to PR 87". The plugin drives `az`, `az devops`, `az repos`, `az boards`, and `az pipelines` in your terminal, so it uses the sign-in you already have. There is no MCP server to run and no token to paste. It covers Azure and Azure DevOps in one plugin.

> **Screenshot placeholder:** a failed pipeline run, with the failing stage, the job, and the log excerpt summarized in Claude Code.

## What it does

| Area | Read (runs directly) | Change (asks you first) |
| --- | --- | --- |
| **Pipelines** | Recent runs; one run's status, failed stages and jobs, and the failing log excerpt; pending approvals | Rerun a pipeline, retry failed stages, approve or reject an approval |
| **Pull requests** | PRs I created, PRs waiting for my review, PRs by repository; a PR's description, changed files, reviewers and votes, policies, and comment threads | Post a comment or reply, cast a vote |
| **Work items** | WIQL or simple-filter queries (mine, type, state, text); one work item with its links | Create, update fields or state, add a comment, link to a PR or another work item |
| **Azure** | Signed-in account and subscription, subscriptions, resource groups, resources, and recent activity-log entries for a resource or group | Nothing. This area is read-only |

> **Screenshot placeholder:** approving a pending pipeline approval, with the planned change shown and the confirmation prompt open.

## Install

In Claude Code:

```text
/plugin marketplace add falkoro/claude-code-azure
/plugin install azure@claude-code-azure
```

Or from your shell:

```bash
claude plugin marketplace add falkoro/claude-code-azure
claude plugin install azure@claude-code-azure
```

Then run `/reload-plugins` or start a new session.

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`)
- The Azure DevOps extension: `az extension add --name azure-devops`
- A sign-in: `az login`. Pipeline approvals, stage retries, and log downloads call the Azure DevOps REST API through `az rest` with this Microsoft Entra ID sign-in. Everything else in Azure DevOps also works with a PAT set up through `az devops login`.
- Default organization and project, so you don't have to name them every time:

  ```bash
  az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>
  ```

  Inside a clone of an Azure Repos repository, the CLI can also detect them from the git remote.

Run `/azure:setup` to check all of this. It tells you what's missing and how to fix it.

## Skills and commands

Each skill runs as a slash command, and Claude also picks it up on its own when your request matches. Arguments are optional, and plain language works too.

| Command | What it covers | Examples |
| --- | --- | --- |
| `/azure:setup` | Checks az, the extension, the sign-in, and the defaults | `/azure:setup` |
| `/azure:pipelines` | Runs, failures and logs, rerun and retry, approvals | `/azure:pipelines`, `/azure:pipelines 1234`, `/azure:pipelines approvals` |
| `/azure:pull-requests` | List, show, comment, vote | `/azure:pull-requests review`, `/azure:pull-requests 87` |
| `/azure:work-items` | Query, show, create, update, link | `/azure:work-items mine`, `/azure:work-items create Bug "Login fails on Safari"` |
| `/azure:resources` | Account, subscriptions, resource groups, resources, activity log | `/azure:resources groups`, `/azure:resources activity my-app-service` |

> **Screenshot placeholder:** `/azure:pull-requests review` listing PRs waiting for review, with one PR opened.

> **Screenshot placeholder:** `/azure:work-items mine`, then a state change confirmed and applied.

## Safety model: nothing changes without your yes

Read-only actions such as list, show, query, and GET requests run directly. Every state-changing action goes through two separate checks:

1. **Confirmation inside the session.** Approving, rejecting, rerunning, retrying, voting, commenting, creating or updating a work item, and linking are all state-changing actions. Before any of them runs, Claude resolves the IDs and names with read-only commands. It then shows a **Planned change** block with the action, the target by name and ID, old and new values, the full comment text, and the exact command. It asks you to confirm and runs only exactly what it showed, only after a clear yes. If the plan changes, it asks again.
2. **A permission prompt from Claude Code.** The plugin ships a `PreToolUse` hook (`plugins/azure/hooks/confirm-writes.sh`). It inspects every `az` command Claude is about to run and returns an `ask` decision when the command changes state: write verbs such as `create`, `update`, `delete`, `run`, `set-vote`, or `add`, `az rest` with a POST/PUT/PATCH/DELETE method, or `az devops invoke` with a write `--http-method`. Claude Code then shows its own permission prompt for that command, even when an allow rule for `Bash(az *)` exists. The check is deliberately broad, so an occasional read-only command (such as `--help` on a write command) also prompts.

Claude Code honors the hook's `ask` in auto mode too. In testing, it also prompted in `bypassPermissions` mode.

Credentials stay with the az CLI. The plugin never stores, prints, or asks for tokens or secrets. It doesn't call `az account get-access-token` or print keys or connection strings. If you need a PAT, `az devops login` reads it from a hidden prompt, not from the chat.

## Why the az CLI and not MCP

The existing Azure DevOps plugins for Claude Code cover only Azure DevOps and go through Microsoft's MCP servers. This plugin covers Azure and Azure DevOps together and uses the az CLI you already have installed and signed in. Nothing extra runs in the background, it works wherever `az` works, and every action is a plain command you can read in the transcript and run yourself.

## Repository layout

```text
.claude-plugin/marketplace.json     # this repo is its own marketplace
plugins/azure/
  .claude-plugin/plugin.json        # plugin manifest
  skills/<name>/SKILL.md            # setup, pipelines, pull-requests, work-items, resources
  hooks/hooks.json                  # PreToolUse hook registration
  hooks/confirm-writes.sh           # asks before state-changing az commands
scripts/validate.py                 # manifest, component, and hook checks
```

## Development

```bash
python3 scripts/validate.py                  # manifests parse, referenced files exist, hook flags the right commands
claude plugin validate --strict .            # official marketplace validation
claude plugin validate --strict ./plugins/azure
claude --plugin-dir ./plugins/azure          # try local changes without installing
```

CI runs all three validation commands on every push and pull request.

## License

[MIT](LICENSE)
