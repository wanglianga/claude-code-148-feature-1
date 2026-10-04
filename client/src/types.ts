// 与后端对应的数据类型
export interface User { id: number; username: string; role: 'nurse' | 'family' | 'doctor'; name: string; title: string; phone: string }

export interface Archive {
  id: number; family_user_id: number | null
  mother_name: string; baby_name: string; baby_gender: string
  birth_date: string; birth_weight: number; delivery_mode: string; feeding_type: string
  jaundice_risk: string; maternal_wound: string; address: string
  contact_name: string; contact_phone: string; discharge_date: string
  care_ability: string; notes: string; created_at: string
  pending_appts?: number; open_followups?: number; last_risk?: string | null
  last_bilirubin?: number | null; next_appt?: string | null
}

export interface Appointment {
  id: number; archive_id: number; nurse_id: number | null; type: string
  scheduled_time: string; status: string; reason: string
  mother_name?: string; baby_name?: string; address?: string
  contact_name?: string; contact_phone?: string; jaundice_risk?: string; nurse_name?: string
}

export interface Visit {
  id: number; client_id: string | null; appointment_id: number | null
  archive_id: number; nurse_id: number | null; visit_time: string
  weight: number | null; bilirubin: number | null; bilirubin_site: string
  device_code: string; doctor_advice: string
  cord: string; stool_count: number; stool_color: string; urine_count: number
  feeding_type: string; feeding_freq: number; spit_up: string; sleep: string
  breast: string; mood: string; wound_check: string; care_ability: string
  device_issue: number; photos: string[]; advice: string
  risk_level: string; flags: string[]
  need_recheck: number; need_referral: number; need_lactation: number; need_phone: number
  created_offline: number; created_at: string
}

export interface JaundicePlan {
  id: number; archive_id: number; visit_id: number
  choice: 'recheck' | 'clinic' | 'observe'
  risk_notice: string; risk_acknowledged: number; acknowledged_at: string | null
  due_date: string | null; recheck_task_id: number | null; created_by: string; created_at: string
  mother_name?: string; baby_name?: string
  visit?: Visit; recheckTask?: RecheckTask | null
}

export interface RecheckTask {
  id: number; archive_id: number; plan_id: number | null; visit_id: number | null
  appointment_id: number | null; nurse_id: number | null; device_code: string
  scheduled_time: string; prepare_reminded: number; prepare_note: string
  reschedule_count: number; status: string; escalation_note: string
  doctor_action: '' | 'phone_call' | 'direct_visit'; doctor_note: string; doctor_id: number | null
  created_at: string; updated_at: string
  nurse?: { id: number; name: string; title: string; phone: string } | null
  doctor?: { id: number; name: string; title: string; phone: string } | null
  archive?: { mother_name: string; baby_name: string; birth_date: string; address: string; contact_name: string; contact_phone: string }
  appointment?: Appointment | null
}

export interface Referral {
  id: number; archive_id: number; task_id: number | null
  current_visit_id: number; baseline_visit_id: number | null
  bilirubin_prev: number | null; bilirubin_current: number | null; delta: number | null
  trend_note: string; status: string; hospital_feedback: string
  created_at: string; closed_at: string | null; closed_by: string | null
  mother_name?: string; baby_name?: string; birth_date?: string
  address?: string; contact_name?: string; contact_phone?: string
  prev_nurse_name?: string; current_nurse_name?: string
  prev_site?: string; current_site?: string
  prev_feeding?: number; current_feeding?: number
  prev_stool?: number; prev_stool_color?: string; current_stool?: number; current_stool_color?: string
  prev_weight?: number; current_weight?: number
  prev_time?: string; current_time?: string
  prev_device?: string; current_device?: string
}

export interface Followup {
  id: number; archive_id: number; visit_id: number | null; type: string
  title: string; detail: string; status: string; due_date: string | null
  created_by: string; created_at: string; closed_at: string | null
  closed_by: string | null; close_note: string
  mother_name?: string; baby_name?: string; birth_date?: string
  address?: string; contact_name?: string; contact_phone?: string
}

export interface DocumentItem { id: number; type: string; filename: string; data_url?: string; note: string; created_at: string }
export interface Consult { id: number; question: string; status: string; reply: string; replied_by: string | null; created_at: string; replied_at: string | null }
export interface EventItem { id: number; kind: string; title: string; detail: string; actor: string; created_at: string }

export interface ArchiveDetail {
  archive: Archive; appointments: Appointment[]; visits: Visit[]
  followups: Followup[]
  jaundicePlan?: JaundicePlan | null; criticalVisit?: Visit | null
  recheckTasks?: RecheckTask[]; referrals?: Referral[]
  documents: DocumentItem[]; consults: Consult[]; events: EventItem[]
}

export interface Dashboard {
  stats: { unvisited: number; jaundiceAlerts: number; maternalRisks: number; openFollowups: number; todayAppointments: number; recheckTasks?: number; escalatedTasks?: number }
  followupsByType: Record<string, number>
  todayAppointments: Appointment[]
  recentHighRiskVisits: { id: number; visit_time: string; risk_level: string; bilirubin: number | null; weight: number | null; archive_id: number; mother_name: string; baby_name: string }[]
}

export interface FamilyOverview {
  archive: Archive; visits: Visit[]; followups: Followup[]
  nextAppointment: Appointment | null; appointments: Appointment[]
  jaundicePlan?: JaundicePlan | null; criticalVisit?: Visit | null
  recheckTasks?: RecheckTask[]; referrals?: Referral[]
  documents: DocumentItem[]; consults: Consult[]
}

// 访视表单载荷（也是离线草稿的内容）
export interface VisitPayload {
  client_id?: string
  appointment_id?: number | null
  archive_id: number
  visit_time: string
  weight?: number | null; bilirubin?: number | null; bilirubin_site?: string
  device_code?: string; doctor_advice?: string
  cord?: string; stool_count?: number; stool_color?: string; urine_count?: number
  feeding_type?: string; feeding_freq?: number; spit_up?: string; sleep?: string
  breast?: string; mood?: string; wound_check?: string; care_ability?: string
  device_issue?: boolean; photos?: string[]; advice?: string
}

export interface Assessment {
  riskLevel: string; flags: string[]; advice: string
  needRecheck: number; needReferral: number; needLactation: number; needPhone: number
  ageDays: number; threshold: number; weightLossPct: number | null
}
