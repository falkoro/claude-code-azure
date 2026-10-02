#!/usr/bin/env python3
"""Check that the marketplace and plugin manifests parse, that every component
they reference exists, and that the confirm-writes hook flags the right commands.

Run from anywhere: python3 scripts/validate.py
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors = []


def fail(msg):
    errors.append(msg)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail(f"{path.relative_to(ROOT)}: {exc}")
        return None


def check_path(plugin_dir, rel, what):
    if not isinstance(rel, str) or not rel.startswith("./"):
        fail(f"{what}: path {rel!r} must start with ./")
        return
    if not (plugin_dir / rel).exists():
        fail(f"{what}: {rel} does not exist")


def check_skill(skill_md):
    name = skill_md.relative_to(ROOT)
    text = skill_md.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        fail(f"{name}: missing YAML frontmatter")
    elif not re.search(r"^description:\s*\S", m.group(1), re.M):
        fail(f"{name}: frontmatter has no description")


def check_hooks(plugin_dir, hooks_file):
    data = load_json(hooks_file)
    if data is None:
        return
    for groups in data.get("hooks", {}).values():
        for group in groups:
            for hook in group.get("hooks", []):
                for ref in re.findall(r"\$\{CLAUDE_PLUGIN_ROOT\}/([^\"'\s]+)", hook.get("command", "")):
                    script = plugin_dir / ref
                    if not script.is_file():
                        fail(f"{hooks_file.relative_to(ROOT)}: {ref} does not exist")
                    elif not os.access(script, os.X_OK):
                        fail(f"{hooks_file.relative_to(ROOT)}: {ref} is not executable")


def check_plugin(entry):
    source = entry.get("source")
    if not isinstance(source, str):
        return  # remote source, nothing local to check
    plugin_dir = ROOT / source
    if not plugin_dir.is_dir():
        fail(f"marketplace plugin {entry.get('name')!r}: source {source} does not exist")
        return
    manifest = load_json(plugin_dir / ".claude-plugin" / "plugin.json")
    if manifest is None:
        return
    if manifest.get("name") != entry.get("name"):
        fail(f"plugin.json name {manifest.get('name')!r} differs from marketplace entry {entry.get('name')!r}")
    for key in ("skills", "commands", "agents", "outputStyles", "hooks", "mcpServers", "lspServers"):
        value = manifest.get(key)
        paths = value if isinstance(value, list) else [value] if isinstance(value, str) else []
        for rel in paths:
            if isinstance(rel, str):
                check_path(plugin_dir, rel, f"plugin.json {key}")
    skills = sorted((plugin_dir / "skills").glob("*/SKILL.md"))
    if not skills:
        fail(f"{source}: no skills found")
    for skill_md in skills:
        check_skill(skill_md)
    hooks_file = plugin_dir / "hooks" / "hooks.json"
    if hooks_file.exists():
        check_hooks(plugin_dir, hooks_file)


def check_confirm_hook():
    script = ROOT / "plugins/azure/hooks/confirm-writes.sh"
    cases = {
        "az pipelines runs list --top 10": False,
        "az pipelines run --id 3 --branch main": True,
        "az repos pr set-vote --id 5 --vote approve": True,
        "az repos pr list --status active --reviewer me@example.com": False,
        'az rest --resource x --url "https://dev.azure.com/o/p/_apis/pipelines/approvals?state=pending"': False,
        "az rest --method patch --url https://x --body '[{\"status\": \"approved\"}]'": True,
        "az rest -m POST --url https://x": True,
        "az devops invoke --area git --resource pullRequestThreads --http-method POST --in-file t.json": True,
        "az devops invoke --area build --resource timeline --route-parameters project=p buildId=1": False,
        "az boards query --wiql \"SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Removed'\"": False,
        "az boards work-item create --type Bug --title x": True,
        "cd /tmp && az boards work-item update --id 4 --state Active": True,
        "az repos pr work-item add --id 1 --work-items 2": True,
        "az monitor activity-log list --resource-id /x --offset 7d": False,
        "az storage blob upload --account-name a -f x -c c -n n": True,
        "az aks scale --name k --resource-group g --node-count 3": True,
        "az webapp deployment slot swap --name w --resource-group g --slot s": True,
        "az role assignment list --assignee me": False,
        "az storage account keys renew --account-name a --key primary": True,
        "az vm resize --name v --resource-group g --size Standard_D2s_v3": True,
        "az pipelines runs cancel --id 4": True,
        "az vm run-command invoke-action --name v": True,
        "az account show": False,
        "ls -la": False,
    }
    for command, should_ask in cases.items():
        payload = json.dumps({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": command, "description": "create and update things"},
        })
        out = subprocess.run(["bash", str(script)], input=payload, capture_output=True, text=True).stdout
        asked = bool(out.strip()) and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "ask"
        if asked != should_ask:
            fail(f"confirm-writes.sh: expected {'ask' if should_ask else 'no decision'} for: {command}")


def main():
    marketplace = load_json(ROOT / ".claude-plugin" / "marketplace.json")
    if marketplace is not None:
        for key in ("name", "owner", "plugins"):
            if key not in marketplace:
                fail(f"marketplace.json: missing {key}")
        for entry in marketplace.get("plugins", []):
            check_plugin(entry)
    check_confirm_hook()
    for msg in errors:
        print(f"FAIL {msg}")
    print("OK" if not errors else f"{len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
