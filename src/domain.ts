/**
 * Row types and column lists for database part 6 (supabase/006_money_decisions_procurement.sql).
 * Shared by the Money, Fees, Decisions, Procurement, Calendar, Deck and Review modules.
 * Numeric columns arrive from the API as numbers (or strings for very large values): read them with num().
 */

// ---- Constants (from Jainam's Project Studio tool) -----------------------------------------
export const ESTIMATE_CATEGORIES = [
  'Preliminary work and demolition', 'Civil and masonry work', 'Waterproofing', 'Flooring and skirting',
  'Wall finishes and cladding', 'False ceiling', 'Electrical work', 'Lighting fixtures', 'Plumbing and sanitaryware',
  'HVAC and air conditioning', 'Carpentry and modular furniture', 'Kitchen', 'Wardrobes and storage', 'Doors and hardware',
  'Glass and metalwork', 'Painting and surface finishes', 'Loose furniture', 'Appliances', 'Curtains and soft furnishings',
  'Decorative accessories and styling', 'Installation, transport, and handling', 'Other',
] as const

export const UNITS = ['sq. ft.', 'sq. m.', 'running ft.', 'running m.', 'cu. ft.', 'cu. m.', 'no.', 'set', 'lot', 'kg', 'lump sum'] as const

export const TYPOLOGIES = ['residential', 'commercial', 'hospitality', 'office', 'retail', 'institutional', 'other'] as const

/** The four fee stages used in fee proposals. */
export const FEE_STAGES = [
  'Stage 1 · Initial Consultation & Concept Development',
  'Stage 2 · Schematic Design & Visualization',
  'Stage 3 · Design Development & Working Drawings',
  'Stage 4 · Execution, Installation & Handover',
] as const

export const COST_CATEGORIES = ['Consultant', 'Travel', 'Printing', 'Site visit', 'Samples', 'Other'] as const
export const VENDOR_KINDS = ['agency', 'supplier', 'consultant'] as const

export const RA_STEPS = ['submitted', 'measured', 'certified', 'client_approved', 'paid'] as const
export const RA_STEP_LABEL: Record<RaStatus, string> = {
  submitted: 'Submitted', measured: 'Measured', certified: 'Certified', client_approved: 'Client approved', paid: 'Paid',
}
export const QUOTE_STATUSES = ['received', 'compared', 'accepted', 'rejected'] as const
export const VARIATION_STEPS = ['proposed', 'costed', 'client_approved', 'executed', 'billed'] as const
export const DECISION_KINDS = ['rfi', 'approval', 'site_instruction', 'revision'] as const
export const DECISION_KIND_LABEL: Record<DecisionKind, string> = { rfi: 'RFI', approval: 'Approval', site_instruction: 'Site instruction', revision: 'Design revision' }
export const DECISION_STEPS = ['open', 'answered', 'confirmed', 'closed'] as const
export const PROCUREMENT_STEPS = ['specified', 'approved', 'ordered', 'on_site'] as const
export const PROCUREMENT_STEP_LABEL: Record<ProcurementStatus, string> = { specified: 'Specified', approved: 'Approved', ordered: 'Ordered', on_site: 'On site' }

/** Thresholds from the planning decisions (handover section 2). */
export const OVERRUN_PCT = 5
export const RA_UNPAID_DAYS = 7
export const FEE_REMINDER_DAYS = [3, 10] as const
export const ORDER_WARNING_DAYS = 7

export type RaStatus = (typeof RA_STEPS)[number]
export type DecisionKind = (typeof DECISION_KINDS)[number]
export type DecisionStatus = (typeof DECISION_STEPS)[number]
export type ProcurementStatus = (typeof PROCUREMENT_STEPS)[number]

// ---- Rows ----------------------------------------------------------------------------------
type Removable = { removed_at: string | null }

export type Vendor = {
  id: string; name: string; kind: (typeof VENDOR_KINDS)[number]; trade: string | null; contact_name: string | null
  phone: string | null; email: string | null; gstin: string | null; notes: string; archived: boolean
}
export const VENDOR_SELECT = 'id, name, kind, trade, contact_name, phone, email, gstin, notes, archived'

export type ProjectBrief = {
  project_id: string; client_name: string | null; client_phone: string | null; client_email: string | null
  site_address: string | null; city: string | null; typology: (typeof TYPOLOGIES)[number]; area: number | null
  area_unit: 'sq. ft.' | 'sq. m.'; issue_date: string | null; agreement_date: string | null; start_date: string | null
  end_date: string | null; duration_months: number | null; client_budget: number | null; budget_includes_gst: boolean
  estimate_gst_rate: number; contingency_pct: number; estimate_pdf: Record<string, boolean>
}
export const BRIEF_SELECT =
  'project_id, client_name, client_phone, client_email, site_address, city, typology, area, area_unit, issue_date, agreement_date, ' +
  'start_date, end_date, duration_months, client_budget, budget_includes_gst, estimate_gst_rate, contingency_pct, estimate_pdf'

export type BoqItem = Removable & {
  id: string; project_id: string; category: string; trade: string | null; room: string | null; item: string; unit: string
  quantity: number; rate: number; wastage_pct: number; rate_source: string; verified: boolean; optional: boolean
  work_order_id: string | null; committed_rate: number | null; sort_order: number
}
export const BOQ_SELECT =
  'id, project_id, category, trade, room, item, unit, quantity, rate, wastage_pct, rate_source, verified, optional, ' +
  'work_order_id, committed_rate, sort_order, removed_at'

