// Whether an az command needs the user's confirmation. Allowlist, not
// denylist: an az call passes only when its last subcommand word is a read
// verb (list, show, query, version), it touches no secret, and any az rest /
// az devops invoke method is GET. Everything else, including az calls this
// can't read, asks.

// "az" as a word of its own, or Python's azure.cli
const AZ = /(^|[^\w.-])az([^\w-]|$)|azure\.cli/
// python -m azure.cli and az @argsfile: arguments this can't see
const UNREADABLE = /azure\.cli|(^|[^\w.-])az\s+@/
// Each az call: "az" and its subcommand words, up to the first flag or separator
const CALL = /(^|[^\w.-])az(\s+[A-Za-z0-9][\w-]*)*([^\w-]|$)/g
const SECRET = /(^| )(keys?|secret|credentials?|get-access-token|get-credentials|list-keys|show-connection-string|generate-sas|connection-string)( |$)/
const READ = new Set(['list', 'show', 'query', 'version'])
const LIST_FLAG = /(^|\s)(--list|-l)(\s|$)/
// az rest and az devops invoke: a method or header flag, however shortened
const METHOD_FLAG = /(^|\s)(-m|--m[a-z]*|--h[a-z-]*)/i
const GET = /(^|\s)(-m|--m[a-z]*|--h[a-z-]*)[\s=]*get(\s|$)/i

// Undoes the shell's ways of hiding a word: drops every quote and backslash,
// so "az", 'az', \az, d''elete and de\lete read plainly, and splits at every
// separator, so az list;az delete is two calls
const normalize = (command: string) => command.replace(/[\t\n\r]/g, ' ').replace(/["'\\]/g, '').replace(/[;&|()`]/g, ' ; ')

export function needsConfirm(command: string): boolean {
  const norm = normalize(command)
  if (!AZ.test(norm)) return false
  if (UNREADABLE.test(norm)) return true
  for (const [call] of norm.matchAll(CALL)) {
    const words = call.replace(/^[^a]*az/, '').replace(/[^\w-]$/, '')
    if (!words.trim()) return true // bare az, $a, az $(...)
    if (SECRET.test(words)) return true
    const verb = words === ' rest' || words === ' devops invoke' ? 'rest' : words.slice(words.lastIndexOf(' ') + 1)
    if (READ.has(verb)) continue
    if (verb === 'configure' && LIST_FLAG.test(norm)) continue
    if (verb === 'rest' && (!METHOD_FLAG.test(norm) || GET.test(norm))) continue
    return true
  }
  return false
}
