import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AzureApproval, AzureConfirm, AzureHealth, AzurePull, AzureResource, AzureRun } from '../types'
import {
  AdoError,
  authSource,
  countOpenThreads,
  decideApproval,
  getBuild,
  getLogTail,
  getPolicyEvaluations,
  getTimeline,
  groupDescriptors,
  listActivePulls,
  listApprovals,
  myGroupDescriptors,
  myIdentity,
  myRecentBuilds,
  resetAuth,
} from './ado'
import type { AdoConfig, Build, Transport } from './ado'
import { findResources, findRuns, parseRunArg, parseTenants, pullUrl, runKey, runUrl } from './links'
import type { RunRef } from './links'
import { chordsOf, drawBand, drawPipelines, drawPulls, needsYou } from './ui'
import { judgeMine, judgeReview, judgeRun, oneLine, stageOf, waitsForMe } from './verdict'
import type { PullRequest, PullVerdict } from './verdict'

// The engine follows `$` only in this file: every function that takes `$` and every atom lives here.
type Engine = EngineInterface

const PLUGIN = 'azure'
const runsAtom = atom({ plugin: 'azure', key: 'runs' } as const, [] as AzureRun[])
const approvalsAtom = atom({ plugin: 'azure', key: 'approvals' } as const, [] as AzureApproval[])
const resourcesAtom = atom({ plugin: 'azure', key: 'resources' } as const, [] as AzureResource[])
const confirmAtom = atom({ plugin: 'azure', key: 'confirm' } as const, null as AzureConfirm)
const sendingAtom = atom({ plugin: 'azure', key: 'sending' } as const, null as string | null)
const healthAtom = atom({ plugin: 'azure', key: 'health' } as const, null as AzureHealth | null)
const pullsAtom = atom({ plugin: 'azure', key: 'pulls' } as const, [] as AzurePull[])
const pullsHealthAtom = atom({ plugin: 'azure', key: 'pullsHealth' } as const, null as AzureHealth | null)

// Two panes show as two tabs.
const PANE_RUNS = 'azure-pipelines'
const PANE_PRS = 'azure-prs'
const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`
const MAX_RUNS = 15
const MAX_RESOURCES = 20
const MAX_HINTS = 5
const RECENT_MS = 12 * 60 * 60 * 1000

// A command that queues a run: az, or a POST to the runs or builds API.
const QUEUE_COMMAND = /\baz\s+pipelines\s+(?:run|build\s+queue)\b/
const QUEUE_API = /_apis\/(?:pipelines\/\d+\/runs|build\/builds)\b/
// A command that decides an approval: a PATCH to the approvals API, however it is sent.
const APPROVAL_API = /pipelines\/approvals|pipelinesapproval/i
const PATCH = /\bpatch\b/i

/** Module memory, shared by the functions below and rebuilt on every reload. */
type Ctx = {
  config: AdoConfig
  projects: string[]
  me: string
  ticks: number
  isTicking: boolean
  isReadingPulls: boolean
  lastWaiting: number
  lastReviews: Set<string> | null
  subscriptionTenants: Map<string, string>
  utcOffsetMinutes: number
  stageByApproval: Map<string, string>
  hinted: Set<string>
  memberOf: Set<string> | null
  teamIsMine: Map<string, boolean>
  chords: Map<string, string> | null
}

/** `https://dev.azure.com/contoso/` and `contoso` both read as `contoso`. */
const orgName = (value: string) => value.trim().replace(/^https:\/\/dev\.azure\.com\//i, '').replace(/\/+$/, '')
const list = (value: unknown) => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean)

