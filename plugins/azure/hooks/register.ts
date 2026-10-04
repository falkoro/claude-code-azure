import type { Register } from 'claude-code'

import { needsConfirm } from './guard'

const REASON = 'Azure plugin: this az command may change state or reveal a secret. Check it before you allow it.'
const SHELLS = new Set(['Bash', 'Monitor', 'PowerShell'])

// Asks before any az command that isn't a known read, over an allow rule such
// as Bash(az *); a deny from beneath still stands. In auto mode an ask goes
// to the classifier, so confirm-writes.sh asks there too.
export const register: Register = (on) => {
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    const command = (e.input as { command?: unknown } | undefined)?.command
    if (r.decision === 'deny' || !SHELLS.has(e.tool) || typeof command !== 'string' || !needsConfirm(command)) return r
    return { decision: 'ask', reason: REASON }
  })
}
