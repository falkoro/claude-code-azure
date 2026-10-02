#!/usr/bin/env bash
# PreToolUse hook: make Claude Code ask before any az command that is not a known read.
# Allowlist, not denylist: an az call passes silently only when its last subcommand
# word is a read verb (list, show, query, version), it touches no secret, and any
# az rest / az devops invoke method is GET. Everything else, including az calls we
# cannot parse, gets an "ask". Plain bash + sed + grep, no jq or python.

input=$(tr -d '\n')
# ERE, not GNU-only BRE \|, so BSD sed on macOS extracts the command too.
cmd=$(printf '%s' "$input" | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p')
[ -n "$cmd" ] || exit 0
# Undo the shell's ways of hiding a word: JSON \t \n \r become spaces, then drop
# every quote and backslash so "az", 'az', \az, d''elete and de\lete read plainly.
norm=$(printf '%s' "$cmd" | sed 's/\\[tnr]/ /g' | tr -d '"'"'"'\\' | tr '\t' ' ')
printf '%s' "$norm" | grep -Eq '(^|[^[:alnum:]_.-])az([^[:alnum:]_-]|$)|azure\.cli' || exit 0

ask() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Azure plugin: this az command may change state or reveal a secret. Check it before you allow it."}}'
  exit 0
}

# python -m azure.cli, az @argsfile, and anything else we cannot read: ask.
printf '%s' "$norm" | grep -Eq 'azure\.cli|(^|[^[:alnum:]_.-])az[[:space:]]+@' && ask

# Each az call: "az" plus its subcommand words (stop at the first flag or separator).
while IFS= read -r seg; do
  words=${seg#*az}
  verb=${words##* }
  [ -n "${words// /}" ] || ask                       # bare az, $a, az $(...)
  printf '%s' "$words" | grep -Eq '(^| )(keys?|secret|credentials?|get-access-token|get-credentials|list-keys|show-connection-string|generate-sas|connection-string)( |$)' && ask
  case "$words" in
    " rest"|" devops invoke") verb=rest ;;
  esac
  case "$verb" in
    list|show|query|version) ;;
    configure) printf '%s' "$norm" | grep -Eq -- '(^|[[:space:]])(--list|-l)([[:space:]]|$)' || ask ;;
    rest)
      if printf '%s' "$norm" | grep -Eiq -- '(^|[[:space:]])(-m|--m[a-z]*|--h[a-z-]*)'; then
        printf '%s' "$norm" | grep -Eiq -- '(^|[[:space:]])(-m|--m[a-z]*|--h[a-z-]*)([[:space:]=]+|)get([[:space:]]|$)' || ask
      fi ;;
    *) ask ;;
  esac
done < <(printf '%s' "$norm" | grep -oE '(^|[^[:alnum:]_.-])az([[:space:]]+[[:alnum:]][[:alnum:]_-]*)*([^[:alnum:]_-]|$)' |
  sed -e 's/^[^a]*az/az/' -e 's/[^[:alnum:]_-]$//')
exit 0