export const register: Register = (on, options) => {
  const tenants = parseTenants(String(options.tenants ?? ''))
  const pollMs = Math.max(10, Number(options.pollSeconds ?? 30)) * 1000
  const isHumanOnly = options.humanOnlyApprovals === true
  const hasLinkHints = options.linkHints !== false
  const hasBand = options.band !== false
  const ctx: Ctx = {
    config: { organization: orgName(String(options.organization ?? '')), tenant: String(options.adoTenant ?? '').trim() },
    projects: list(options.projects),
    me: '',
    ticks: 0,
    isTicking: false,
    isReadingPulls: false,
    lastWaiting: 0,
    lastReviews: null,
    subscriptionTenants: new Map(),
    utcOffsetMinutes: 0,
    stageByApproval: new Map(),
    hinted: new Set(),
    memberOf: null,
    teamIsMine: new Map(),
    chords: null,
  }

  const promptSection = () =>
    [
      '# Azure links and pipeline results (azure plugin)',
      `- When you name an Azure resource, link it: https://portal.azure.com/#@<tenantId>/resource<resourceId>.${
        tenants.length ? ` Tenants: ${tenants.map(t => `${t.label} ${t.id}`).join(', ')}.` : ''
      } When a tool result carries azure plugin portal links, use those.`,
      `- Link an Azure DevOps run as https://dev.azure.com/${ctx.config.organization || '<org>'}/<project>/_build/results?buildId=<id>, a pull request as .../_git/<repo>/pullrequest/<id>.`,
      `- A run whose result is succeeded can still have skipped stages that ran nothing. Read its stages with ${TOOL('pipeline_status')} before you call a deploy done.`,
      `- For the person's own pull requests and what blocks them, and the ones that wait for their vote, call ${TOOL('pull_requests')}.`,
      `- After you queue a run whose outcome you must act on, call ${TOOL('pipeline_watch')} with wake=true and stop polling; a prompt arrives when it finishes or waits on an approval.`,
      isHumanOnly
        ? '- You never approve or reject a pipeline approval. When a run waits on one, tell the person and point them to /azure:runs, where they decide it.'
        : '',
    ]
      .filter(Boolean)
      .join('\n')

  const runArg = (run: unknown, project: unknown) =>
    parseRunArg(String(run ?? ''), ctx.config.organization, optional(project) ?? ctx.projects[0])

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'runs',
      description: 'Azure DevOps runs and approvals pane: open it, or watch, check or clear runs',
      argumentHint: '[watch <run> | check <run> | clear | refresh]',
    })
    await $.command.register({
      name: 'prs',
      description: 'Azure DevOps pull requests pane: yours with their checks, and those that wait for your vote',
    })
    const run = { type: 'string', description: 'The run URL, or its build id' }
    const project = { type: 'string', description: 'The project, when run is a bare build id' }
    await $.tool.register({
      name: 'pipeline_status',
      description:
        'Read one Azure DevOps pipeline run stage by stage: each stage with its state and result (a skipped stage ran nothing), the approval it waits on, and the log tail of the first failed task. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { run, project, logLines: { type: 'number', description: 'Log lines of the failed task (default 40)' } },
        required: ['run'],
      },
    })
    await $.tool.register({
      name: 'pipeline_watch',
      description:
        'Watch an Azure DevOps run in the Pipelines pane. With wake=true, a prompt reaches this session when the run finishes or waits on an approval, so you need not poll.',
      inputSchema: {
        type: 'object',
        properties: { run, project, wake: { type: 'boolean', description: 'Prompt the session when it finishes or waits' } },
        required: ['run'],
      },
    })
    await $.tool.register({
      name: 'pipeline_approvals',
      description:
        'List the pending pipeline approvals the signed-in person may decide, with stage, instructions and run link. Read-only.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'pull_requests',
      description:
        "List the signed-in person's active Azure DevOps pull requests with what blocks each one (checks, votes, open comments, conflicts), and the ones that wait for their vote, directly or through a team. Read-only.",
      inputSchema: { type: 'object', properties: {} },
    })

    if ((await read($, runsAtom)).length === 0) {
      const stored = await $.store.get('runs')
      if (Array.isArray(stored) && stored.length) await update($, runsAtom, () => (stored as AzureRun[]).slice(0, MAX_RUNS))
    }

    void loadDefaults($, ctx).then(() => tick($, ctx))
    void loadSubscriptionTenants($, ctx)
    void loadUtcOffset($, ctx)
    $.clock.every(pollMs, () => void tick($, ctx))
    return next(e)
  })

  on('command.run', { command: 'runs' }, async ($, e) => {
    const [verb = '', target = '', project] = e.args.trim().split(/\s+/)
    if (verb === 'watch' || verb === 'check') {
      const ref = runArg(target, project)
      if (!ref) return { text: `Give the run as its URL, or as a build id and a project: /azure:runs ${verb} 1234 my-project` }
      if (verb === 'check') return { text: await statusText($, ctx, ref, 40) }
      const run = await addRun($, ctx, ref, false, false)
      await openPanes($, PANE_RUNS)
      return { text: `Watching ${run.pipeline} ${run.number} (${run.url}).` }
    }
    if (verb === 'clear') {
      await clearFinished($)
      return { text: 'Cleared the finished runs.' }
    }
    if (verb === 'refresh') {
      resetAuth()
      ctx.me = ''
    }
    await openPanes($, PANE_RUNS)
    void tick($, ctx)
    return { text: 'Opened the Azure DevOps pane.' }
  })

  on('command.run', { command: 'prs' }, async $ => {
    await openPanes($, PANE_PRS)
    void refreshPulls($, ctx).then(() => signal($, ctx))
    return { text: 'Opened the pull requests tab.' }
  })

  on('tool.call', { tool: 'mcp__azure__pipeline_status' }, async ($, e) => {
    const ref = runArg(e.run, e.project)
    if (!ref) return { result: 'Give the run as its URL, or as a build id with its project.' }
    return { result: await statusText($, ctx, ref, Number(e.logLines ?? 40)) }
  })

  on('tool.call', { tool: 'mcp__azure__pipeline_watch' }, async ($, e) => {
    const ref = runArg(e.run, e.project)
    if (!ref) return { result: 'Give the run as its URL, or as a build id with its project.' }
    const run = await addRun($, ctx, ref, e.wake === true, false)
    await ensurePanes($, PANE_RUNS)
    const wakeNote = run.wake ? ' A prompt reaches you when it finishes or waits on an approval; do not poll it.' : ''
    return { result: `Watching ${run.pipeline} ${run.number} (${run.url}): ${run.verdict}.${wakeNote}` }
  })

  on('tool.call', { tool: 'mcp__azure__pipeline_approvals' }, async $ => {
    const failure = await refreshApprovals($, ctx).then(() => undefined, messageOf)
    if (failure !== undefined) return { result: `Could not read the approvals, so this is no answer about them: ${failure}` }
    const approvals = await read($, approvalsAtom)
    if (!approvals.length) {
      return { result: `No pipeline approval waits for the signed-in person in ${scope(ctx, await read($, runsAtom)).join(', ') || 'any project'}.` }
    }
    const where = isHumanOnly ? ' Only they decide them, in the /azure:runs pane.' : ''
    return {
      result: [
        `${approvals.length} approval(s) wait for the person.${where}`,
        ...approvals.map(a =>
          [
            `- ${a.pipeline} ${a.run}, stage "${a.stage}", waiting since ${a.createdOn} (approval id ${a.id}, project ${a.project})`,
            a.instructions ? `  Instructions: ${oneLine(a.instructions, 300)}` : '',
            `  ${a.url}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__azure__pull_requests' }, async $ => {
    await refreshPulls($, ctx)
    const health = await read($, pullsHealthAtom)
    if (!health?.isOk) return { result: `Could not read the pull requests, so this is no answer about them: ${health?.text ?? 'no read'}` }
    const pulls = await read($, pullsAtom)
    const line = (p: AzurePull) =>
      `- !${p.id} ${p.repository} "${p.title}"${p.role === 'review' ? ` by ${p.author}` : ''}: ${p.verdict}\n  ${p.url}`
    const mine = pulls.filter(p => p.role === 'mine')
    const reviews = pulls.filter(p => p.role === 'review')
    return {
      result: [
        `The person's active pull requests (${mine.length}):`,
        ...mine.map(line),
        `Pull requests that wait for their vote (${reviews.length}):`,
        ...reviews.map(line),
      ].join('\n'),
    }
  })

  // Every tool call: refuse a model's approval (when human-only), watch the runs it queues, link the resources it reads.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const command = typeof (e as { command?: unknown }).command === 'string' ? (e as { command: string }).command : ''

    if (isHumanOnly && APPROVAL_API.test(command) && PATCH.test(command)) {
      return {
        deny: 'azure: a pipeline approval is decided by the person, not the model. Tell them which run waits; they approve or reject it in /azure:runs.',
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || typeof ran.text !== 'string') return ran

    if (QUEUE_COMMAND.test(command) || (QUEUE_API.test(command) && /\bPOST\b/i.test(command))) {
      for (const ref of findRuns(ran.text).slice(0, 3)) {
        const run = await addRun($, ctx, ref, false, false).catch(() => undefined)
        if (run) {
          $.ui.toast(`Watching ${run.pipeline} ${run.number}`)
          await ensurePanes($, PANE_RUNS)
        }
      }
    }

    if (tool !== 'Bash' && tool !== 'PowerShell') return ran
    const found = findResources(ran.text, sub => ctx.subscriptionTenants.get(sub))
    if (!found.length) return ran
    await update($, resourcesAtom, held =>
      [...found.filter(r => !held.some(h => h.id.toLowerCase() === r.id.toLowerCase())), ...held].slice(0, MAX_RESOURCES),
    )
    const fresh = found.filter(r => !ctx.hinted.has(r.id.toLowerCase())).slice(0, MAX_HINTS)
    if (!hasLinkHints || !fresh.length) return ran
    fresh.forEach(r => ctx.hinted.add(r.id.toLowerCase()))
    const hint = ['azure plugin portal links; use them when you name these resources:', ...fresh.map(r => `- [${r.name}](${r.url}) (${r.type})`)]
    return { ...ran, context: [...(ran.context ?? []), hint.join('\n')] }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'azure:links', text: promptSection(), scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_RUNS }, async ($, e) =>
    drawPipelines(
      $.ui.resolve(e),
      {
        organization: ctx.config.organization,
        runs: await read($, runsAtom),
        approvals: await read($, approvalsAtom),
        resources: await read($, resourcesAtom),
        confirm: await read($, confirmAtom),
        sending: await read($, sendingAtom),
        health: await read($, healthAtom),
        now: await $.clock.now(),
        utcOffsetMinutes: ctx.utcOffsetMinutes,
      },
      {
        arm: (approvalId, action) => update($, confirmAtom, () => ({ approvalId, action })),
        cancel: () => update($, confirmAtom, () => null),
        send: () => sendDecision($, ctx),
        clearFinished: () => clearFinished($),
      },
    ),
  )

  on('ui.render', { component: 'Pane', requestId: PANE_PRS }, async ($, e) =>
    drawPulls(
      $.ui.resolve(e),
      {
        organization: ctx.config.organization,
        pulls: await read($, pullsAtom),
        health: await read($, pullsHealthAtom),
        now: await $.clock.now(),
        utcOffsetMinutes: ctx.utcOffsetMinutes,
      },
      () => refreshPulls($, ctx).then(() => signal($, ctx)),
    ),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!hasBand || e.props.hasSurvey) return next(e)
    if (ctx.chords === null) await loadChords($, ctx)
    const labels = await titles($)
    return drawBand($.ui.resolve(e), [
      {
        key: 'pipelines',
        label: labels[PANE_RUNS]!,
        chord: ctx.chords?.get('runs'),
        isUrgent: (await read($, approvalsAtom)).length > 0,
        open: () => openPanes($, PANE_RUNS).then(() => tick($, ctx)),
      },
      {
        key: 'prs',
        label: labels[PANE_PRS]!,
        chord: ctx.chords?.get('prs'),
        isUrgent: needsYou(await read($, pullsAtom)) > 0,
        open: () => openPanes($, PANE_PRS).then(() => refreshPulls($, ctx)).then(() => signal($, ctx)),
      },
    ])
  })
}

