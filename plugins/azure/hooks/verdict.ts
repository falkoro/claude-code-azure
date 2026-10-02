import type { AzureCheck, AzureStage, AzureTone } from '../types'

// ---------- Runs ----------

/** One record of a build timeline: the fields a verdict reads. */
export type TimelineRecord = {
  id: string
  parentId?: string | null
  type: string
  name: string
  state?: string | null
  result?: string | null
  order?: number | null
  warningCount?: number | null
  issues?: { type?: string; message?: string }[] | null
  log?: { id?: number; url?: string } | null
}

export type RunVerdict = {
  tone: AzureTone
  text: string
  stages: AzureStage[]
  /** The first failed task, for a log tail. */
  failedTask?: TimelineRecord
}

const GREEN = new Set(['succeeded', 'succeededWithIssues', 'partiallySucceeded'])

/** The Stage record that holds a record, walking up through jobs and checkpoints. */
export function stageOf(records: readonly TimelineRecord[], id: string): TimelineRecord | undefined {
  const byId = new Map(records.map(r => [r.id, r]))
  let r = byId.get(id)
  while (r && r.type !== 'Stage') r = r.parentId ? byId.get(r.parentId) : undefined
  return r
}

/**
 * Reads a run stage by stage. A green result whose stages were skipped ran nothing
 * there, so it is a warning, never a plain success.
 */
