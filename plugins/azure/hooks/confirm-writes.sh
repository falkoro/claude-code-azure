#!/usr/bin/env bash
# PreToolUse hook: make Claude Code ask before any az command that changes state.
# Reads the hook JSON on stdin and prints an "ask" decision for state-changing
# az commands; read-only commands get no output and follow the normal flow.
# Plain bash + sed + grep so it needs no jq or python.

input=$(tr -d '\n')
# tool_input.command, still JSON-escaped; good enough for pattern matching.
cmd=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(\([^"\\]\|\\.\)*\)".*/\1/p')
[ -n "$cmd" ] || exit 0
printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])az[[:space:]]' || exit 0

b='(^|[^[:alnum:]_-])'
e='([^[:alnum:]_-]|$)'
verbs='create|update|delete|remove|add|set|set-vote|run|queue|approve|reject|abandon|complete|reactivate|start|stop|restart|deallocate|purge|import|deploy'

if printf '%s' "$cmd" | grep -Eq "${b}(${verbs})${e}" ||
  printf '%s' "$cmd" | grep -Eiq -- '(--method|-m)[[:space:]=]+[\\"'"'"']*(post|put|patch|delete)' ||
  printf '%s' "$cmd" | grep -Eiq -- '--http-method[[:space:]=]+[\\"'"'"']*(post|put|patch|delete)'; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Azure plugin: this az command changes state in Azure or Azure DevOps. Check it before you allow it."}}'
fi
exit 0