function transport($: Engine): Transport {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
    patFromEnv: () => $.env.get('AZURE_DEVOPS_EXT_PAT'),
    run: (argv, init) => $.process.run(argv, init),
  }
}

const optional = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const scope = (ctx: Ctx, runs: readonly AzureRun[]) => [...new Set([...ctx.projects, ...runs.map(r => r.projectName)])]

/** An auth failure stops the whole poll; any other failure skips one item. */
function rethrowAuth(error: unknown): undefined {
  if (error instanceof AdoError && [0, 401, 403].includes(error.status)) throw error
  return undefined
}

/**
 * A project that does not exist or cannot be seen (404 for both) is skipped. Every
 * other failure stops the read, so an empty list always means nothing waits.
 */
function skipProject(error: unknown): never[] {
  if (error instanceof AdoError && error.status === 404) return []
  throw error
}

/** Organization and projects the settings left empty come from `az devops configure --defaults`. */
async function loadDefaults($: Engine, ctx: Ctx): Promise<void> {
  if (ctx.config.organization && ctx.projects.length) return
  const out = await $.process.run(['az', 'devops', 'configure', '--list'], { timeoutMs: 20_000 }).catch(() => undefined)
  if (out?.exitCode !== 0) return
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, 'm').exec(out.stdout)?.[1] ?? ''
  ctx.config.organization ||= orgName(value('organization'))
  if (!ctx.projects.length && value('project')) ctx.projects = [value('project')]
}

