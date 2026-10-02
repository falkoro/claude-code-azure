import type { HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { PolicyEvaluation, PullRequest, TimelineRecord } from './verdict'

/** The host calls the client needs. register.tsx builds it over `$`, which never crosses an import. */
export type Transport = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  now: () => Promise<number>
  patFromEnv: () => Promise<string | undefined>
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
}

export type AdoConfig = {
  organization: string
  /** Entra tenant for the az token; empty means the az CLI's current tenant. */
  tenant: string
}

/** An Azure DevOps call that did not answer with data. Status 0: no credential at all. */
export class AdoError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** The Azure DevOps application ID: an az token for it works against the REST API. */
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const AZ_TOKEN_MS = 40 * 60 * 1000

type Auth = { header: string; source: 'pat' | 'az'; expiresAt: number }

// The credential lives only in this module's memory: never in $.state, $.store or a log.
let auth: Auth | undefined
let isPatRejected = false

export const authSource = (): 'pat' | 'az' | 'none' => auth?.source ?? 'none'

/** Forget the credential, so the next call reads it again. */
export function resetAuth(): void {
  auth = undefined
  isPatRejected = false
}

/** AZURE_DEVOPS_EXT_PAT first (the variable the az devops extension reads), then an az login token. */
async function resolveAuth(t: Transport, config: AdoConfig, now: number): Promise<Auth | undefined> {
  if (auth && auth.expiresAt > now) return auth
  const pat = isPatRejected ? undefined : (await t.patFromEnv())?.trim()
  if (pat) return (auth = { header: `Basic ${btoa(`:${pat}`)}`, source: 'pat', expiresAt: Number.MAX_SAFE_INTEGER })

  const argv = ['az', 'account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv']
  if (config.tenant) argv.push('--tenant', config.tenant)
  const out = await t.run(argv, { timeoutMs: 20_000 }).catch(() => undefined)
  const token = out?.exitCode === 0 ? out.stdout.trim() : ''
  auth = token ? { header: `Bearer ${token}`, source: 'az', expiresAt: now + AZ_TOKEN_MS } : undefined
  return auth
}

/**
 * Calls the Azure DevOps REST API. 401, 403, and the sign-in page Azure DevOps
 * serves with 203 are auth failures; a rejected PAT falls back to an az token once.
 */