export function judgeRun(build: { status: string; result?: string | null }, records: readonly TimelineRecord[]): RunVerdict {
  const byOrder = (a: TimelineRecord, b: TimelineRecord) => (a.order ?? 0) - (b.order ?? 0)
  const stageRecords = records.filter(r => r.type === 'Stage').sort(byOrder)
  const waitingIds = new Set(
    records
      .filter(r => r.type.startsWith('Checkpoint.') && r.state === 'inProgress')
      .map(r => stageOf(records, r.id)?.id),
  )
  const stages: AzureStage[] = stageRecords.map(r => ({
    name: r.name,
    state: r.state ?? 'pending',
    result: r.result ?? null,
    isWaiting: waitingIds.has(r.id),
  }))
  const names = (list: AzureStage[]) => list.map(s => s.name).join(', ')

  if (build.status !== 'completed') {
    const waiting = stages.filter(s => s.isWaiting)
    if (waiting.length) return { tone: 'waiting', text: `waiting for approval: ${names(waiting)}`, stages }
    const running = stages.find(s => s.state === 'inProgress')
    const text = running ? `running: ${running.name}` : build.status === 'notStarted' ? 'queued' : 'running'
    return { tone: 'running', text, stages }
  }

  const result = build.result ?? 'none'

  if (result === 'failed') {
    const stage = stageRecords.find(r => r.result === 'failed')
    const failedTask = records
      .filter(r => r.type === 'Task' && r.result === 'failed')
      .sort(byOrder)
      .find(r => !stage || stageOf(records, r.id)?.id === stage.id)
    const error = failedTask?.issues?.find(i => i.type === 'error')?.message
    const where = [stage?.name, failedTask?.name].filter(Boolean).join(' > ')
    return {
      tone: 'bad',
      text: `failed${where ? ` at ${where}` : ''}${error ? `: ${oneLine(error, 160)}` : ''}`,
      stages,
      failedTask,
    }
  }

  if (result === 'canceled') {
    const at = stages.find(s => s.result === 'canceled')
    return { tone: 'bad', text: `canceled${at ? ` at ${at.name}` : ''}`, stages }
  }

  if (!GREEN.has(result)) return { tone: 'bad', text: result, stages }

  const skipped = stages.filter(s => s.result === 'skipped')
  if (stages.length && skipped.length === stages.length) {
    return { tone: 'warn', text: `${result}, but every stage was skipped: nothing ran`, stages }
  }
  if (skipped.length) {
    return {
      tone: 'warn',
      text: `${result}, but ${skipped.length} of ${stages.length} stages skipped (${names(skipped)}): those ran nothing`,
      stages,
    }
  }
  if (result !== 'succeeded') {
    const warnings = records.reduce((n, r) => n + (r.type === 'Task' ? r.warningCount ?? 0 : 0), 0)
    return { tone: 'warn', text: `${result}${warnings ? ` (${warnings} warnings)` : ''}`, stages }
  }
  return { tone: 'ok', text: 'succeeded', stages }
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// ---------- Pull requests ----------

/** A reviewer: a person, or a team (container) the person may be in. */
export type Reviewer = {
  id: string
  displayName: string
  vote: number
  isRequired?: boolean
  hasDeclined?: boolean
  isContainer?: boolean
}

export type PullRequest = {
  pullRequestId: number
  title: string
  isDraft: boolean
  mergeStatus?: string
  creationDate: string
  createdBy: { id: string; displayName: string }
  reviewers: Reviewer[]
  repository: { id: string; name: string; project: { id: string; name: string } }
}

export type PolicyEvaluation = {
  status: string
  configuration: {
    isBlocking: boolean
    isEnabled: boolean
    type: { displayName: string }
    settings?: { displayName?: string }
  }
  context?: { isExpired?: boolean } | null
}

export type PullVerdict = { tone: AzureTone; text: string; checks: AzureCheck[] }

// Azure DevOps policy type names, said the short way.
const CHECK_NAMES: Record<string, string> = {
  'Minimum number of reviewers': 'reviewers',
  'Required reviewers': 'required reviewers',
  'Comment requirements': 'comments',
  Build: 'build',
  'Work item linking': 'work items',
  'Require a merge strategy': 'merge strategy',
}

// Worst first.
const SEVERITY: AzureTone[] = ['bad', 'warn', 'running', 'waiting', 'idle', 'ok']
const COMMENTS = 'comments'

/** One check per policy kind for the enabled, blocking policies; the worst state of a kind wins. */
export function checksOf(evaluations: readonly PolicyEvaluation[]): AzureCheck[] {
  const checks = new Map<string, AzureCheck>()
  for (const { status, configuration: c, context } of evaluations) {
    if (!c.isEnabled || !c.isBlocking || status === 'notApplicable') continue
    const isBuild = c.type.displayName === 'Build'
    const name = (isBuild && c.settings?.displayName) || CHECK_NAMES[c.type.displayName] || c.type.displayName.toLowerCase()
    let state: AzureTone
    if (status === 'approved') state = isBuild && context?.isExpired ? 'warn' : 'ok'
    // The comment policy rejects while a thread is open: work for the author, not a failure.
    else if (status === 'rejected' || status === 'broken') state = name === COMMENTS ? 'warn' : 'bad'
    else state = isBuild ? 'running' : 'waiting'
    const held = checks.get(name)
    if (!held || SEVERITY.indexOf(state) < SEVERITY.indexOf(held.state)) checks.set(name, { name, state })
  }
  return [...checks.values()]
}

/** One of the person's own pull requests: every blocker, or "ready to complete". */
export function judgeMine(pull: PullRequest, evaluations: readonly PolicyEvaluation[], openComments: number): PullVerdict {
  const checks = checksOf(evaluations)
  if (pull.isDraft) return { tone: 'idle', text: 'draft', checks }

  const issues: [AzureTone, string][] = []
  const withState = (state: AzureTone) => checks.filter(c => c.state === state)

  if (pull.mergeStatus === 'conflicts') issues.push(['bad', 'merge conflict'])
  for (const c of withState('bad')) issues.push(['bad', `${c.name} failed`])
  for (const r of pull.reviewers.filter(r => r.vote === -10)) issues.push(['bad', `rejected by ${shortName(r.displayName)}`])
  for (const r of pull.reviewers.filter(r => r.vote === -5)) issues.push(['warn', `${shortName(r.displayName)} waits for you`])
  if (openComments > 0) issues.push(['warn', `${openComments} open comment${openComments === 1 ? '' : 's'}`])
  else if (withState('warn').some(c => c.name === COMMENTS)) issues.push(['warn', 'comments not resolved'])
  for (const c of withState('warn').filter(c => c.name !== COMMENTS)) issues.push(['warn', `${c.name} expired: queue it again`])
  for (const c of withState('running')) issues.push(['running', `${c.name} running`])
  const waiting = withState('waiting')
  if (waiting.length) issues.push(['waiting', `waits for ${waiting.map(c => c.name).join(' and ')}`])

  if (!issues.length) return { tone: 'ok', text: 'ready to complete', checks }
  const tone = SEVERITY.find(t => issues.some(([it]) => it === t)) ?? 'waiting'
  return { tone, text: issues.map(([, text]) => text).join(' · '), checks }
}

/** A pull request that waits for the person's vote: through whom, and what else is wrong with it. */
export function judgeReview(pull: PullRequest, evaluations: readonly PolicyEvaluation[], via: Reviewer, me: string): PullVerdict {
  const checks = checksOf(evaluations)
  const text = [
    via.id === me ? 'your vote' : `your vote, via ${shortName(via.displayName)}`,
    pull.mergeStatus === 'conflicts' ? 'merge conflict' : '',
    ...checks.filter(c => c.state === 'bad').map(c => `${c.name} failed`),
  ]
    .filter(Boolean)
    .join(' · ')
  return { tone: 'waiting', text, checks }
}

/**
 * The reviewer entry through which a pull request waits for the person: they, or a
 * team they are in, has not voted, and they did not write it or vote on it themselves.
 */
export function waitsForMe(pull: PullRequest, me: string, myTeams: ReadonlySet<string>): Reviewer | undefined {
  if (pull.isDraft || pull.createdBy.id === me) return undefined
  const own = pull.reviewers.find(r => r.id === me)
  if (own && own.vote !== 0) return undefined
  return pull.reviewers.find(
    r => (r.id === me || (r.isContainer === true && myTeams.has(r.id))) && r.vote === 0 && !r.hasDeclined,
  )
}

/** `[Project]\Team name` reads as `Team name`. */
export function shortName(displayName: string): string {
  return displayName.replace(/^\[[^\]]+\]\\/, '')
}