async function titles($: Engine): Promise<Record<string, string>> {
  const approvals = (await read($, approvalsAtom)).length
  const pulls = needsYou(await read($, pullsAtom))
  return {
    [PANE_RUNS]: approvals ? `Pipelines · ${approvals}` : 'Pipelines',
    [PANE_PRS]: pulls ? `Pull requests · ${pulls}` : 'Pull requests',
  }
}

/**
 * The person asked for `front`: open both tabs with that one shown. Only a newly
 * opened tab comes to the front, so a hidden one is closed and opened again.
 */
async function openPanes($: Engine, front: string): Promise<void> {
  const labels = await titles($)
  const back = front === PANE_RUNS ? PANE_PRS : PANE_RUNS
  if (!(await $.ui.panes()).some(p => p.id === back)) await $.ui.open({ id: back, title: labels[back] })
  if ((await $.ui.panes()).some(p => p.id === front && !p.isShown)) await $.ui.close({ id: front })
  await $.ui.open({ id: front, title: labels[front] })
}

/** Nobody asked: open the tabs only when none is open, so a poll never moves a tab under the pointer. */
async function ensurePanes($: Engine, front: string): Promise<void> {
  if ((await $.ui.panes()).length === 0) await openPanes($, front)
}

/** Sends the armed decision. Only the second press in the pane reaches this. */
async function sendDecision($: Engine, ctx: Ctx): Promise<void> {
  const confirm = await read($, confirmAtom)
  const approval = (await read($, approvalsAtom)).find(a => a.id === confirm?.approvalId)
  await update($, confirmAtom, () => null)
  if (!confirm || !approval) return

  await update($, sendingAtom, () => approval.id)
  try {
    await decideApproval(transport($), ctx.config, approval.project, approval.id, confirm.action)
    $.ui.toast(`${confirm.action === 'approved' ? 'Approved' : 'Rejected'}: ${approval.pipeline} · ${approval.stage}`)
    await update($, approvalsAtom, held => held.filter(a => a.id !== approval.id))
    await update($, runsAtom, held => held.map(r => (r.buildId === approval.buildId ? { ...r, isWaitAnnounced: false } : r)))
  } catch (error) {
    $.ui.toast(`Azure DevOps did not take the decision: ${messageOf(error)}`, { timeoutMs: 10_000 })
  } finally {
    await update($, sendingAtom, () => null)
  }
  void tick($, ctx)
}

