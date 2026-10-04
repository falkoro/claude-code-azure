import { expect, test } from 'claude-code/testing'

const check = ($: any, tool: string, input: Record<string, unknown>) => $.tool.check({ tool, input })

test('an az write asks, even over an allow rule', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow', rule: 'Bash(az *)' }) as any)
  expect(await check($, 'Bash', { command: 'az group delete -n g' })).toMatchObject({ decision: 'ask', reason: expect.stringMatching(/Azure plugin/) })
  for (const tool of ['Monitor', 'PowerShell']) expect((await check($, tool, { command: 'az pipelines run --id 1' })).decision).toBe('ask')
})

test('a read, another tool, or a deny passes unchanged', async ($, on) => {
  on('tool.check', (_$, e) => ((e.input as any)?.command === 'az group delete -n g' ? { decision: 'deny', reason: 'no' } : { decision: 'allow' }) as any)
  expect(await check($, 'Bash', { command: 'az group list' })).toEqual({ decision: 'allow' })
  expect(await check($, 'Read', { file_path: 'az group delete' })).toEqual({ decision: 'allow' })
  expect(await check($, 'Bash', { command: 'az group delete -n g' })).toEqual({ decision: 'deny', reason: 'no' })
})
