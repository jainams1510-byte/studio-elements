/**
 * Stage templates: the tasks a new schedule starts with.
 * Durations are working days and are starting placeholders only: correct them on the first project.
 * Each stage ends in a milestone (its exit gate); the next stage starts after that gate.
 */

export type TemplateTask = {
  key: string
  stage: number
  name: string
  duration: number
  after: string[]
  trade?: string
  milestone?: boolean
}

const gate = (key: string, stage: number, name: string, after: string[]): TemplateTask => ({
  key,
  stage,
  name,
  duration: 0,
  after,
  milestone: true,
})

export const TEMPLATE: TemplateTask[] = [
  // 1 Concept
  { key: 'brief', stage: 1, name: 'Brief', duration: 2, after: [] },
  { key: 'measure', stage: 1, name: 'Site measure', duration: 1, after: ['brief'] },
  { key: 'layouts', stage: 1, name: 'Layouts', duration: 5, after: ['measure'] },
  { key: 'mood', stage: 1, name: 'Mood board', duration: 3, after: ['brief'] },
  gate('g1', 1, 'Client approves layout', ['layouts', 'mood']),
  // 2 Design development
  { key: 'elevations', stage: 2, name: 'Elevations', duration: 6, after: ['g1'] },
  { key: '3d', stage: 2, name: '3D views', duration: 6, after: ['g1'] },
  { key: 'materials', stage: 2, name: 'Material selection', duration: 4, after: ['g1'] },
  { key: 'estimate', stage: 2, name: 'Estimate', duration: 3, after: ['materials', 'elevations'] },
  gate('g2', 2, 'Design freeze signed', ['elevations', '3d', 'estimate']),
  // 3 Working drawings
  { key: 'wd-el', stage: 3, name: 'Electrical drawings', duration: 4, after: ['g2'] },
  { key: 'wd-rcp', stage: 3, name: 'Ceiling (RCP) drawings', duration: 3, after: ['g2'] },
  { key: 'wd-hvac', stage: 3, name: 'HVAC drawings', duration: 2, after: ['g2'] },
  { key: 'wd-pl', stage: 3, name: 'Plumbing drawings', duration: 3, after: ['g2'] },
  { key: 'wd-jo', stage: 3, name: 'Joinery drawings', duration: 8, after: ['g2'] },
  { key: 'wd-ti', stage: 3, name: 'Tiling drawings', duration: 3, after: ['g2'] },
  gate('g3', 3, 'All sheets at R0', ['wd-el', 'wd-rcp', 'wd-hvac', 'wd-pl', 'wd-jo', 'wd-ti']),
  // 4 BOQ and tendering
  { key: 'boq', stage: 4, name: 'BOQ per trade', duration: 5, after: ['g3'] },
  { key: 'quotes', stage: 4, name: 'Quotes from agencies', duration: 10, after: ['boq'] },
  { key: 'compare', stage: 4, name: 'Quote comparison', duration: 3, after: ['quotes'] },
  gate('g4', 4, 'Work orders issued', ['compare']),
  // 5 Procurement
  { key: 'longlead', stage: 5, name: 'Long-lead list', duration: 2, after: ['boq'] },
  { key: 'samples', stage: 5, name: 'Samples approved', duration: 5, after: ['longlead'] },
  { key: 'orders', stage: 5, name: 'Orders placed', duration: 5, after: ['samples', 'g4'] },
  gate('g5', 5, 'Long-lead items ordered', ['orders']),
  // 6 Execution
  { key: 'civil', stage: 6, name: 'Civil work', duration: 15, after: ['g4'], trade: 'Civil' },
  { key: 'rough', stage: 6, name: 'Electrical and plumbing rough-ins', duration: 10, after: ['civil'], trade: 'Electrical' },
  { key: 'ceiling', stage: 6, name: 'False ceiling', duration: 8, after: ['rough'], trade: 'False ceiling' },
  { key: 'tiling', stage: 6, name: 'Tiling', duration: 10, after: ['rough'], trade: 'Tiling' },
  { key: 'carpentry', stage: 6, name: 'Carpentry', duration: 25, after: ['rough', 'g5'], trade: 'Carpentry' },
  { key: 'paint', stage: 6, name: 'Paint', duration: 8, after: ['ceiling', 'carpentry'] },
  { key: 'fixtures', stage: 6, name: 'Fixtures and fittings', duration: 5, after: ['paint', 'tiling'] },
  gate('g6', 6, 'Trades done, bills certified', ['fixtures']),
  // 7 Snagging
  { key: 'snags', stage: 7, name: 'Snag list by room', duration: 2, after: ['g6'] },
  { key: 'rectify', stage: 7, name: 'Rectification', duration: 7, after: ['snags'] },
  gate('g7', 7, 'Zero open snags', ['rectify']),
  // 8 Handover
  { key: 'finalbills', stage: 8, name: 'Final bills', duration: 5, after: ['g7'] },
  { key: 'asbuilt', stage: 8, name: 'As-built set', duration: 5, after: ['g7'] },
  { key: 'warranties', stage: 8, name: 'Warranties', duration: 2, after: ['g7'] },
  { key: 'feeinvoice', stage: 8, name: 'Final fee invoice', duration: 1, after: ['finalbills'] },
  gate('g8', 8, 'Client sign-off', ['finalbills', 'asbuilt', 'warranties', 'feeinvoice']),
]

export type NewTaskRow = {
  id: string
  project_id: string
  stage: number
  name: string
  trade: string | null
  duration: number
  milestone: boolean
  after_ids: string[]
  sort_order: number
  template_key: string
}

/**
 * Rows for a new schedule, from the given stage onward. Links to tasks of earlier stages are dropped,
 * so the first tasks start on the schedule's start date.
 */
export function templateRows(projectId: string, fromStage: number, newId: () => string = () => crypto.randomUUID()): NewTaskRow[] {
  const chosen = TEMPLATE.filter((t) => t.stage >= fromStage)
  const ids = new Map(chosen.map((t) => [t.key, newId()]))
  return chosen.map((t, i) => ({
    id: ids.get(t.key)!,
    project_id: projectId,
    stage: t.stage,
    name: t.name,
    trade: t.trade ?? null,
    duration: t.duration,
    milestone: Boolean(t.milestone),
    after_ids: t.after.filter((k) => ids.has(k)).map((k) => ids.get(k)!),
    sort_order: i,
    template_key: t.key,
  }))
}