async function clearFinished($: Engine): Promise<void> {
  await update($, runsAtom, held => held.filter(r => r.status !== 'completed'))
  await persistRuns($)
}

/** One poll: watched runs every time, approvals every second, your recent runs and pull requests every fourth. */
async function tick($: Engine, ctx: Ctx): Promise<void> {
  if (ctx.isTicking) return
  ctx.isTicking = true
  ctx.ticks += 1
  try {
    if (!ctx.config.organization) throw new AdoError('no organization: set it in /config, or run az devops configure --defaults organization=…', 0)
    if (!ctx.me) ctx.me = await myIdentity(transport($), ctx.config)

    let failure: unknown
    for (const run of await read($, runsAtom)) {
      if (run.status === 'completed') continue
      await refreshRun($, ctx, run).catch(async (error: unknown) => {
        rethrowAuth(error)
        if (error instanceof AdoError && error.status === 404) {
          await update($, runsAtom, held =>
            held.map(r => (r.key === run.key ? { ...r, status: 'completed', tone: 'idle' as const, verdict: 'not found: deleted, or not readable' } : r)),
          )
        } else failure ??= error
      })
    }
    if (ctx.ticks % 2 === 1) await refreshApprovals($, ctx)
    if (ctx.ticks % 4 === 1) {
      void loadChords($, ctx)
      await discoverRuns($, ctx)
      // Its own health line: a pull request failure does not mark the runs unread.
      void refreshPulls($, ctx).then(() => signal($, ctx))
    }
    // One run that cannot be read makes the pane say so, not "ok".
    if (failure !== undefined) throw failure
    const checkedAt = await $.clock.now()
    await update($, healthAtom, () => ({ isOk: true, text: 'ok', source: authSource(), checkedAt }))
  } catch (error) {
    const checkedAt = await $.clock.now()
    await update($, healthAtom, () => ({ isOk: false, text: messageOf(error), source: authSource(), checkedAt }))
  } finally {
    ctx.isTicking = false
    await signal($, ctx)
  }
}

function fromBuild(b: Build): Partial<AzureRun> {
  return {
    projectName: b.project.name,
    pipeline: b.definition.name,
    number: b.buildNumber,
    branch: b.sourceBranch.replace(/^refs\/heads\//, ''),
    status: b.status,
    result: b.result ?? null,
    queuedAt: b.queueTime,
    finishedAt: b.finishTime ?? null,
  }
}

/** Unfinished runs first, then the newest; at most MAX_RUNS. */
const order = (runs: AzureRun[]) =>
  [...runs]
    .sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || Date.parse(b.queuedAt) - Date.parse(a.queuedAt))
    .slice(0, MAX_RUNS)

