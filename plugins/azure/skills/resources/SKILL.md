---
name: resources
description: Azure resources through the az CLI (read-only) — show the signed-in account and subscription, list subscriptions, list and inspect resource groups and resources, and fetch recent activity-log entries for a resource or resource group. Use when the user asks which Azure account or subscription is active, what's in a subscription or resource group, details of an Azure resource, or who changed something recently.
argument-hint: "[account | groups | group <name> | resource <name or id> | activity <name or id>]"
---

# Azure resources

Request: $ARGUMENTS

With no request, show the signed-in account and subscription, then the resource groups.

Everything here is read-only and runs directly. This skill doesn't change Azure resources. If the user asks for a change, show the az command that would do it and use the confirmation sequence in "Confirm before changing anything" below before running anything.

## Before you start

- If `az account show` says to run `az login`, follow the azure plugin's `setup` skill: the user signs in themselves with `! az login`.
- Never print or request tokens or secrets. Don't run `az account get-access-token`, and don't run commands that print keys or connection strings, such as `list-keys`, `keys list`, `show-connection-string`, or `credential list`.
- Use `-o json` with a `--query` projection and summarize the result.
- To look at another subscription, add `--subscription <name or id>` to the commands rather than switching the default with `az account set`. Switching changes the user's az configuration, so it needs confirmation.

## Account and subscription

```bash
az account show -o json --query "{user:user.name, userType:user.type, subscription:name, subscriptionId:id, tenant:tenantId, state:state}"
az account list -o json --query "[].{name:name, id:id, default:isDefault, state:state}"
```

## Resource groups

```bash
az group list -o json --query "[].{name:name, location:location, state:properties.provisioningState}"
az group show --name <group> -o json
```

## Resources

```bash
az resource list --resource-group <group> -o json --query "[].{name:name, type:type, location:location, id:id}"
az resource show --ids <resource-id> -o json
```

Without `--resource-group`, `az resource list` covers the whole subscription. Add `--resource-type <type>` or `--name <name>` to narrow it. To find a resource by name, list with `--name <name>` and use the `id` it returns. Summarize `az resource show` output: type, location, SKU, provisioning state, tags, and the key properties for that resource type.

## Activity log

```bash
az monitor activity-log list --resource-id <resource-id> --offset 7d --max-events 25 -o json \
  --query "[].{time:eventTimestamp, operation:operationName.localizedValue, status:status.localizedValue, caller:caller, level:level}"
```

Use `--resource-group <group>` instead of `--resource-id` for a whole group. `--offset` takes a `##d##h` window, up to 90 days. Show the entries newest first, and group the start and success events of the same operation together.

## Confirm before changing anything

This skill only reads. If the user asks for a change anyway:

1. Show a **Planned change** block: the action, the target by name and resource ID, and the exact command.
2. Ask with AskUserQuestion (options: "Run it" and "Cancel"). Without that tool, ask in plain text and wait for an explicit yes. Anything other than a clear yes means don't run it.
3. Run exactly what you showed, then report the outcome.

Claude Code may also show its own permission prompt for these commands, because the plugin's hook asks for one. That prompt is a second check and does not replace this one.
