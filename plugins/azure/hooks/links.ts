import type { AzureResource } from '../types'
import type { PullRequest } from './verdict'

/** A pipeline run, as a URL or an argument names it. */
export type RunRef = { organization: string; project: string; buildId: number }

const ORG_PROJECT = String.raw`https://dev\.azure\.com/([^/\s"'<>]+)/([^/\s"'<>?]+)`

// The shapes a run URL takes in az, REST and web output.
const RUN_URLS = [
  String.raw`/_build/results\?buildId=(\d+)`,
  String.raw`/_apis/build/[Bb]uilds/(\d+)`,
  String.raw`/_apis/pipelines/\d+/runs/(\d+)`,
].map(tail => new RegExp(ORG_PROJECT + tail, 'g'))

const RESOURCE_ID =
  /\/subscriptions\/([0-9a-fA-F-]{36})\/resourceGroups\/([^/\s"'`<>()[\]{},\\]+)((?:\/providers\/[^\s"'`<>()[\]{},\\]+)?)/gi

// Role assignments and the like have no useful portal blade.
const SKIPPED_NAMESPACE = /^microsoft\.authorization$/i

/** Every run a text links to, once each (a build id is unique within its organization). */
export function findRuns(text: string): RunRef[] {
  const found = new Map<string, RunRef>()
  for (const pattern of RUN_URLS) {
    for (const [, organization = '', project = '', id = ''] of text.matchAll(pattern)) {
      const ref = { organization, project: decodeURIComponent(project), buildId: Number(id) }
      found.set(runKey(ref), ref)
    }
  }
  return [...found.values()]
}

/** A run from its URL, or from a bare build id plus a project. */
export function parseRunArg(arg: string, organization: string, project: string | undefined): RunRef | undefined {
  const [fromUrl] = findRuns(arg)
  if (fromUrl) return fromUrl
  const id = /^\s*#?(\d+)\s*$/.exec(arg)?.[1]
  return id && project && organization ? { organization, project, buildId: Number(id) } : undefined
}

export const runKey = (ref: RunRef) => `${ref.organization}/${ref.buildId}`

export const runUrl = (ref: RunRef) =>
  `https://dev.azure.com/${ref.organization}/${encodeURIComponent(ref.project)}/_build/results?buildId=${ref.buildId}`

export const pullUrl = (organization: string, pull: PullRequest) =>
  `https://dev.azure.com/${organization}/${encodeURIComponent(pull.repository.project.name)}/_git/${encodeURIComponent(
    pull.repository.name,
  )}/pullrequest/${pull.pullRequestId}`

/** The portal link of a resource ID, in its tenant's directory when the tenant is known. */
export const portalUrl = (id: string, tenantId?: string) =>
  `https://portal.azure.com/#${tenantId ? `@${tenantId}/` : ''}resource${id}`

/**
 * The Azure resources a text names, once each. A deeper ID is cut back to the
 * resource and at most one child, and an extension resource links to its parent,
 * because the portal has blades only for those.
 */
export function findResources(text: string, tenantOf: (subscription: string) => string | undefined): AzureResource[] {
  const found = new Map<string, AzureResource>()
  for (const [, sub = '', rawGroup = '', providers = ''] of text.matchAll(RESOURCE_ID)) {
    const subscription = sub.toLowerCase()
    const group = trimTail(rawGroup)
    const all = trimTail(providers).split('/').filter(Boolean).slice(1) // drop the leading "providers"
    const ext = all.findIndex(s => s.toLowerCase() === 'providers')
    const segments = ext < 0 ? all : all.slice(0, ext)
    if (segments[0] && SKIPPED_NAMESPACE.test(segments[0])) continue
    // <namespace>/<type>/<name>[/<childType>/<childName>]
    const kept = segments.slice(0, segments.length >= 5 ? 5 : 3)
    if (kept.length !== 0 && kept.length !== 3 && kept.length !== 5) continue

    const groupId = `/subscriptions/${subscription}/resourceGroups/${group}`
    const id = kept.length ? `${groupId}/providers/${kept.join('/')}` : groupId
    if (found.has(id.toLowerCase())) continue
    found.set(id.toLowerCase(), {
      id,
      name: kept.length ? kept[kept.length - 1]! : group,
      type: kept.length ? [kept[0], kept[1], kept[3]].filter(Boolean).join('/') : 'resource group',
      url: portalUrl(id, tenantOf(subscription)),
    })
  }
  return [...found.values()]
}

/** `label=tenantId` pairs, comma-separated; anything that is not a GUID is dropped. */
export function parseTenants(text: string): { label: string; id: string }[] {
  return text
    .split(',')
    .map(pair => pair.split('=').map(s => s.trim()))
    .map(([label = '', id = '']) => ({ label, id: id.toLowerCase() }))
    .filter(t => t.label && /^[0-9a-f-]{36}$/.test(t.id))
}

const trimTail = (s: string) => s.replace(/[.:;]+$/, '')