async function refreshRun($: Engine, ctx: Ctx, run: AzureRun): Promise<AzureRun> {
  const t = transport($)
  const build = await getBuild(t, ctx.config, run.project, run.buildId)
  const verdict = judgeRun(build, await getTimeline(t, ctx.config, run.project, run.buildId))
  const fresh: AzureRun = { ...run, ...fromBuild(build), stages: verdict.stages, tone: verdict.tone, verdict: verdict.text }
  const announce = (what: string) => {
    $.ui.toast(`${fresh.pipeline} ${fresh.number}: ${fresh.verdict}`, { timeoutMs: 8000 })
    if (fresh.wake) void $.prompt.submit({ text: `azure: run ${fresh.number} of ${fresh.pipeline} ${what} ${fresh.url}` })
  }

  if (fresh.tone === 'waiting' && !run.isWaitAnnounced) announce(`${fresh.verdict}. The person decides the approval.`)
  fresh.isWaitAnnounced = fresh.tone === 'waiting'
  if (fresh.status === 'completed' && !run.isAnnounced) {
    announce(`finished: ${fresh.verdict}. Read ${TOOL('pipeline_status')} for the stages and the failed log before you act.`)
    fresh.isAnnounced = true
  }

  await update($, runsAtom, held => order(held.map(r => (r.key === fresh.key ? fresh : r))))
  await persistRuns($)
  return fresh
}

async function addRun($: Engine, ctx: Ctx, ref: RunRef, wake: boolean, isAnnounced: boolean): Promise<AzureRun> {
  const key = runKey(ref)
  const known = (await read($, runsAtom)).find(r => r.key === key)
  if (known) {
    const merged = { ...known, wake: known.wake || wake }
    await update($, runsAtom, held => held.map(r => (r.key === key ? merged : r)))
    return known.status === 'completed' ? merged : refreshRun($, ctx, merged)
  }
  const placeholder: AzureRun = {
    key,
    organization: ref.organization,
    project: ref.project,
    projectName: ref.project,
    buildId: ref.buildId,
    pipeline: `run ${ref.buildId}`,
    number: '',
    branch: '',
    status: 'unknown',
    result: null,
    stages: [],
    tone: 'idle',
    verdict: 'reading…',
    url: runUrl(ref),
    wake,
    isAnnounced,
    isWaitAnnounced: false,
    queuedAt: new Date(await $.clock.now()).toISOString(),
    finishedAt: null,
  }
  await update($, runsAtom, held => order([placeholder, ...held]))
  return refreshRun($, ctx, placeholder)
}

async function refreshApprovals($: Engine, ctx: Ctx): Promise<void> {
  const t = transport($)
  const runs = await read($, runsAtom)
  const found: AzureApproval[] = []
  for (const project of scope(ctx, runs)) {
    for (const a of await listApprovals(t, ctx.config, project).catch(skipProject)) {
      const buildId = a.pipeline?.owner?.id
      // `update` is the right to decide it; `view` alone is someone else's gate.
      if (!buildId || !/update/i.test(a.permissions ?? '')) continue
      let stage = ctx.stageByApproval.get(a.id)
      if (!stage) {
        const records = await getTimeline(t, ctx.config, project, buildId).catch(() => [])
        stage = stageOf(records, a.id)?.name ?? 'stage unknown'
        ctx.stageByApproval.set(a.id, stage)
      }
      found.push({
        id: a.id,
        organization: ctx.config.organization,
        project,
        buildId,
        pipeline: a.pipeline?.name ?? '',
        run: a.pipeline?.owner?.name ?? `#${buildId}`,
        stage,
        instructions: a.instructions ?? '',
        createdOn: a.createdOn,
        url: runUrl({ organization: ctx.config.organization, project, buildId }),
      })
    }
  }
  await update($, approvalsAtom, () => found)
  for (const a of found) {
    const ref = { organization: a.organization, project: a.project, buildId: a.buildId }
    if (!runs.some(r => r.key === runKey(ref))) await addRun($, ctx, ref, false, false).catch(rethrowAuth)
  }
}

