import { expect, test } from 'claude-code/testing'

import { findResources, findRuns, parseRunArg, parseTenants, portalUrl } from '../hooks/links'

const SUB = '11111111-2222-3333-4444-555555555555'
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const tenantOf = (s: string) => (s === SUB ? TENANT : undefined)

test('findRuns reads a run once from every URL shape', () => {
  const text = [
    'https://dev.azure.com/contoso/0f0f0f0f-0000-0000-0000-000000000000/_build/results?buildId=101',
    'https://dev.azure.com/contoso/0f0f0f0f-0000-0000-0000-000000000000/_apis/build/Builds/101',
    'https://dev.azure.com/contoso/web%20app/_apis/pipelines/12/runs/202',
  ].join('\n')
  expect(findRuns(text)).toEqual([
    { organization: 'contoso', project: '0f0f0f0f-0000-0000-0000-000000000000', buildId: 101 },
    { organization: 'contoso', project: 'web app', buildId: 202 },
  ])
})

test('a bare build id needs a project', () => {
  expect(parseRunArg('101', 'contoso', 'proj')).toEqual({ organization: 'contoso', project: 'proj', buildId: 101 })
  expect(parseRunArg('101', 'contoso', undefined)).toBeUndefined()
})

test('resources link in their tenant, cut back from deep and extension IDs', () => {
  const rg = `/subscriptions/${SUB}/resourceGroups/rg-app`
  const found = findResources(
    [
      `"id": "${rg}/providers/Microsoft.Network/networkSecurityGroups/nsg-a/securityRules/allow-443"`,
      `${rg}/providers/Microsoft.Web/sites/app-b/providers/Microsoft.Insights/diagnosticSettings/logs`,
    ].join('\n'),
    tenantOf,
  )
  expect(found.map(r => r.name)).toEqual(['allow-443', 'app-b'])
  expect(found[0]?.type).toBe('Microsoft.Network/networkSecurityGroups/securityRules')
  expect(found[1]?.url).toBe(`https://portal.azure.com/#@${TENANT}/resource${rg}/providers/Microsoft.Web/sites/app-b`)
})

test('role assignments are skipped; a resource group without a known tenant still links', () => {
  const other = '00000000-1111-2222-3333-444444444444'
  const found = findResources(
    `/subscriptions/${SUB}/resourceGroups/rg-a/providers/Microsoft.Authorization/roleAssignments/x\nscope: /subscriptions/${other}/resourcegroups/rg-b.`,
    tenantOf,
  )
  const id = `/subscriptions/${other}/resourceGroups/rg-b`
  expect(found).toEqual([{ id, name: 'rg-b', type: 'resource group', url: portalUrl(id) }])
})

test('parseTenants keeps only label=GUID pairs', () => {
  expect(parseTenants(`Prod=${TENANT}, Dev=not-a-guid,=${TENANT}`)).toEqual([{ label: 'Prod', id: TENANT }])
})
