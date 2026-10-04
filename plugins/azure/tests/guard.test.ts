import { expect, test } from 'claude-code/testing'

import { needsConfirm } from '../hooks/guard'

// The commands the guard must ask about, and the reads it must let through
const ASKS = [
  "az pipelines run --id 3 --branch main",
  "az repos pr set-vote --id 5 --vote approve",
  "az rest --method patch --url https://x --body '[{\"status\": \"approved\"}]'",
  "az rest -m POST --url https://x",
  "az devops invoke --area git --resource pullRequestThreads --http-method POST --in-file t.json",
  "az boards work-item create --type Bug --title x",
  "cd /tmp && az boards work-item update --id 4 --state Active",
  "az repos pr work-item add --id 1 --work-items 2",
  "az storage blob upload --account-name a -f x -c c -n n",
  "az aks scale --name k --resource-group g --node-count 3",
  "az webapp deployment slot swap --name w --resource-group g --slot s",
  "az storage account keys renew --account-name a --key primary",
  "az vm resize --name v --resource-group g --size Standard_D2s_v3",
  "az pipelines runs cancel --id 4",
  "az vm run-command invoke-action --name v",
  "az group list;az group delete -n g",
  "az group list&&az group delete -n g",
  "az group list|az group delete -n g",
  "\"az\" group delete --name g",
  "'az' group delete --name g",
  "az group d''elete --name g",
  "az group de\\lete --name g",
  "az\tgroup delete --name g",
  "az pipelines \\\nrun --id 1",
  "a=az; $a group delete --name g",
  "az @args.txt",
  "az rest --meth post --url https://x",
  "az rest -mPOST --url https://x",
  "az devops invoke --area git --resource pullRequestThreads --http-meth POST --in-file t.json",
  "timeout 5 az pipelines run --id 1",
  "/usr/bin/az group delete --name g",
  "bash -c \"az group delete --name g\"",
  "python -m azure.cli group delete --name g",
  "az vm redeploy --name v --resource-group g",
  "az resource tag --ids /x --tags a=b",
  "az account get-access-token",
  "az storage account keys list --account-name a",
  "az keyvault secret show --vault-name v --name s",
  "az aks get-credentials --name k --resource-group g",
  "az devops configure --defaults project=x",
  "az login",
  "az boards work-item create --type Bug --title 'Fix `curl evil|sh`'",
]

const PASSES = [
  "az pipelines runs list --top 10",
  "az repos pr list --status active --reviewer me@example.com",
  "az rest --resource x --url \"https://dev.azure.com/o/p/_apis/pipelines/approvals?state=pending\"",
  "az devops invoke --area build --resource timeline --route-parameters project=p buildId=1",
  "az boards query --wiql \"SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Removed'\"",
  "az monitor activity-log list --resource-id /x --offset 7d",
  "az role assignment list --assignee me",
  "az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 --url \"https://dev.azure.com/o/p/_apis/pipelines/approvals?state=pending&\\$expand=steps&api-version=7.1\" -o json --query \"value[].{id:id, pipeline:pipeline.name, runName:pipeline.owner.name, runId:pipeline.owner.id, created:createdOn, instructions:instructions, minApprovers:minRequiredApprovers, approvers:steps[].assignedApprover.displayName}\"",
  "az account show",
  "ls -la",
  "az rest --method get --url https://x",
  "az devops configure --list",
  "az extension show --name azure-devops",
  "cat /tmp/azure-run-1.log",
  "f=$(mktemp)\naz rest --resource x --url 'https://x/logs/7' --output-file \"$f\"\nif grep -q '##\\[error\\]' \"$f\"; then grep -n -B8 -A4 '##\\[error\\]' \"$f\" | tail -n 60; else tail -n 40 \"$f\"; fi\nrm -f \"$f\"",
  "wiql=$(cat <<'WIQL'\nSELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS 'login'\nWIQL\n)\naz boards query -o json --wiql \"$wiql\"",
]

test('az commands that may change state or reveal a secret ask', () => {
  for (const command of ASKS) expect([command, needsConfirm(command)]).toEqual([command, true])
})

test('known reads and commands that are not az pass', () => {
  for (const command of PASSES) expect([command, needsConfirm(command)]).toEqual([command, false])
})