export type Quote = Removable & {
  id: string; project_id: string; vendor_id: string; trade: string | null; amount: number; received_on: string
  status: (typeof QUOTE_STATUSES)[number]; note: string; file_link: string | null
}
export const QUOTE_SELECT = 'id, project_id, vendor_id, trade, amount, received_on, status, note, file_link, removed_at'

export type WorkOrder = Removable & {
  id: string; project_id: string; vendor_id: string; quote_id: string | null; trade: string | null; amount: number
  issued_on: string; note: string; file_link: string | null
}
export const WORK_ORDER_SELECT = 'id, project_id, vendor_id, quote_id, trade, amount, issued_on, note, file_link, removed_at'

export type RaBill = Removable & {
  id: string; project_id: string; vendor_id: string; work_order_id: string | null; bill_no: string; bill_date: string
  claimed_amount: number; certified_amount: number | null; gst_rate: number; status: RaStatus; certified_on: string | null
  client_approved_on: string | null; paid_on: string | null; paid_amount: number | null; note: string; file_link: string | null
}
export const RA_BILL_SELECT =
  'id, project_id, vendor_id, work_order_id, bill_no, bill_date, claimed_amount, certified_amount, gst_rate, status, ' +
  'certified_on, client_approved_on, paid_on, paid_amount, note, file_link, removed_at'

export type RaBillLine = { id: string; bill_id: string; boq_item_id: string; claimed_qty: number; certified_qty: number | null; rate: number | null }
export const RA_LINE_SELECT = 'id, bill_id, boq_item_id, claimed_qty, certified_qty, rate'

export type ProjectFee = { project_id: string; fee_amount: number; gst_rate: number; payment_terms_days: number }
export const FEE_SELECT = 'project_id, fee_amount, gst_rate, payment_terms_days'

export type FeeProposal = {
  project_id: string; method: 'fixed' | 'percent' | 'per_sqft'; fixed_fee: number | null; percent: number | null
  rate_psf: number | null; stage_pct: number[]; stage_override: (number | null)[]; milestones: { name: string; pct: number }[]
  legal_reviewed: boolean
}
export const PROPOSAL_SELECT = 'project_id, method, fixed_fee, percent, rate_psf, stage_pct, stage_override, milestones, legal_reviewed'

export type FeeInvoice = Removable & {
  id: string; project_id: string; milestone: string; task_id: string | null; amount: number; gst_rate: number
  due_date: string | null; status: 'scheduled' | 'raised' | 'paid'; invoice_no: string | null; raised_on: string | null
  paid_on: string | null; paid_amount: number | null; note: string; sort_order: number
}
export const INVOICE_SELECT =
  'id, project_id, milestone, task_id, amount, gst_rate, due_date, status, invoice_no, raised_on, paid_on, paid_amount, note, sort_order, removed_at'

export type StudioCost = Removable & {
  id: string; project_id: string; spent_on: string; category: (typeof COST_CATEGORIES)[number]; vendor_id: string | null
  amount: number; status: 'planned' | 'paid'; note: string
}
export const COST_SELECT = 'id, project_id, spent_on, category, vendor_id, amount, status, note, removed_at'

export type StudioSettings = {
  id: 1; name: string; tagline: string; website: string; email: string; phone: string; gstin: string
  logo_path: string | null; clauses: Record<string, string>
}
export const SETTINGS_SELECT = 'id, name, tagline, website, email, phone, gstin, logo_path, clauses'

export type Decision = Removable & {
  id: string; project_id: string; kind: DecisionKind; approval_kind: 'client' | 'material' | null; question: string
  answer: string; raised_by: string | null; revision_round: number | null; need_by: string | null; blocks: string
  decided_by: string | null; decided_on: string | null; status: DecisionStatus; cost_impact: number | null
  drawing_id: string | null; boq_item_id: string | null; task_id: string | null; source_log_id: string | null; created_at: string
}
export const DECISION_SELECT =
  'id, project_id, kind, approval_kind, question, answer, raised_by, revision_round, need_by, blocks, decided_by, decided_on, ' +
  'status, cost_impact, drawing_id, boq_item_id, task_id, source_log_id, created_at, removed_at'

export type Variation = Removable & {
  id: string; project_id: string; decision_id: string | null; boq_item_id: string | null; description: string
  amount: number; status: (typeof VARIATION_STEPS)[number]; client_approved_on: string | null
}
export const VARIATION_SELECT = 'id, project_id, decision_id, boq_item_id, description, amount, status, client_approved_on, removed_at'

export type ProcurementItem = Removable & {
  id: string; project_id: string; item: string; trade: string | null; room: string | null; task_id: string | null
  need_by: string | null; lead_days: number; vendor_id: string | null; spec_approved: boolean; status: ProcurementStatus
  ordered_on: string | null; expected_on: string | null; delivered_on: string | null; note: string
}
export const PROCUREMENT_SELECT =
  'id, project_id, item, trade, room, task_id, need_by, lead_days, vendor_id, spec_approved, status, ordered_on, expected_on, delivered_on, note, removed_at'

export type SiteVisit = Removable & { id: string; project_id: string; visit_on: string; visit_time: string | null; purpose: string }
export const VISIT_SELECT = 'id, project_id, visit_on, visit_time, purpose, removed_at'

export type DeckSlide = { kind: 'asbuilt' | 'keyplan' | 'room' | 'thanks'; title: string; slots: Record<string, string> }
export type ProjectDeck = { project_id: string; slides: DeckSlide[]; key_plan_path: string | null }
export const DECK_SELECT = 'project_id, slides, key_plan_path'
