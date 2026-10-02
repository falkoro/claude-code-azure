import { expect, test } from 'claude-code/testing'

import { checksOf, judgeMine, judgeRun, waitsForMe } from '../hooks/verdict'
import type { PolicyEvaluation, PullRequest, Reviewer, TimelineRecord } from '../hooks/verdict'

const stage = (id: string, name: string, order: number, state: string, result: string | null): TimelineRecord => ({
  id, name, order, state, result, type: 'Stage', parentId: null,
})

test('a green run with skipped stages is a warning, never a plain success', () => {
  const v = judgeRun({ status: 'completed', result: 'succeeded' }, [
    stage('s1', 'Build', 1, 'completed', 'succeeded'),
    stage('s2', 'Deploy', 2, 'completed', 'skipped'),
  ])
  expect(v.tone).toBe('warn')
  expect(v.text).toBe('succeeded, but 1 of 2 stages skipped (Deploy): those ran nothing')
  expect(judgeRun({ status: 'completed', result: 'succeeded' }, [stage('s1', 'Deploy', 1, 'completed', 'skipped')]).text).toBe(
    'succeeded, but every stage was skipped: nothing ran',
  )
})

test('an approval checkpoint marks its stage as waiting', () => {
  const v = judgeRun({ status: 'inProgress' }, [
    stage('s1', 'Plan', 1, 'completed', 'succeeded'),
    stage('s2', 'Production', 2, 'pending', null),
    { id: 'c2', parentId: 's2', type: 'Checkpoint', name: 'Checkpoint', state: 'inProgress' },
    { id: 'a1', parentId: 'c2', type: 'Checkpoint.Approval', name: 'Checkpoint.Approval', state: 'inProgress' },
  ])
  expect(v.tone).toBe('waiting')
  expect(v.text).toBe('waiting for approval: Production')
  expect(v.stages.map(s => s.isWaiting)).toEqual([false, true])
})

test('a failed run names the stage, the task and the first error', () => {
  const v = judgeRun({ status: 'completed', result: 'failed' }, [
    stage('s1', 'Deploy', 1, 'completed', 'failed'),
    { id: 'j1', parentId: 's1', type: 'Job', name: 'deploy', state: 'completed', result: 'failed' },
    {
      id: 't1', parentId: 'j1', type: 'Task', name: 'Template deploy', order: 3, state: 'completed', result: 'failed',
      issues: [{ type: 'error', message: 'InvalidTemplate:\n  bad   property' }], log: { id: 9 },
    },
  ])
  expect(v.tone).toBe('bad')
  expect(v.text).toBe('failed at Deploy > Template deploy: InvalidTemplate: bad property')
  expect(v.failedTask?.log?.id).toBe(9)
})

const policy = (type: string, status: string, extra: Partial<PolicyEvaluation> = {}): PolicyEvaluation => ({
  status,
  configuration: { isBlocking: true, isEnabled: true, type: { displayName: type } },
  ...extra,
})

const pull = (reviewers: Reviewer[] = [], extra: Partial<PullRequest> = {}): PullRequest => ({
  pullRequestId: 7,
  title: 'Add a feature',
  isDraft: false,
  mergeStatus: 'succeeded',
  creationDate: '2026-01-01T06:00:00Z',
  createdBy: { id: 'me', displayName: 'Me' },
  reviewers,
  repository: { id: 'r1', name: 'repo', project: { id: 'p1', name: 'proj' } },
  ...extra,
})

const team = (id: string, vote = 0): Reviewer => ({ id, displayName: `[proj]\\${id}`, vote, isContainer: true })

test('policies of one kind fold into one check, the worst state wins, non-blocking ones drop', () => {
  expect(
    checksOf([
      policy('Comment requirements', 'approved'),
      policy('Comment requirements', 'queued'),
      policy('Minimum number of reviewers', 'approved'),
      policy('Build', 'approved', { context: { isExpired: true } }),
      policy('Work item linking', 'rejected', {
        configuration: { isBlocking: false, isEnabled: true, type: { displayName: 'Work item linking' } },
      }),
    ]),
  ).toEqual([
    { name: 'comments', state: 'waiting' },
    { name: 'reviewers', state: 'ok' },
    { name: 'build', state: 'warn' },
  ])
})

test('a blocked pull request names every blocker; a clean one is ready; a draft is a draft', () => {
  const v = judgeMine(
    pull([{ id: 'alex', displayName: 'Alex', vote: -5 }], { mergeStatus: 'conflicts' }),
    [policy('Build', 'rejected'), policy('Minimum number of reviewers', 'queued'), policy('Comment requirements', 'rejected')],
    2,
  )
  expect(v.tone).toBe('bad')
  expect(v.text).toBe('merge conflict · build failed · Alex waits for you · 2 open comments · waits for reviewers')
  const ok = [policy('Build', 'approved')]
  expect(judgeMine(pull(), ok, 0)).toMatchObject({ tone: 'ok', text: 'ready to complete' })
  expect(judgeMine(pull([], { isDraft: true }), ok, 3)).toMatchObject({ tone: 'idle', text: 'draft' })
})

test('a pull request waits for the vote of a team the person is in, until they vote', () => {
  const teams = new Set(['team'])
  const other = { createdBy: { id: 'sam', displayName: 'Sam' } }
  expect(waitsForMe(pull([team('team')], other), 'me', teams)?.id).toBe('team')
  expect(waitsForMe(pull([team('elsewhere')], other), 'me', teams)).toBeUndefined()
  expect(waitsForMe(pull([team('team', 10)], other), 'me', teams)).toBeUndefined()
  expect(waitsForMe(pull([team('team'), { id: 'me', displayName: 'Me', vote: 10 }], other), 'me', teams)).toBeUndefined()
  expect(waitsForMe(pull([team('team')]), 'me', teams)).toBeUndefined()
})
