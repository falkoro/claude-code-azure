# claude-code-azure

Azure and Azure DevOps plugin for Claude Code: pipelines and approvals, pull requests, work items, and Azure resources through the az CLI.

Ask Claude things like "why did last night's build fail?", "approve the production deployment", "what PRs are waiting for my review?", or "move bug 1423 to Active and link it to PR 87". The plugin drives `az`, `az devops`, `az repos`, `az boards`, and `az pipelines` in your terminal, so it uses the sign-in you already have. There is no MCP server to run and no token to paste. It covers Azure and Azure DevOps in one plugin.

It also adds live panes beside the conversation: your pipeline runs and the approvals that wait for you, with a two-press Approve or Reject, and your pull requests with what blocks each one. See [Panes](#panes).

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

- Claude Code 2.1.211 or later for the skills and the confirm hook; 2.1.287 or later for the panes (the function-hook API they use is early access and can change between releases)
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

## Panes

The plugin ships a function-hook module (`plugins/azure/hooks/register.tsx`) that adds two tabs beside the conversation, two buttons above the prompt, and four read-only tools for Claude. It reads the Azure DevOps REST API directly, polling every 30 seconds by default.

> **Screenshot placeholder:** the Pipelines tab with one approval in its confirm row, and the runs below it with one mark per stage.

| Part | What you get |
| --- | --- |
| **Pipelines tab** | `/azure:runs` opens it. The approvals you can decide, and the runs it watches with one mark per stage. A summary line says what waits for you. |
| **Approvals** | Press **Approve** or **Reject**, then confirm the named stage. Only the second press sends the decision, as you, and the plugin checks Azure DevOps recorded it. An approval shows only when Azure DevOps gives you the `update` permission on it. |
| **Honest verdicts** | A green run with skipped stages shows in yellow and names those stages, so a run that skipped its deploy doesn't pass as a deploy. A failed run names the stage, the task, and the first error. |
| **Watched runs** | Each run Claude queues (`az pipelines run`, or a POST to the runs API), your own runs of the last 12 hours, and the run behind each approval. |
| **Pull requests tab** | `/azure:prs` opens it. Your active pull requests with one mark per blocking policy and what blocks each one (conflict, failed policy, reject vote, waiting reviewer, open comments, expired build), or "ready to complete". Below them, the pull requests that wait for your vote, directly or through a team you're in (nested teams included). A failed read says so and keeps the last lists. An empty list always means nothing waits. |
| **Buttons** | A Pipelines and a Pull requests button above the prompt, each with its count and the chord you bound to it. |
| **Signals** | Tab labels count what needs you. A new approval or review opens the pane. A toast tells you when a run finishes or waits, when one of your pull requests changes, and when a new one waits for your vote. |
| **Tools for Claude** | `pipeline_status` (one run stage by stage, the approval it waits on, the failed task's log tail), `pipeline_watch` (with `wake=true` the session gets a prompt when the run finishes or waits, so Claude doesn't poll), `pipeline_approvals`, and `pull_requests`. All read-only. |
| **Portal links** | Azure resource IDs in Bash and PowerShell output become Azure portal links, in the right tenant when `az account list` knows it. Claude gets the links, and the Pipelines tab lists them. |

> **Screenshot placeholder:** the Pull requests tab, opened from the button above the prompt.

`/azure:runs` also takes `watch <run>`, `check <run>` (writes the stage-by-stage verdict into the conversation), `clear` (drops finished runs), and `refresh` (reads the credential again). A run is its URL, or its build ID and project.

### Credential

The panes use `AZURE_DEVOPS_EXT_PAT` if it's set, the same variable the az devops extension reads. Otherwise they get an Azure DevOps token from your `az login` session (`az account get-access-token` for the Azure DevOps resource). If Azure DevOps refuses the PAT, they fall back to the az token once. The credential stays in the module's memory and is never written to state, storage, or a log. The tab header says which one was used.

To read runs and approvals, the PAT needs Build (read); to decide a gate, Build (read and execute) and Pipeline Resources (use). The Pull requests tab also needs Code (read) and Identity (read).

### Keys

Bind the commands to chords in `~/.claude/keybindings.json` (`/keybindings` opens it), and the buttons show them:

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+x p": "command:azure:runs", "ctrl+x r": "command:azure:prs" } }
  ]
}
```

### Settings

Change them in `/config`, or under `pluginConfigs.azure.options` in `~/.claude/settings.json`. [`plugin.json`](plugins/azure/.claude-plugin/plugin.json) holds each default.

| Setting | What it controls |
| --- | --- |
| `organization` | The Azure DevOps organization. Empty: your `az devops configure` default. |
| `projects` | Comma-separated projects polled for approvals and your recent runs. Empty: your `az devops configure` default project. A watched run adds its own project. |
| `adoTenant` | The Entra tenant the az token is requested in. Empty: the az CLI's current tenant. |
| `tenants` | `label=tenantId` pairs named in the system prompt, so portal links open in the right directory. |
| `pollSeconds` | The poll interval (default 30). Approvals refresh every second poll, your recent runs and pull requests every fourth. |
| `humanOnlyApprovals` | Off by default. When on, the plugin refuses any tool command that sends a PATCH to the approvals API, so only the pane decides a gate, and the `pipelines` skill can no longer approve. The check reads the command text, so a script that hides the call gets past it. The approval check in Azure DevOps stays the real gate. |
| `linkHints` | Give Claude ready portal links for resource IDs in tool output (default on). |
| `band` | Show the buttons above the prompt (default on). |

## Safety model: changes ask first

Read-only actions (list, show, query, GET requests) need no extra confirmation. State-changing actions are guarded:

1. **In the skill:** approving, rejecting, rerunning, retrying, voting, commenting, creating or updating a work item, and linking are all state-changing actions. Before any of them runs, Claude resolves the IDs and names with read-only commands. It then shows a **Planned change** block with the action, the target by name and ID, old and new values, the full comment text, and the exact command. It runs exactly what it showed, and only after you say yes. If the plan changes, it asks again.
2. **In Claude Code:** the plugin's `PreToolUse` hook (`plugins/azure/hooks/confirm-writes.sh`) asks you before any `az` command that isn't a known read. A known read is a command whose last subcommand is `list`, `show`, `query`, or `version`, or an `az rest` / `az devops invoke` call with a GET method. Everything else asks: writes, `az rest` or `az devops invoke` with any other method, `az devops configure` without `--list`, commands that print secrets such as access tokens or storage keys, and `az` calls the hook can't parse. The hook overrides an allow rule such as `Bash(az *)`. It also applies in auto mode on Claude Code 2.1.211 or later. It is deliberately broad, so an occasional harmless command (such as `--help` on a write command) also prompts.

3. **In the panes:** the Pipelines tab is the one place that changes state without the hook, because you press the buttons, not Claude. A decision takes two presses, Approve or Reject and then the confirm row that names the stage. The panes' tools for Claude are all read-only. Turn on `humanOnlyApprovals` to keep approvals out of Claude's hands entirely.

The hook is a best-effort guard against mistakes, not a security boundary. A command hidden in a script file, for example, isn't inspected. For a hard guarantee, add `ask` or `deny` permission rules or use Claude Code's sandbox. Don't rely on it in `bypassPermissions` mode.

Credentials stay with the az CLI. The skills never ask for, store, or print tokens or secrets, and the hook asks before commands that print them. If you need a PAT, `az devops login` reads it from a hidden prompt, not from the chat.

## Why the az CLI and not MCP

Most existing Azure DevOps plugins for Claude Code cover only Azure DevOps and go through Microsoft's MCP servers. This plugin covers Azure and Azure DevOps together and uses the az CLI you already have installed and signed in. Nothing extra runs in the background, it works wherever `az` works, and every action is a plain command you can read in the transcript and run yourself.

## Repository layout

```text
.claude-plugin/marketplace.json     # this repo is its own marketplace
plugins/azure/
  .claude-plugin/plugin.json        # plugin manifest
  skills/<name>/SKILL.md            # setup, pipelines, pull-requests, work-items, resources
  hooks/hooks.json                  # PreToolUse hook and the function-hook module
  hooks/confirm-writes.sh           # asks before az commands that aren't known reads
  hooks/register.tsx                # panes entry point: hooks, commands, tools, polling
  hooks/ado.ts                      # Azure DevOps REST client and credential
  hooks/verdict.ts                  # run and pull request verdicts
  hooks/links.ts                    # run, pull request, and portal links
  hooks/ui.tsx                      # the two tabs and the buttons above the prompt
  types/index.d.ts                  # the panes' state contract
  tests/                            # claude plugin test suites, against a fake Azure DevOps
scripts/validate.py                 # manifest, component, and hook checks
```

## Development

```bash
python3 scripts/validate.py                  # manifests parse, referenced files exist, hook flags the right commands
claude plugin validate --strict .            # official marketplace validation
claude plugin validate --strict ./plugins/azure
claude plugin test ./plugins/azure           # pane, verdict, and link tests
claude --plugin-dir ./plugins/azure          # try local changes without installing
```

CI runs all three validation commands and the plugin tests on pull requests and on pushes to `main`, and also runs `validate.py` on macOS.

## License

[MIT](LICENSE)