/** The person's own runs of the last 12 hours, in the configured projects. */
async function discoverRuns($: Engine, ctx: Ctx): Promise<void> {
  if (!ctx.me) return
  const since = new Date((await $.clock.now()) - RECENT_MS).toISOString()
  for (const project of ctx.projects) {
    for (const b of await myRecentBuilds(transport($), ctx.config, project, ctx.me, since).catch(skipProject)) {
      const ref = { organization: ctx.config.organization, project: b.project.name, buildId: b.id }
      if (!(await read($, runsAtom)).some(r => r.key === runKey(ref))) {
        await addRun($, ctx, ref, false, b.status === 'completed').catch(rethrowAuth)
      }
    }
  }
}

async function statusText($: Engine, ctx: Ctx, ref: RunRef, logLines: number): Promise<string> {
  const t = transport($)
  const config = { ...ctx.config, organization: ref.organization }
  const build = await getBuild(t, config, ref.project, ref.buildId)
  const verdict = judgeRun(build, await getTimeline(t, config, ref.project, ref.buildId))
  const approvals = (await read($, approvalsAtom)).filter(a => a.buildId === build.id)
  const lines = [
    `Run ${build.buildNumber} of ${build.definition.name} (definition ${build.definition.id}, project ${build.project.name})`,
    `Branch ${build.sourceBranch.replace(/^refs\/heads\//, '')}, queued ${build.queueTime}${build.requestedFor ? ` for ${build.requestedFor.displayName}` : ''}`,
    `Status ${build.status}, result ${build.result ?? 'none yet'}`,
    `Verdict: ${verdict.text}`,
    'Stages:',
    ...verdict.stages.map(
      (s, i) => `  ${i + 1}. ${s.name}: ${s.state}${s.result ? `, ${s.result}` : ''}${s.isWaiting ? ', waiting on an approval or check' : ''}`,
    ),
    ...approvals.map(a => `Approval at "${a.stage}" waits for the person${a.instructions ? `: ${oneLine(a.instructions, 300)}` : ''}`),
    `Link: ${runUrl({ organization: ref.organization, project: build.project.name, buildId: build.id })}`,
  ]
  const logId = verdict.failedTask?.log?.id
  if (logId && logLines > 0) {
    const n = Math.min(logLines, 200)
    const tail = await getLogTail(t, config, ref.project, ref.buildId, logId, n).catch(e => `(log not readable: ${messageOf(e)})`)
    lines.push(`Log of "${verdict.failedTask?.name}", last ${n} lines:`, tail)
  }
  return lines.join('\n')
}

async function loadSubscriptionTenants($: Engine, ctx: Ctx): Promise<void> {
  const out = await $.process
    .run(['az', 'account', 'list', '--all', '--query', '[].{id:id,tenantId:tenantId}', '-o', 'json'], { timeoutMs: 20_000 })
    .catch(() => undefined)
  if (out?.exitCode !== 0) return
  try {
    for (const s of JSON.parse(out.stdout) as { id: string; tenantId: string }[]) ctx.subscriptionTenants.set(s.id.toLowerCase(), s.tenantId)
  } catch {
    // No tenant: the portal opens the link in the current directory.
  }
}

/** The chords the person bound to /azure:runs and /azure:prs, so the buttons show keys that work. */
async function loadChords($: Engine, ctx: Ctx): Promise<void> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  ctx.chords = chordsOf(await $.fs.read(`${dir}/keybindings.json`).catch(() => ''), PLUGIN)
}

/** The module has no time zone of its own; the host's `date` knows it. */
async function loadUtcOffset($: Engine, ctx: Ctx): Promise<void> {
  const out = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 }).catch(() => undefined)
  const m = /^([+-])(\d{2})(\d{2})/.exec(out?.stdout.trim() ?? '')
  if (m) ctx.utcOffsetMinutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/** A new approval opens the pane; the tab labels carry the counts. */
async function signal($: Engine, ctx: Ctx): Promise<void> {
  const waiting = (await read($, approvalsAtom)).length
  if (waiting > ctx.lastWaiting) await ensurePanes($, PANE_RUNS)
  ctx.lastWaiting = waiting
  const labels = await titles($)
  for (const pane of await $.ui.panes()) {
    const label = labels[pane.id]
    if (label !== undefined && pane.title !== label) await $.ui.open({ id: pane.id, title: label })
  }
}

/**
 * The person's own active pull requests with policies and open comments, and every
 * active one that waits for their vote. A failure keeps the last lists and says so.
 */
