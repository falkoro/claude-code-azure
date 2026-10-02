import type { Elements } from 'claude-code'

import type {
  AzureApproval,
  AzureConfirm,
  AzureHealth,
  AzurePull,
  AzureResource,
  AzureRun,
  AzureStage,
  AzureTone,
} from '../types'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link' | 'Markdown'>

// Colour carries the verdict and nothing else; every tone also has a glyph.
const COLOR: Record<AzureTone, string> = { ok: 'green', warn: 'yellow', bad: 'red', running: 'cyan', waiting: 'yellow', idle: 'gray' }
const GLYPH: Record<AzureTone, string> = { ok: '✓', warn: '!', bad: '✗', running: '●', waiting: '‖', idle: '·' }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function age(now: number, since: string): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`
}

function healthLine(kit: Kit, health: AzureHealth | null, utcOffsetMinutes: number, okSuffix: string, failPrefix = '') {
  const { Text } = kit
  if (!health) return <Text dimColor>reading…</Text>
  if (!health.isOk) return <Text color="red" wrap="wrap">{failPrefix}{health.text}</Text>
  const local = new Date(health.checkedAt + utcOffsetMinutes * 60_000).toISOString().slice(11, 16)
  return (
    <Text dimColor>
      read at {local} with {health.source === 'pat' ? 'your PAT' : 'your az sign-in'} · {okSuffix}
    </Text>
  )
}

// ---------- Pipelines tab ----------

export type PipelinesData = {
  organization: string
  runs: readonly AzureRun[]
  approvals: readonly AzureApproval[]
  resources: readonly AzureResource[]
  confirm: AzureConfirm
  sending: string | null
  health: AzureHealth | null
  now: number
  utcOffsetMinutes: number
}

export type PipelinesActions = {
  arm: (approvalId: string, action: 'approved' | 'rejected') => unknown
  cancel: () => unknown
  send: () => unknown
  clearFinished: () => unknown
}

function stageGlyph(stage: AzureStage): string {
  if (stage.isWaiting) return '‖'
  switch (stage.result) {
    case 'succeeded':
      return '✓'
    case 'succeededWithIssues':
    case 'partiallySucceeded':
      return '!'
    case 'failed':
      return '✗'
    case 'canceled':
      return '⊘'
    case 'skipped':
      return '–'
    default:
      return stage.state === 'inProgress' ? '●' : '·'
  }
}

export function drawPipelines(kit: Kit, d: PipelinesData, act: PipelinesActions) {
  const { Box, Text, Button, Link, Markdown } = kit
  const running = d.runs.filter(r => r.status !== 'completed' && r.tone !== 'waiting').length
  const failed = d.runs.filter(r => r.status === 'completed' && r.result === 'failed').length
  const parts = [
    d.approvals.length ? `${plural(d.approvals.length, 'approval')} wait${d.approvals.length === 1 ? 's' : ''} for you` : '',
    running ? `${plural(running, 'run')} in progress` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Azure DevOps · {d.organization || 'no organization'}</Text>
        {healthLine(kit, d.health, d.utcOffsetMinutes, 'approvals take two presses')}
        {parts.length ? (
          <Text bold color={d.approvals.length ? 'yellow' : failed ? 'red' : 'cyan'}>{parts.join(' · ')}</Text>
        ) : (
          <Text dimColor>Nothing waits for you.</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>Approvals for you ({d.approvals.length})</Text>
        {d.approvals.length === 0 && <Text dimColor>No approval waits for you.</Text>}
        {d.approvals.map(a => (
          <Box key={`approval:${a.id}`} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text bold wrap="truncate-end">{a.pipeline}</Text>
            <Text color="yellow" wrap="wrap">‖ {a.stage}</Text>
            <Text dimColor wrap="truncate-end">
              {a.run} · waits {age(d.now, a.createdOn)}
            </Text>
            {a.instructions !== '' && <Text dimColor wrap="wrap">{a.instructions}</Text>}
            {decision(kit, d, act, a)}
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>Runs ({d.runs.length})</Text>
          {d.runs.some(r => r.status === 'completed') && (
            <Button key="clear" label="Clear finished" plain dimColor onPress={act.clearFinished} />
          )}
        </Box>
        {d.runs.length === 0 && <Text dimColor>No run watched yet. Queue one, or run /runs watch with its URL.</Text>}
        {d.runs.map(r => (
          <Box key={`run:${r.key}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={COLOR[r.tone]}>{GLYPH[r.tone]}</Text>
              <Link href={r.url} label={r.pipeline} />
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">{[r.number, r.branch].filter(Boolean).join(' · ')}</Text>
            </Box>
            <Box flexDirection="row" gap={1} paddingLeft={2}>
              {r.stages.length > 0 && <Text>{r.stages.map(stageGlyph).join(' ')}</Text>}
              <Text color={COLOR[r.tone]} wrap="wrap">{r.verdict}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      {d.resources.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Resources in this session</Text>
          {d.resources.slice(0, 8).map(res => (
            <Box key={`resource:${res.id}`} flexDirection="row" gap={1}>
              <Markdown text={`[${res.name.replace(/([[\]\\])/g, '\\$1')}](${res.url})`} />
              <Text dimColor wrap="truncate-end">{res.type}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

/** Approve / Reject arms; the confirm row takes their place, so a double click lands on text. */
function decision(kit: Kit, d: PipelinesData, act: PipelinesActions, a: AzureApproval) {
  const { Box, Text, Button, Link } = kit
  if (d.sending === a.id) return <Text color="cyan">Sending to Azure DevOps…</Text>
  if (d.confirm?.approvalId === a.id) {
    const isApprove = d.confirm.action === 'approved'
    return (
      <Box flexDirection="column">
        <Text color={isApprove ? 'green' : 'red'} bold wrap="wrap">
          {isApprove ? 'Approve' : 'Reject'} "{a.stage}"?
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key={`confirm:${a.id}`} label={isApprove ? 'Yes, approve' : 'Yes, reject'} variant="primary" onPress={act.send} />
          <Button key={`cancel:${a.id}`} label="Cancel" onPress={act.cancel} />
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="row" gap={1}>
      <Button key={`approve:${a.id}`} label="Approve" onPress={() => act.arm(a.id, 'approved')} />
      <Button key={`reject:${a.id}`} label="Reject" onPress={() => act.arm(a.id, 'rejected')} />
      <Link href={a.url} label="Open run" />
    </Box>
  )
}

// ---------- Pull requests tab ----------

export type PullsData = {
  organization: string
  pulls: readonly AzurePull[]
  health: AzureHealth | null
  now: number
  utcOffsetMinutes: number
}

// Blocked first, then ready to complete, then what waits on others.
const MINE_ORDER: AzureTone[] = ['bad', 'warn', 'ok', 'running', 'waiting', 'idle']
const MAX_REVIEWS = 12

/** How many pull requests need the person: reviews, and their own that are blocked or ready. */
export const needsYou = (pulls: readonly AzurePull[]) =>
  pulls.filter(p => p.role === 'review' || (!p.isDraft && ['bad', 'warn', 'ok'].includes(p.tone))).length

export function drawPulls(kit: Kit, d: PullsData, refresh: () => unknown) {
  const { Box, Text, Button, Link } = kit
  const mine = d.pulls
    .filter(p => p.role === 'mine')
    .sort((a, b) => MINE_ORDER.indexOf(a.tone) - MINE_ORDER.indexOf(b.tone) || b.id - a.id)
  const reviews = d.pulls.filter(p => p.role === 'review').sort((a, b) => b.id - a.id)
  const isOk = d.health?.isOk === true
  const blocked = mine.filter(p => p.tone === 'bad' || p.tone === 'warn').length
  const ready = mine.filter(p => p.tone === 'ok').length
  const parts = [
    blocked ? `${blocked} blocked` : '',
    ready ? `${ready} ready to complete` : '',
    reviews.length ? `${reviews.length} wait${reviews.length === 1 ? 's' : ''} for your vote` : '',
  ].filter(Boolean)
  const color = mine.some(p => p.tone === 'bad') ? 'red' : blocked || reviews.length ? 'yellow' : 'green'
  const stale = d.pulls.length ? '. The lists are from an earlier read.' : ''

  const row = (p: AzurePull) => (
    <Box key={`pull:${p.key}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={COLOR[p.tone]}>{GLYPH[p.tone]}</Text>
        <Link href={p.url} label={p.title} />
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate-end">
          {[`${p.repository} !${p.id}`, p.role === 'review' ? p.author : '', age(d.now, p.createdOn)].filter(Boolean).join(' · ')}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1} paddingLeft={2}>
        {p.checks.length > 0 && <Text>{p.checks.map(c => GLYPH[c.state]).join(' ')}</Text>}
        <Text color={COLOR[p.tone]} wrap="wrap">{p.verdict}</Text>
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>Pull requests · {d.organization || 'no organization'}</Text>
          <Button key="refresh" label="Refresh" plain dimColor onPress={refresh} />
        </Box>
        {d.health && !d.health.isOk ? (
          <Text color="red" wrap="wrap">
            Could not read the pull requests: {d.health.text}
            {stale}
          </Text>
        ) : (
          healthLine(kit, d.health, d.utcOffsetMinutes, 'reviews come through your teams')
        )}
        {isOk && (parts.length ? <Text bold color={color}>{parts.join(' · ')}</Text> : <Text dimColor>Nothing waits for you.</Text>)}
      </Box>

      <Box flexDirection="column">
        <Text bold>Yours ({mine.length})</Text>
        {isOk && mine.length === 0 && <Text dimColor>You have no active pull request.</Text>}
        {mine.map(row)}
      </Box>

      <Box flexDirection="column">
        <Text bold>For your review ({reviews.length})</Text>
        {isOk && reviews.length === 0 && <Text dimColor>No pull request waits for your vote.</Text>}
        {reviews.slice(0, MAX_REVIEWS).map(row)}
        {reviews.length > MAX_REVIEWS && (
          <Link href={`https://dev.azure.com/${d.organization}/_pulls`} label={`${reviews.length - MAX_REVIEWS} more in Azure DevOps`} />
        )}
      </Box>
    </Box>
  )
}

// ---------- Buttons above the prompt ----------

export type BandItem = { key: string; label: string; chord?: string; isUrgent: boolean; open: () => unknown }

export function drawBand(kit: Pick<Kit, 'Box' | 'Text' | 'Button'>, items: readonly BandItem[]) {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="row" gap={2}>
      {items.map(item => (
        <Box key={`band-item:${item.key}`} flexDirection="row" gap={1}>
          <Button key={`band:${item.key}`} label={item.label} variant={item.isUrgent ? 'primary' : undefined} onPress={item.open} />
          {item.chord !== undefined && <Text dimColor>{item.chord}</Text>}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The chord bound to each command in a keybindings.json text: `"ctrl+x r": "command:prs"`
 * or the qualified `"command:<plugin>:prs"` both give `prs` → `ctrl+x r`.
 */
export function chordsOf(text: string, plugin: string): Map<string, string> {
  const chords = new Map<string, string>()
  let blocks: unknown
  try {
    blocks = (JSON.parse(text) as { bindings?: unknown }).bindings
  } catch {
    return chords
  }
  if (!Array.isArray(blocks)) return chords
  for (const block of blocks) {
    const bindings = (block as { bindings?: unknown })?.bindings
    if (typeof bindings !== 'object' || bindings === null) continue
    for (const [chord, action] of Object.entries(bindings)) {
      if (typeof action !== 'string' || !action.startsWith('command:')) continue
      const name = action.slice('command:'.length).replace(new RegExp(`^${plugin}:`), '')
      if (name && !chords.has(name)) chords.set(name, chord)
    }
  }
  return chords
}
