import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const APPROVAL = '11111111-2222-3333-4444-555555555555'
const BUILD = 42
const OPTIONS = { options: { organization: 'contoso', projects: 'proj', humanOnlyApprovals: true } }
const paneProps = (title: string) => ({
  title,
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})
const RUNS_PANE = { plugin: 'azure', component: 'Pane', requestId: 'azure-pipelines', props: paneProps('Pipelines') } as const
const PRS_PANE = { plugin: 'azure', component: 'Pane', requestId: 'azure-prs', surface: 'terminal', props: paneProps('Pull requests') } as const
const BAND = {
  plugin: 'azure',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const KEYBINDINGS = JSON.stringify({
  bindings: [{ context: 'Chat', bindings: { 'ctrl+x p': 'command:azure:runs', 'ctrl+x r': 'command:prs' } }],
})

const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
const failed = { exitCode: 1, stdout: '', stderr: 'no az', isStdoutTruncated: false, isStderrTruncated: false }

const repo = { id: 'r1', name: 'repo', project: { id: 'p1', name: 'proj' } }
const pr = (id: number, author: string, reviewers: unknown[]) => ({
  pullRequestId: id,
  title: `Change ${id}`,
  isDraft: false,
  mergeStatus: 'succeeded',
  creationDate: '2026-01-01T06:00:00Z',
  createdBy: { id: author, displayName: author },
  reviewers,
  repository: repo,
})
const team = (id: string, vote = 0) => ({ id, displayName: `[proj]\\${id}`, vote, isContainer: true })
// 1: mine, ready. 2: mine, failed build and one open comment. 3: my team reviews. 4: another team reviews.
const MINE = [pr(1, 'me', [team('my-team', 10)]), pr(2, 'me', [])]
const OTHERS = [pr(3, 'sam', [team('my-team')]), pr(4, 'sam', [team('their-team')])]
const policy = (type: string, status: string) => ({ status, configuration: { isBlocking: true, isEnabled: true, type: { displayName: type } } })

type Call = { url: string; method: string; body?: string }

/** A fake Azure DevOps beneath the plugin: one gated run, and four pull requests. */
function world(on: On, o: { accounts?: { id: string; tenantId: string }[]; isPullsDown?: boolean; opened?: string[] } = {}): Call[] {
  const calls: Call[] = []
  mock.clock(on, { now: Date.parse('2026-01-01T08:00:00Z') })
  mock.store(on)
  mock.env(on, { AZURE_DEVOPS_EXT_PAT: 'test-pat', HOME: '/home/test' })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    o.opened?.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', ($, e) => (e.path === '/home/test/.claude/keybindings.json' ? { value: KEYBINDINGS } : { deny: 'no such file' }))
  on('process.run', ($, e) => ({
    value:
      e.argv[1] === 'account' && e.argv[2] === 'list' && o.accounts
        ? { ...failed, exitCode: 0, stdout: JSON.stringify(o.accounts), stderr: '' }
        : failed,
  }))
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    const url = new URL(e.url)
    const path = url.pathname
    calls.push({ url: e.url, method, body: e.init?.body })

    if (path.endsWith('/_apis/connectionData')) return json({ authenticatedUser: { id: 'me' } })
    if (path.endsWith('/_apis/pipelines/approvals')) {
      if (method === 'PATCH') {
        const [d] = JSON.parse(e.init?.body ?? '[]') as { status: string }[]
        return json({ value: [{ id: APPROVAL, status: d?.status }] })
      }
      return json({
        value: [
          {
            id: APPROVAL,
            status: 'pending',
            permissions: 'update',
            createdOn: '2026-01-01T06:00:00Z',
            instructions: 'Check the plan output first.',
            pipeline: { id: '7', name: 'Deploy web app', owner: { id: BUILD, name: '20260101.3' } },
          },
        ],
      })
    }
    if (path.endsWith(`/_apis/build/builds/${BUILD}/timeline`)) {
      return json({
        records: [
          { id: 's1', type: 'Stage', name: 'Build', order: 1, state: 'completed', result: 'succeeded' },
          { id: 's2', type: 'Stage', name: 'Production', order: 2, state: 'pending', result: null },
          { id: 'c2', parentId: 's2', type: 'Checkpoint', name: 'Checkpoint', state: 'inProgress' },
          { id: APPROVAL, parentId: 'c2', type: 'Checkpoint.Approval', name: 'Checkpoint.Approval', state: 'inProgress' },
        ],
      })
    }
    if (path.endsWith(`/_apis/build/builds/${BUILD}`)) {
      return json({
        id: BUILD,
        buildNumber: '20260101.3',
        status: 'inProgress',
        queueTime: '2026-01-01T05:50:00Z',
        sourceBranch: 'refs/heads/main',
        definition: { id: 7, name: 'Deploy web app' },
        project: { id: 'p-id', name: 'proj' },
      })
    }
    if (path.endsWith('/_apis/identities')) {
      return url.searchParams.get('queryMembership') === 'Expanded'
        ? json({ value: [{ id: 'me', memberOf: ['VSSGP.My-Team'] }] })
        : json({ value: [{ id: 'my-team', descriptor: 'vssgp.my-team' }, { id: 'their-team', descriptor: 'vssgp.their-team' }] })
    }
    if (path.endsWith('/_apis/git/pullrequests')) {
      if (o.isPullsDown) return { value: { status: 503, ok: false, headers: {}, text: 'Service Unavailable' } }
      return json({ value: url.searchParams.get('searchCriteria.creatorId') === 'me' ? MINE : [...MINE, ...OTHERS] })
    }
    if (path.endsWith('/_apis/policy/evaluations')) {
      const id = Number(url.searchParams.get('artifactId')?.split('/').pop())
      return json({ value: [policy('Minimum number of reviewers', 'approved'), policy('Build', id === 2 ? 'rejected' : 'approved')] })
    }
    if (path.endsWith('/pullRequests/2/threads')) {
      return json({
        value: [
          { status: 'active', comments: [{ commentType: 'text' }] },
          { status: 'active', comments: [{ commentType: 'system' }] },
          { status: 'fixed', comments: [{ commentType: 'text' }] },
        ],
      })
    }
    return json({ value: [] })
  })
  return calls
}

