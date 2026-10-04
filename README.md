# claude-code-azure

Azure and Azure DevOps plugin for Claude Code: pipelines and approvals, pull requests, work items, and Azure resources through the az CLI.

Ask Claude things like "why did last night's build fail?", "approve the production deployment", "what PRs are waiting for my review?", or "move bug 1423 to Active and link it to PR 87". The plugin drives `az`, `az devops`, `az repos`, `az boards`, and `az pipelines` in your terminal, so it uses the sign-in you already have. There is no MCP server to run and no token to paste. It covers Azure and Azure DevOps in one plugin.

> **Screenshot placeholder:** a failed pipeline run, with the failing stage, the job, and the log excerpt summarized in Claude Code.

## What it does

| Area | Read (no extra confirmation) | Change (asks you first) |
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

- Claude Code 2.1.211 or later
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

## Safety model: changes ask first

Read-only actions (list, show, query, GET requests) need no extra confirmation. State-changing actions are guarded twice:

1. **In the skill:** approving, rejecting, rerunning, retrying, voting, commenting, creating or updating a work item, and linking are all state-changing actions. Before any of them runs, Claude resolves the IDs and names with read-only commands. It then shows a **Planned change** block with the action, the target by name and ID, old and new values, the full comment text, and the exact command. It runs exactly what it showed, and only after you say yes. If the plan changes, it asks again.
2. **In Claude Code:** the plugin's guard asks you before any `az` command that isn't a known read. A known read is a command whose last subcommand is `list`, `show`, `query`, or `version`, or an `az rest` / `az devops invoke` call with a GET method. Everything else asks: writes, `az rest` or `az devops invoke` with any other method, `az devops configure` without `--list`, commands that print secrets such as access tokens or storage keys, and `az` calls the hook can't parse. The guard overrides an allow rule such as `Bash(az *)`. It also applies in auto mode on Claude Code 2.1.211 or later. It is deliberately broad, so an occasional harmless command (such as `--help` on a write command) also prompts.

   The guard is two hooks with the same rules:
   - **A function hook** (`hooks/register.ts`, rules in `hooks/guard.ts`) answers Claude Code's permission check (`tool.check`) with "ask". This makes the plugin a [Claude Mod](https://claudemods.ai).
   - **A shell `PreToolUse` hook** (`hooks/confirm-writes.sh`) asks too. In auto mode, an "ask" from the permission check goes to the auto-mode classifier rather than to you, while a `PreToolUse` "ask" still reaches you.

It is a best-effort guard against mistakes, not a security boundary. A command hidden in a script file, for example, isn't inspected. For a hard guarantee, add `ask` or `deny` permission rules or use Claude Code's sandbox. Don't rely on it in `bypassPermissions` mode.

Credentials stay with the az CLI. The skills never ask for, store, or print tokens or secrets, and the guard asks before commands that print them. If you need a PAT, `az devops login` reads it from a hidden prompt, not from the chat.

## Why the az CLI and not MCP

Most existing Azure DevOps plugins for Claude Code cover only Azure DevOps and go through Microsoft's MCP servers. This plugin covers Azure and Azure DevOps together and uses the az CLI you already have installed and signed in. Nothing extra runs in the background, it works wherever `az` works, and every action is a plain command you can read in the transcript and run yourself.

## Repository layout

```text
.claude-plugin/marketplace.json     # this repo is its own marketplace
plugins/azure/
  .claude-plugin/plugin.json        # plugin manifest
  skills/<name>/SKILL.md            # setup, pipelines, pull-requests, work-items, resources
  hooks/hooks.json                  # registers the function hook module and the PreToolUse hook
  hooks/register.ts                 # function hook: asks at the permission check before az commands that aren't known reads
  hooks/guard.ts                    # the rules: which az commands are known reads
  hooks/confirm-writes.sh           # the same rules as a PreToolUse hook, which also asks in auto mode
  tests/                            # function hook tests, run by claude plugin test
scripts/validate.py                 # manifest, component, and shell hook checks
```

## Development

```bash
python3 scripts/validate.py                  # manifests parse, referenced files exist, shell hook flags the right commands
claude plugin validate --strict .            # official marketplace validation
claude plugin validate --strict ./plugins/azure
claude plugin test ./plugins/azure           # function hook flags the same commands
claude --plugin-dir ./plugins/azure          # try local changes without installing
```

CI runs all four commands on pull requests and on pushes to `main`, and also runs `validate.py` on macOS.

## License

[MIT](LICENSE)
