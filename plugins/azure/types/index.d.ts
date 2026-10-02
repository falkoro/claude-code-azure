/** How a run, stage, check or pull request reads at a glance. The panes colour by it. */
export type AzureTone = 'ok' | 'warn' | 'bad' | 'running' | 'waiting' | 'idle'

/** One stage of a run, from the build timeline. */
export type AzureStage = {
  name: string
  /** pending, inProgress or completed */
  state: string
  /** succeeded, succeededWithIssues, failed, canceled, skipped, or null while it runs */
  result: string | null
  /** An approval or check holds the stage. */
  isWaiting: boolean
}

/** A run the Pipelines tab watches. */
export type AzureRun = {
  key: string
  organization: string
  /** The project as the run reference named it: a name or an id. */
  project: string
  projectName: string
  buildId: number
  pipeline: string
  number: string
  branch: string
  status: string
  result: string | null
  stages: AzureStage[]
  tone: AzureTone
  verdict: string
  url: string
  /** Submit a prompt to the session when the run finishes or waits on an approval. */
  wake: boolean
  /** The finish was announced. */
  isAnnounced: boolean
  /** The current approval wait was announced. */
  isWaitAnnounced: boolean
  queuedAt: string
  finishedAt: string | null
}

/** A pending approval the signed-in identity may decide. */
export type AzureApproval = {
  id: string
  organization: string
  project: string
  buildId: number
  pipeline: string
  run: string
  stage: string
  instructions: string
  createdOn: string
  url: string
}

/** An Azure resource a tool result named, with its portal link. */
export type AzureResource = { id: string; name: string; type: string; url: string }

/** The approval a first press armed; the second press sends it. */
export type AzureConfirm = { approvalId: string; action: 'approved' | 'rejected' } | null

/** One blocking policy of a pull request, folded per kind. */
export type AzureCheck = { name: string; state: AzureTone }

/** An active pull request: one the person wrote, or one that waits for their vote. */
export type AzurePull = {
  key: string
  id: number
  role: 'mine' | 'review'
  project: string
  repository: string
  title: string
  author: string
  createdOn: string
  isDraft: boolean
  checks: AzureCheck[]
  openComments: number
  tone: AzureTone
  verdict: string
  url: string
}

/** The last Azure DevOps read: did it work, and with which credential. */
export type AzureHealth = { isOk: boolean; text: string; source: 'pat' | 'az' | 'none'; checkedAt: number }

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__azure__pipeline_status': { run: string; project?: string; logLines?: number }
    'mcp__azure__pipeline_watch': { run: string; project?: string; wake?: boolean }
    'mcp__azure__pipeline_approvals': {}
    'mcp__azure__pull_requests': {}
  }

  interface PluginState {
    azure: {
      runs: AzureRun[]
      approvals: AzureApproval[]
      resources: AzureResource[]
      pulls: AzurePull[]
      /** The last pull request read; null until the first. */
      pullsHealth: AzureHealth | null
      confirm: AzureConfirm
      sending: string | null
      health: AzureHealth | null
    }
  }
}