test('an approval goes out only after Approve and then Yes, approve, as one PATCH', OPTIONS, async ($, on) => {
  const calls = world(on)
  const listed = String((await $.tool.call({ tool: 'mcp__azure__pipeline_approvals' })).result)
  expect(listed).toContain('stage "Production"')
  expect(listed).toContain('Instructions: Check the plan output first.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...RUNS_PANE, surface })
    expect(await ui.find({ key: `run:contoso/${BUILD}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 approval waits for you/ })).toBeDefined()
    await ui.press({ key: `approve:${APPROVAL}` })
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(0)
    await ui.press({ key: `cancel:${APPROVAL}` })
    expect(await ui.find({ key: `approve:${APPROVAL}` })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...RUNS_PANE, surface: 'terminal' })
  await ui.press({ key: `approve:${APPROVAL}` })
  await ui.press({ key: `confirm:${APPROVAL}` })
  const patches = calls.filter(c => c.method === 'PATCH')
  expect(patches).toHaveLength(1)
  expect(JSON.parse(patches[0]?.body ?? '')).toEqual([{ approvalId: APPROVAL, status: 'approved' }])
})

test('with humanOnlyApprovals the model cannot approve through Bash', OPTIONS, async ($, on) => {
  world(on)
  let hasRun = false
  on('tool.call', { tool: 'Bash' }, () => {
    hasRun = true
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
  const answer = await $.tool.call({
    tool: 'Bash',
    command: `az rest --method patch --url "https://dev.azure.com/contoso/proj/_apis/pipelines/approvals?api-version=7.1" --body '[{"approvalId":"${APPROVAL}","status":"approved"}]'`,
    description: 'Approve the gate',
  })
  expect(hasRun).toBe(false)
  expect(JSON.stringify(answer)).toContain('decided by the person')
})

test('a run queued through az is watched and drawn in the pane', OPTIONS, async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false },
    text: `{"id": ${BUILD}, "url": "https://dev.azure.com/contoso/p-id/_apis/build/Builds/${BUILD}"}`,
  }))
  await $.tool.call({ tool: 'Bash', command: 'az pipelines run --id 7 --branch main', description: 'Queue' })
  const ui = await $.ui.mount({ ...RUNS_PANE, surface: 'terminal' })
  expect(await ui.find({ key: `run:contoso/${BUILD}` })).toBeDefined()
})

test('session start registers commands and tools; resource IDs get tenant portal links', OPTIONS, async ($, on) => {
  const sub = '22222222-3333-4444-5555-666666666666'
  const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  world(on, { accounts: [{ id: sub, tenantId: tenant }] })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(`/${e.name}`)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__azure__${e.name}` } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const id = `/subscriptions/${sub}/resourceGroups/rg-app/providers/Microsoft.KeyVault/vaults/kv-app`
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: `{"id": "${id}"}` }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['/runs', '/prs', 'pipeline_status', 'pipeline_watch', 'pipeline_approvals', 'pull_requests'])

  const answer = await $.tool.call({ tool: 'Bash', command: 'az keyvault show -n kv-app', description: 'Read' })
  expect(answer.context?.join('\n')).toContain(`[kv-app](https://portal.azure.com/#@${tenant}/resource${id})`)
  const ui = await $.ui.mount({ ...RUNS_PANE, surface: 'terminal' })
  expect(await ui.find({ key: `resource:${id}` })).toBeDefined()
})

test('the pull requests tab lists yours with their blockers, and the ones your team must review', OPTIONS, async ($, on) => {
  world(on)
  const answer = String((await $.tool.call({ tool: 'mcp__azure__pull_requests' })).result)
  expect(answer).toContain('!1 repo "Change 1": ready to complete')
  expect(answer).toContain('!2 repo "Change 2": build failed · 1 open comment')
  expect(answer).toContain('!3 repo "Change 3" by sam: your vote, via my-team')
  expect(answer).not.toContain('!4 ')

  const ui = await $.ui.mount(PRS_PANE)
  expect(await ui.find({ key: 'pull:r1/1' })).toBeDefined()
  expect(await ui.find({ key: 'pull:r1/3' })).toBeDefined()
  expect(await ui.find({ key: 'pull:r1/4' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1 blocked · 1 ready to complete · 1 waits for your vote/ })).toBeDefined()
})

test('a failed pull request read says so, and never claims that nothing waits', OPTIONS, async ($, on) => {
  world(on, { isPullsDown: true })
  const answer = String((await $.tool.call({ tool: 'mcp__azure__pull_requests' })).result)
  expect(answer).toContain('Could not read the pull requests, so this is no answer about them: HTTP 503')
  const ui = await $.ui.mount(PRS_PANE)
  expect(await ui.find({ type: 'Text', text: /Could not read the pull requests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No pull request waits for your vote/ })).toBeUndefined()
})

test('the buttons above the prompt open a tab and show the bound chords', OPTIONS, async ($, on) => {
  const opened: string[] = []
  world(on, { opened })
  await $.tool.call({ tool: 'mcp__azure__pull_requests' })
  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'band:pipelines' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'ctrl+x p' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'ctrl+x r' })).toBeDefined()
  expect((await band.find({ key: 'band:prs' }))?.props).toMatchObject({ label: 'Pull requests · 3', variant: 'primary' })
  await band.press({ key: 'band:prs' })
  // Both tabs open, the pull requests tab last so it is the one shown.
  expect(opened.slice(0, 2)).toEqual(['azure-pipelines', 'azure-prs'])
})

test('by default the guard stays out of the way, so the pipelines skill can approve after you confirm', { options: { organization: 'contoso', projects: 'proj' } }, async ($, on) => {
  world(on)
  let hasRun = false
  on('tool.call', { tool: 'Bash' }, () => {
    hasRun = true
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
  await $.tool.call({ tool: 'Bash', command: 'az rest --method patch --url "https://dev.azure.com/contoso/proj/_apis/pipelines/approvals"', description: 'Approve' })
  expect(hasRun).toBe(true)
})