async function refreshPulls($: Engine, ctx: Ctx): Promise<void> {
  if (ctx.isReadingPulls) return
  ctx.isReadingPulls = true
  try {
    const t = transport($)
    const c = ctx.config
    if (!c.organization) throw new AdoError('no organization: set it in /config, or run az devops configure --defaults organization=…', 0)
    ctx.me ||= await myIdentity(t, c)
    const me = ctx.me
    const memberOf = (ctx.memberOf ??= await myGroupDescriptors(t, c, me))
    const mine = await listActivePulls(t, c, `searchCriteria.creatorId=${encodeURIComponent(me)}`)
    const others = (await listActivePulls(t, c)).filter(p => p.createdBy.id !== me)
    const unknownTeams = [
      ...new Set(others.flatMap(p => p.reviewers.filter(r => r.isContainer && !ctx.teamIsMine.has(r.id)).map(r => r.id))),
    ]
    if (unknownTeams.length) {
      const descriptors = await groupDescriptors(t, c, unknownTeams)
      for (const id of unknownTeams) ctx.teamIsMine.set(id, memberOf.has(descriptors.get(id) ?? ''))
    }
    const myTeams = new Set([...ctx.teamIsMine].filter(([, isMine]) => isMine).map(([id]) => id))
    const evaluations = (p: PullRequest) => getPolicyEvaluations(t, c, p.repository.project.id, p.pullRequestId)
    const toPull = (p: PullRequest, role: AzurePull['role'], v: PullVerdict, openComments: number): AzurePull => ({
      key: `${p.repository.id}/${p.pullRequestId}`,
      id: p.pullRequestId,
      role,
      project: p.repository.project.name,
      repository: p.repository.name,
      title: p.title,
      author: p.createdBy.displayName,
      createdOn: p.creationDate,
      isDraft: p.isDraft,
      checks: v.checks,
      openComments,
      tone: v.tone,
      verdict: v.text,
      url: pullUrl(c.organization, p),
    })
    const fresh = [
      ...(await Promise.all(
        mine.map(async p => {
          if (p.isDraft) return toPull(p, 'mine', judgeMine(p, [], 0), 0)
          const [evals, open] = await Promise.all([
            evaluations(p),
            countOpenThreads(t, c, p.repository.project.id, p.repository.id, p.pullRequestId),
          ])
          return toPull(p, 'mine', judgeMine(p, evals, open), open)
        }),
      )),
      ...(await Promise.all(
        others.flatMap(p => {
          const via = waitsForMe(p, me, myTeams)
          return via ? [evaluations(p).then(evals => toPull(p, 'review', judgeReview(p, evals, via, me), 0))] : []
        }),
      )),
    ]
    await announcePulls($, ctx, await read($, pullsAtom), fresh)
    await update($, pullsAtom, () => fresh)
    const checkedAt = await $.clock.now()
    await update($, pullsHealthAtom, () => ({ isOk: true, text: 'ok', source: authSource(), checkedAt }))
  } catch (error) {
    const checkedAt = await $.clock.now()
    await update($, pullsHealthAtom, () => ({ isOk: false, text: messageOf(error), source: authSource(), checkedAt }))
  } finally {
    ctx.isReadingPulls = false
  }
}

/** Toasts what changed since the last read; the first read only sets the baseline. */
async function announcePulls($: Engine, ctx: Ctx, before: readonly AzurePull[], after: readonly AzurePull[]): Promise<void> {
  const previous = ctx.lastReviews
  ctx.lastReviews = new Set(after.filter(p => p.role === 'review').map(p => p.key))
  if (previous === null) return

  for (const p of after.filter(p => p.role === 'mine' && !p.isDraft)) {
    const old = before.find(o => o.key === p.key)
    if (old && (old.tone !== p.tone || p.openComments > old.openComments)) $.ui.toast(`!${p.id} ${p.title}: ${p.verdict}`, { timeoutMs: 8000 })
  }
  const added = after.filter(p => p.role === 'review' && !previous.has(p.key))
  if (added.length === 1) $.ui.toast(`!${added[0]!.id} waits for your vote: ${added[0]!.title}`, { timeoutMs: 8000 })
  if (added.length > 1) $.ui.toast(`${added.length} new pull requests wait for your vote`, { timeoutMs: 8000 })
  if (added.length) await ensurePanes($, PANE_PRS)
}

/** Unfinished runs and those finished in the last 12 hours survive a restart. */
async function persistRuns($: Engine): Promise<void> {
  const cutoff = (await $.clock.now()) - RECENT_MS
  const keep = (await read($, runsAtom)).filter(r => r.status !== 'completed' || Date.parse(r.finishedAt ?? r.queuedAt) > cutoff)
  await $.store.set('runs', keep)
}