export async function ado(
  t: Transport,
  config: AdoConfig,
  path: string,
  init: { method?: string; body?: unknown; text?: boolean } = {},
): Promise<any> {
  const url = path.startsWith('https://') ? path : `https://dev.azure.com/${config.organization}/${path}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await resolveAuth(t, config, await t.now())
    if (!current) {
      throw new AdoError('no Azure DevOps credential: run az login, or set AZURE_DEVOPS_EXT_PAT', 0)
    }
    const hasBody = init.body !== undefined
    const res = await t.fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: current.header,
        Accept: init.text ? 'text/plain' : 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    })
    const text = res.text.replace(/^﻿/, '')
    if (res.status === 401 || res.status === 403 || res.status === 203 || (!init.text && /^\s*</.test(text))) {
      auth = undefined
      if (current.source === 'pat' && attempt === 0) {
        isPatRejected = true
        continue
      }
      throw new AdoError(`Azure DevOps refused the ${current.source} credential (HTTP ${res.status})`, res.status)
    }
    if (!res.ok) throw new AdoError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status)
    return init.text ? text : JSON.parse(text)
  }
  throw new AdoError('Azure DevOps refused every credential', 401)
}

const enc = encodeURIComponent
const V = 'api-version=7.1'

export type Build = {
  id: number
  buildNumber: string
  status: string
  result?: string | null
  queueTime: string
  finishTime?: string | null
  sourceBranch: string
  definition: { id: number; name: string }
  project: { id: string; name: string }
  requestedFor?: { id: string; displayName: string }
}

export type Approval = {
  id: string
  status: string
  instructions?: string
  createdOn: string
  permissions?: string
  pipeline?: { id: string; name: string; owner?: { id: number; name: string } }
}

export const getBuild = (t: Transport, c: AdoConfig, project: string, id: number): Promise<Build> =>
  ado(t, c, `${enc(project)}/_apis/build/builds/${id}?${V}`)

export const getTimeline = async (t: Transport, c: AdoConfig, project: string, id: number): Promise<TimelineRecord[]> =>
  (await ado(t, c, `${enc(project)}/_apis/build/builds/${id}/timeline?${V}`))?.records ?? []

export async function getLogTail(t: Transport, c: AdoConfig, project: string, id: number, logId: number, lines: number) {
  const text: string = await ado(t, c, `${enc(project)}/_apis/build/builds/${id}/logs/${logId}?${V}`, { text: true })
  return text.split(/\r?\n/).slice(-lines).join('\n')
}

export const listApprovals = async (t: Transport, c: AdoConfig, project: string): Promise<Approval[]> =>
  (await ado(t, c, `${enc(project)}/_apis/pipelines/approvals?state=pending&%24expand=steps,permissions&${V}`)).value ?? []

/** Sends the person's decision on one approval, and checks Azure DevOps recorded it. */
export async function decideApproval(
  t: Transport,
  c: AdoConfig,
  project: string,
  approvalId: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  const answer = await ado(t, c, `${enc(project)}/_apis/pipelines/approvals?${V}`, {
    method: 'PATCH',
    body: [{ approvalId, status }],
  })
  const recorded = (answer.value as { id: string; status: string }[] | undefined)?.find(a => a.id === approvalId)?.status
  if (recorded !== status) throw new AdoError(`Azure DevOps answered ${recorded ?? 'nothing'} for approval ${approvalId}`, 200)
}

export const myIdentity = async (t: Transport, c: AdoConfig): Promise<string> =>
  (await ado(t, c, '_apis/connectionData')).authenticatedUser?.id ?? ''

export const myRecentBuilds = async (t: Transport, c: AdoConfig, project: string, me: string, since: string): Promise<Build[]> =>
  (
    await ado(
      t,
      c,
      `${enc(project)}/_apis/build/builds?requestedFor=${enc(me)}&minTime=${enc(since)}&queryOrder=queueTimeDescending&%24top=5&${V}`,
    )
  ).value ?? []

/** Active pull requests across the organization; `criteria` narrows them. */
export const listActivePulls = async (t: Transport, c: AdoConfig, criteria = ''): Promise<PullRequest[]> =>
  (await ado(t, c, `_apis/git/pullrequests?searchCriteria.status=active${criteria && `&${criteria}`}&%24top=500&${V}`)).value ?? []

export async function getPolicyEvaluations(t: Transport, c: AdoConfig, projectId: string, pullId: number): Promise<PolicyEvaluation[]> {
  const artifact = enc(`vstfs:///CodeReview/CodeReviewId/${projectId}/${pullId}`)
  return (await ado(t, c, `${enc(projectId)}/_apis/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`)).value ?? []
}

/** Comment threads a person opened that are still active; system threads do not count. */
export async function countOpenThreads(t: Transport, c: AdoConfig, projectId: string, repoId: string, pullId: number) {
  const threads: { status?: string; isDeleted?: boolean; comments?: { commentType?: string }[] }[] =
    (await ado(t, c, `${enc(projectId)}/_apis/git/repositories/${enc(repoId)}/pullRequests/${pullId}/threads?${V}`)).value ?? []
  return threads.filter(th => th.status === 'active' && !th.isDeleted && th.comments?.[0]?.commentType !== 'system').length
}

const identities = (c: AdoConfig, query: string) => `https://vssps.dev.azure.com/${c.organization}/_apis/identities?${query}&${V}`

/** The descriptors of every group the person is in, nested groups included. */
export async function myGroupDescriptors(t: Transport, c: AdoConfig, me: string): Promise<Set<string>> {
  const list = await ado(t, c, identities(c, `identityIds=${enc(me)}&queryMembership=Expanded`))
  return new Set(((list.value?.[0]?.memberOf ?? []) as string[]).map(d => d.toLowerCase()))
}

/** The descriptor of each group id. */
export async function groupDescriptors(t: Transport, c: AdoConfig, ids: readonly string[]): Promise<Map<string, string>> {
  const list = await ado(t, c, identities(c, `identityIds=${ids.map(enc).join(',')}&queryMembership=None`))
  const items = (list.value ?? []) as ({ id: string; descriptor: string } | null)[]
  return new Map(items.flatMap(i => (i ? [[i.id, i.descriptor.toLowerCase()] as const] : [])))
}
