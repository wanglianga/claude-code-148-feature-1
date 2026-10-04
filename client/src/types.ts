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
  recheck_task_id?: number | null
  mother_name?: string; baby_name?: string; address?: string
  contact_name?: string; contact_phone?: string; jaundice_risk?: string; nurse_name?: string
  assign_nurse_name?: string; device_no?: string
}

export interface Visit {
  id: number; client_id: string | null; appointment_id: number | null
  archive_id: number; nurse_id: number | null; visit_time: string
  weight: number | null; bilirubin: number | null; bilirubin_site: string
  cord: string; stool_count: number; stool_color: string; urine_count: number
  feeding_type: string; feeding_freq: number; spit_up: string; sleep: string
  breast: string; mood: string; wound_check: string; care_ability: string
  device_issue: number; photos: string[]; advice: string
  risk_level: string; flags: string[]
  need_recheck: number; need_referral: number; need_lactation: number; need_phone: number
  device_no: string; doctor_advice: string
  created_offline: number; created_at: string
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

// 黄疸临界值复查任务
export interface RecheckTask {
  id: number; archive_id: number
  source_visit_id: number; recheck_visit_id: number | null; appointment_id: number | null
  family_choice: string; status: string
  assign_nurse_id: number | null; assign_nurse_name?: string
  device_no: string; remind_prepared: number; remind_at: string | null
  reschedule_count: number; escalated_at: string | null
  doctor_decision: string; doctor_note: string; risk_notice: string
  due_date: string | null; created_at: string; updated_at: string
  mother_name?: string; baby_name?: string; address?: string
  contact_name?: string; contact_phone?: string; birth_date?: string
  source_visit?: Visit
}

// 转诊单（含前后两次测量对比，方便医院判断变化趋势）
export interface Referral {
  id: number; archive_id: number; recheck_task_id: number | null
  previous_visit_id: number | null; current_visit_id: number | null; followup_id: number | null
  bilirubin_prev: number | null; bilirubin_site_prev: string
  bilirubin_now: number | null; bilirubin_site_now: string
  bilirubin_delta: number | null; threshold_now: number | null
  age_days_prev: number | null; age_days_now: number | null
  weight_prev: number | null; weight_now: number | null
  feeding_prev: string; feeding_now: string; trend_note: string
  status: string; created_by: string; created_at: string
  visited_at: string | null; hospital_feedback: string
  mother_name?: string; baby_name?: string
}

export interface ArchiveDetail {
  archive: Archive; appointments: Appointment[]; visits: Visit[]
  followups: Followup[]; documents: DocumentItem[]; consults: Consult[]; events: EventItem[]
  recheckTasks: RecheckTask[]; referrals: Referral[]
}

export interface Dashboard {
  stats: { unvisited: number; jaundiceAlerts: number; maternalRisks: number; openFollowups: number; todayAppointments: number; recheckPending: number; recheckEscalated: number; referralsPending: number }
  followupsByType: Record<string, number>
  todayAppointments: Appointment[]
  recentHighRiskVisits: { id: number; visit_time: string; risk_level: string; bilirubin: number | null; weight: number | null; archive_id: number; mother_name: string; baby_name: string }[]
}

export interface FamilyOverview {
  archive: Archive; visits: Visit[]; followups: Followup[]
  nextAppointment: Appointment | null; appointments: Appointment[]
  documents: DocumentItem[]; consults: Consult[]
  recheckTasks: RecheckTask[]; referrals: Referral[]
}

// 访视表单载荷（也是离线草稿的内容）
export interface VisitPayload {
  client_id?: string
  appointment_id?: number | null
  archive_id: number
  visit_time: string
  weight?: number | null; bilirubin?: number | null; bilirubin_site?: string
  cord?: string; stool_count?: number; stool_color?: string; urine_count?: number
  feeding_type?: string; feeding_freq?: number; spit_up?: string; sleep?: string
  breast?: string; mood?: string; wound_check?: string; care_ability?: string
  device_issue?: boolean; device_no?: string; doctor_advice?: string
  photos?: string[]; advice?: string
}

export interface Assessment {
  riskLevel: string; flags: string[]; advice: string
  nearJaundice: boolean
  needRecheck: number; needReferral: number; needLactation: number; needPhone: number
  ageDays: number; threshold: number; weightLossPct: number | null
}
