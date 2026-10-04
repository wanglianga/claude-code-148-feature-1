// 访视落库与随访闭环的领域服务：种子数据与 HTTP 路由共用，保证行为一致
import db, { addEvent } from './db.js'
import { assessVisit } from './risk.js'

const VISIT_COLS = ['client_id','appointment_id','archive_id','nurse_id','visit_time','weight','bilirubin',
  'bilirubin_site','device_code','doctor_advice','cord','stool_count','stool_color','urine_count','feeding_type','feeding_freq','spit_up',
  'sleep','breast','mood','wound_check','care_ability','device_issue','photos','advice','risk_level','flags',
  'need_recheck','need_referral','need_lactation','need_phone','created_offline']

function openFollowup(archiveId, type, title, detail, dueDate, visitId, createdBy = '系统') {
  db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, due_date, created_by)
              VALUES (?,?,?,?,?,?,?)`).run(archiveId, visitId ?? null, type, title, detail, dueDate, createdBy)
  addEvent(archiveId, type, title, detail, createdBy)
}

export function closeFollowup(id, closedBy, note = '') {
  const f = db.prepare('SELECT * FROM followups WHERE id=?').get(id)
  if (!f) return null
  if (f.status !== '已闭环') {
    db.prepare(`UPDATE followups SET status='已闭环', closed_at=datetime('now','localtime'),
                closed_by=?, close_note=? WHERE id=?`).run(closedBy, note, id)
    addEvent(f.archive_id, '闭环', `【${f.type}】${f.title} 已闭环`, note, closedBy)
  }
  return db.prepare('SELECT * FROM followups WHERE id=?').get(id)
}

/** 提交一次访视：风险评估 → 落库 → 更新预约 → 生成/闭环随访事项 → 写时间线 */
export function createVisit(payload, nurse) {
  const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(payload.archive_id)
  if (!archive) throw Object.assign(new Error('母婴档案不存在'), { status: 404 })
  const nurseName = nurse?.name || '系统'

  // 幂等：离线草稿补录带 client_id，重复提交返回已有记录
  if (payload.client_id) {
    const dup = db.prepare('SELECT * FROM visits WHERE client_id=?').get(payload.client_id)
    if (dup) return { visit: dup, duplicated: true, assessment: JSON.parse(dup.flags) }
  }

  const v = {
    client_id: payload.client_id || null,
    appointment_id: payload.appointment_id || null,
    archive_id: archive.id,
    nurse_id: nurse?.id || payload.nurse_id || null,
    visit_time: payload.visit_time || new Date().toISOString().slice(0, 16),
    weight: num(payload.weight), bilirubin: num(payload.bilirubin),
    bilirubin_site: payload.bilirubin_site || '额头',
    device_code: String(payload.device_code || '').trim(),
    doctor_advice: String(payload.doctor_advice || '').trim(),
    cord: payload.cord || '干燥',
    stool_count: int(payload.stool_count), stool_color: payload.stool_color || '黄色',
    urine_count: int(payload.urine_count),
    feeding_type: payload.feeding_type || archive.feeding_type,
    feeding_freq: int(payload.feeding_freq),
    spit_up: payload.spit_up || '无', sleep: payload.sleep || '正常',
    breast: payload.breast || '正常', mood: payload.mood || '平稳',
    wound_check: payload.wound_check || archive.maternal_wound || '愈合良好',
    care_ability: payload.care_ability || archive.care_ability || '良好',
    device_issue: payload.device_issue ? 1 : 0,
    photos: JSON.stringify(payload.photos || []),
    created_offline: payload.created_offline ? 1 : 0,
  }
  const r = assessVisit(archive, v)
  v.risk_level = r.riskLevel
  v.flags = JSON.stringify(r.flags)
  v.need_recheck = r.needRecheck; v.need_referral = r.needReferral
  v.need_lactation = r.needLactation; v.need_phone = r.needPhone
  v.advice = (payload.advice && payload.advice.trim()) || r.advice

  const cols = VISIT_COLS.join(',')
  const marks = VISIT_COLS.map(() => '?').join(',')
  const info = db.prepare(`INSERT INTO visits (${cols}) VALUES (${marks})`)
    .run(...VISIT_COLS.map(c => v[c]))
  const visitId = info.lastInsertRowid

  // 预约状态联动
  if (v.appointment_id) {
    db.prepare(`UPDATE appointments SET status='已完成', updated_at=datetime('now','localtime') WHERE id=?`)
      .run(v.appointment_id)
  }

  // 临界值复测任务：本次上门完成复测 → 比对前一天记录，升高则把前一天记录带入转诊单
  const task = v.appointment_id
    ? db.prepare(`SELECT * FROM recheck_tasks WHERE appointment_id=? AND status!='已完成' AND status!='已取消'`).get(v.appointment_id)
    : null
  if (task) {
    const baseline = task.visit_id ? db.prepare('SELECT * FROM visits WHERE id=?').get(task.visit_id) : null
    db.prepare(`UPDATE recheck_tasks SET status='已完成', updated_at=datetime('now','localtime') WHERE id=?`).run(task.id)
    addEvent(archive.id, '复查', `黄疸复测已完成（护士 ${nurseName}，设备 ${v.device_code || task.device_code || '未登记'}）`,
      baseline ? `复测黄疸 ${v.bilirubin ?? '-'} µmol/L，前一天 ${baseline.bilirubin ?? '-'} µmol/L` : '', nurseName)
    const raised = baseline && v.bilirubin != null && baseline.bilirubin != null && Number(v.bilirubin) > Number(baseline.bilirubin)
    if (raised) {
      const delta = Math.round((Number(v.bilirubin) - Number(baseline.bilirubin)) * 10) / 10
      const trendNote = `黄疸较前一天升高 ${delta} µmol/L（${baseline.bilirubin} → ${v.bilirubin}，部位 ${baseline.bilirubin_site} → ${v.bilirubin_site}）`
      const info = db.prepare(`INSERT INTO referrals
        (archive_id, task_id, current_visit_id, baseline_visit_id, bilirubin_prev, bilirubin_current, delta, trend_note)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(archive.id, task.id, visitId, baseline.id, baseline.bilirubin, v.bilirubin, delta, trendNote)
      openFollowup(archive.id, '转诊', '复测黄疸升高，转诊儿科评估',
        `${trendNote}。前一天记录已带入转诊单 #${info.lastInsertRowid}，供医院判断变化趋势。`, null, visitId, nurseName)
      addEvent(archive.id, '转诊', '复测黄疸升高，生成转诊单（含前一天记录）',
        `${trendNote}；前一天喂养 ${baseline.feeding_freq} 次/日、大便 ${baseline.stool_count} 次（${baseline.stool_color}）、体重 ${baseline.weight ?? '-'} g`, nurseName)
    } else if (baseline) {
      addEvent(archive.id, '复查', '复测黄疸未升高',
        `${baseline.bilirubin ?? '-'} → ${v.bilirubin ?? '-'} µmol/L，继续按护理建议观察`, nurseName)
    }
    // 复测完成 → 闭环该任务对应的开放复查事项与计划
    for (const f of db.prepare(`SELECT * FROM followups WHERE archive_id=? AND status!='已闭环' AND type='复查'`).all(archive.id)) {
      closeFollowup(f.id, nurseName, raised ? '复测升高，已转转诊单' : `复测已完成（${v.bilirubin ?? '-'} µmol/L），未升高`)
    }
  }

  // 本次访视即完成了此前开放的“复查/再次预约”事项 → 自动闭环
  const doneTypes = ['复查', '再次预约']
  for (const f of db.prepare(`SELECT * FROM followups WHERE archive_id=? AND status!='已闭环'`).all(archive.id)) {
    if (doneTypes.includes(f.type)) closeFollowup(f.id, nurse?.name || '系统', `访视 #${visitId} 已完成`)
  }

  // 生成新的随访事项
  const summary = `黄疸 ${v.bilirubin ?? '-'} µmol/L（第 ${r.ageDays} 天，阈值 ${r.threshold}），体重 ${v.weight ?? '-'} g` +
    (r.weightLossPct != null ? `（较出生 ${r.weightLossPct}%）` : '') + `，喂养 ${v.feeding_freq} 次/日`
  if (v.need_referral) {
    openFollowup(archive.id, '转诊', '转诊儿科评估', summary + '。' + r.flags.join('；'),
      null, visitId, nurseName)
  }
  if (v.need_recheck) {
    const due = plusDays(v.visit_time, 1)
    openFollowup(archive.id, '复查', '黄疸/体重复查', summary + '。建议 24~48 小时内复查。',
      due, visitId, nurseName)
    db.prepare(`INSERT INTO appointments (archive_id, nurse_id, type, scheduled_time, status, reason)
                VALUES (?,?,?,?, '待访视', '系统按风险自动生成')`)
      .run(archive.id, v.nurse_id, '复查', `${due} 09:00:00`)
  }
  if (v.need_lactation) openFollowup(archive.id, '母乳指导', '安排母乳喂养指导', summary, null, visitId, nurseName)
  if (v.need_phone) openFollowup(archive.id, '电话随访', '电话随访（产妇情绪/家庭照护）', summary, null, visitId, nurseName)

  addEvent(archive.id, '访视', `完成访视（风险：${v.risk_level}）`,
    summary + (v.device_issue ? '。【设备故障，手工记录】' : '') + (v.created_offline ? '。【离线草稿补录同步】' : ''),
    nurseName)

  return { visit: db.prepare('SELECT * FROM visits WHERE id=?').get(visitId), duplicated: false, assessment: r }
}

function num(x) { return x === undefined || x === null || x === '' ? null : Number(x) }
function int(x) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0 }
function plusDays(isoLike, days) {
  const d = new Date(String(isoLike).replace(' ', 'T'))
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------- 黄疸临界值复查计划 ----------
// 风险告知文案：选择“在家观察”时生成，家属需确认知晓
export function buildRiskNotice(visit) {
  return [
    `宝宝 ${visit.baby_name} 本次经皮黄疸值 ${visit.bilirubin} µmol/L（${visit.bilirubin_site}，设备 ${visit.device_code || '未登记'}），已接近出生日龄光疗参考阈值。`,
    '居家观察期间请：① 每日喂养 8~12 次，勤喂母乳促进胆红素排泄；② 观察皮肤黄染是否蔓延至四肢、手足心；③ 观察吃奶、精神反应、哭声与大小便颜色；④ 记录喂养次数与排便次数/颜色，供复测护士核对。',
    '出现以下任一情况请立即就诊（勿等复测）：黄疸明显加重、嗜睡难以唤醒、拒奶、尖叫或抽搐、大便呈白陶土色、发热。',
    '即使无上述表现，也建议在 24~48 小时内完成胆红素复测；居家观察不能替代医疗评估。',
  ].join('\n')
}

/**
 * 家属对临界值结果的选择：recheck 次日复测 / clinic 当天去儿科 / observe 在家观察
 */
export function createJaundicePlan({ visitId, choice, acknowledged }, actor) {
  const visit = db.prepare(`SELECT v.*, ar.baby_name, ar.family_user_id FROM visits v JOIN archives ar ON ar.id=v.archive_id WHERE v.id=?`).get(visitId)
  if (!visit) throw Object.assign(new Error('访视记录不存在'), { status: 404 })
  if (!['recheck', 'clinic', 'observe'].includes(choice)) throw Object.assign(new Error('无效选择'), { status: 400 })
  // 同一访视已有计划则更新（家属可改主意），但任务一旦升级需护士介入
  const existed = db.prepare('SELECT * FROM jaundice_plans WHERE visit_id=? ORDER BY id DESC LIMIT 1').get(visitId)
  const due = plusDays(visit.visit_time, 1)
  const actorName = actor?.name || '家属'

  // 访视落库时风险引擎可能已自动生成次日复查预约，计划在这里与之衔接（避免重复预约）
  const autoAppt = db.prepare(`SELECT * FROM appointments WHERE archive_id=? AND type='复查' AND status='待访视'
    AND date(scheduled_time) >= date(?) ORDER BY scheduled_time LIMIT 1`).get(visit.archive_id, visit.visit_time.slice(0, 10))

  let planId = existed?.id
  let taskId = existed?.recheck_task_id || null
  if (planId) {
    // 复测任务外键引用计划：改主意重建计划前先解除引用
    db.prepare(`UPDATE recheck_tasks SET plan_id=NULL WHERE plan_id=?`).run(planId)
    db.prepare(`DELETE FROM jaundice_plans WHERE id=?`).run(planId)
    if (existed.recheck_task_id && choice !== 'recheck') {
      db.prepare(`UPDATE recheck_tasks SET status='已取消', updated_at=datetime('now','localtime') WHERE id=?`).run(existed.recheck_task_id)
    }
  }

  const riskNotice = choice === 'observe' ? buildRiskNotice(visit) : ''
  const ack = choice === 'observe' ? (acknowledged ? 1 : 0) : 0
  const info = db.prepare(`INSERT INTO jaundice_plans
    (archive_id, visit_id, choice, risk_notice, risk_acknowledged, acknowledged_at, due_date, recheck_task_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(visit.archive_id, visitId, choice, riskNotice, ack, ack ? new Date().toISOString().slice(0, 16).replace('T', ' ') : null,
      due, taskId, actorName)
  planId = info.lastInsertRowid

  if (choice === 'recheck') {
    const staleTask = taskId && db.prepare('SELECT status FROM recheck_tasks WHERE id=?').get(taskId)?.status === '已取消'
    if (!taskId || staleTask) {
      taskId = createRecheckTask({
        archiveId: visit.archive_id, planId, visitId,
        nurseId: visit.nurse_id || autoAppt?.nurse_id || null,
        deviceCode: visit.device_code || '',
        scheduledTime: autoAppt ? autoAppt.scheduled_time : `${due} 09:00`,
        appointmentId: autoAppt?.id || null,
      }, actorName)
      db.prepare('UPDATE jaundice_plans SET recheck_task_id=? WHERE id=?').run(taskId, planId)
    }
    addEvent(visit.archive_id, '复查', '家属选择次日复测，已生成复测任务',
      `计划 ${due} 上门复测，复测前请家属准备喂养与排便记录`, actorName)
  } else if (choice === 'clinic') {
    if (autoAppt) db.prepare(`UPDATE appointments SET status='已取消', reason='家属选择当天去儿科', updated_at=datetime('now','localtime') WHERE id=?`).run(autoAppt.id)
    const rf = db.prepare(`SELECT * FROM followups WHERE archive_id=? AND type='复查' AND status!='已闭环' ORDER BY id DESC LIMIT 1`).get(visit.archive_id)
    if (rf) closeFollowup(rf.id, actorName, '家属选择当天去儿科就诊，复查预约取消')
    openFollowup(visit.archive_id, '转诊', '家属选择当天去儿科就诊',
      `临界值 ${visit.bilirubin} µmol/L（设备 ${visit.device_code || '未登记'}），家属决定当天前往儿科；就诊后请反馈结果`,
      due, visitId, actorName)
    addEvent(visit.archive_id, '转诊', '临界值告知后家属选择当天去儿科', '', actorName)
  } else {
    openFollowup(visit.archive_id, '复查', '家属选择居家观察，需按时复测',
      `已送达风险告知${ack ? '（家属已确认知晓）' : '（家属尚未确认）'}，建议 ${due} 前完成复测`,
      due, visitId, actorName)
    addEvent(visit.archive_id, '决策', '家属选择居家观察并收到风险告知',
      ack ? '家属已确认知晓风险与红旗症状' : '家属暂未确认风险告知', actorName)
  }
  return getPlan(planId)
}

export function getPlan(planId) {
  const plan = db.prepare(`
    SELECT p.*, ar.mother_name, ar.baby_name
    FROM jaundice_plans p JOIN archives ar ON ar.id=p.archive_id WHERE p.id=?`).get(planId)
  if (!plan) return null
  return hydratePlan(plan)
}

function hydratePlan(plan) {
  const visit = db.prepare('SELECT * FROM visits WHERE id=?').get(plan.visit_id)
  const task = plan.recheck_task_id ? db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(plan.recheck_task_id) : null
  return { ...plan, visit: visit ? parseVisit(visit) : null, recheckTask: task ? hydrateTask(task) : null }
}

// 取一份档案最新的临界值计划（带访视与任务）
export function latestPlanOfArchive(archiveId) {
  const plan = db.prepare(`SELECT p.*, ar.mother_name, ar.baby_name FROM jaundice_plans p
    JOIN archives ar ON ar.id=p.archive_id WHERE p.archive_id=? ORDER BY p.id DESC LIMIT 1`).get(archiveId)
  return plan ? hydratePlan(plan) : null
}

// 该档案最近一次“接近/达到阈值且未转诊”的访视（供家属端在无计划时发起选择）
export function latestCriticalVisit(archiveId) {
  const v = db.prepare(`SELECT * FROM visits WHERE archive_id=? AND bilirubin IS NOT NULL ORDER BY visit_time DESC, id DESC LIMIT 5`).all(archiveId)
    .map(parseVisit).find((x) => x.need_recheck || x.need_referral)
  return v || null
}

function parseVisit(v) { return { ...v, flags: JSON.parse(v.flags || '[]'), photos: JSON.parse(v.photos || '[]') } }

// ---------- 复测任务 ----------
export function createRecheckTask({ archiveId, planId, visitId, nurseId, deviceCode, scheduledTime, appointmentId }, createdBy = '系统') {
  const t = `${String(scheduledTime).replace('T', ' ')}`
  let apptId = appointmentId || null
  if (!apptId) {
    apptId = db.prepare(`INSERT INTO appointments (archive_id, nurse_id, type, scheduled_time, status, reason)
      VALUES (?,?,?,?,'待访视',?)`)
      .run(archiveId, nurseId || null, '复查', t.length === 16 ? `${t}:00` : t, '黄疸临界值次日复测任务').lastInsertRowid
  }
  const info = db.prepare(`INSERT INTO recheck_tasks
    (archive_id, plan_id, visit_id, appointment_id, nurse_id, device_code, scheduled_time)
    VALUES (?,?,?,?,?,?,?)`)
    .run(archiveId, planId || null, visitId || null, apptId, nurseId || null, String(deviceCode || ''), t)
  const taskId = info.lastInsertRowid
  db.prepare('UPDATE jaundice_plans SET recheck_task_id=? WHERE id=?').run(taskId, planId || 0)
  addEvent(archiveId, '复查', '生成次日复测任务',
    `护士 ${nurseId ? '已指派' : '待指派'}，设备 ${deviceCode || '待登记'}，时间 ${t}`, createdBy)
  return taskId
}

export function hydrateTask(t) {
  const nurse = t.nurse_id ? db.prepare('SELECT id, name, title, phone FROM users WHERE id=?').get(t.nurse_id) : null
  const doctor = t.doctor_id ? db.prepare('SELECT id, name, title, phone FROM users WHERE id=?').get(t.doctor_id) : null
  const ar = db.prepare('SELECT mother_name, baby_name, birth_date, address, contact_name, contact_phone FROM archives WHERE id=?').get(t.archive_id)
  const appt = t.appointment_id ? db.prepare('SELECT * FROM appointments WHERE id=?').get(t.appointment_id) : null
  return { ...t, nurse, doctor, archive: ar, appointment: appt }
}

export function listRecheckTasks(status) {
  const where = {
    open: `status NOT IN ('已完成','已取消')`,
    escalated: `status='已升级'`,
  }[status || 'open'] || '1=1'
  return db.prepare(`SELECT * FROM recheck_tasks WHERE ${where} ORDER BY
    CASE status WHEN '已升级' THEN 0 WHEN '待上门' THEN 1 ELSE 2 END, scheduled_time`).all().map(hydrateTask)
}

/** 护士站改派/登记：由哪名护士携带哪台设备、什么时间上门 */
export function assignRecheckTask(taskId, { nurseId, deviceCode, scheduledTime }, actorName) {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复测任务不存在'), { status: 404 })
  db.prepare(`UPDATE recheck_tasks SET nurse_id=?, device_code=?, scheduled_time=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(nurseId || t.nurse_id, deviceCode !== undefined ? String(deviceCode) : t.device_code,
      scheduledTime ? String(scheduledTime).replace('T', ' ') : t.scheduled_time, taskId)
  if (t.appointment_id) {
    db.prepare(`UPDATE appointments SET nurse_id=?, scheduled_time=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(nurseId || t.nurse_id, scheduledTime ? String(scheduledTime).replace('T', ' ') : t.scheduled_time, t.appointment_id)
  }
  addEvent(t.archive_id, '复查', '复测任务已安排',
    `上门护士与携带设备已确认${scheduledTime ? `，时间 ${String(scheduledTime).replace('T', ' ')}` : ''}`, actorName)
  return hydrateTask(db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId))
}

/** 复测前提醒家属准备喂养和排便记录 */
export function remindPrepare(taskId, actorName) {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复测任务不存在'), { status: 404 })
  const note = '复测前请准备：近 24 小时喂养记录（次数/方式）、排便记录（次数与大便颜色）、小便次数；复测时尽量在喂奶后安静状态下进行。'
  db.prepare(`UPDATE recheck_tasks SET prepare_reminded=1, prepare_note=?, updated_at=datetime('now','localtime') WHERE id=?`).run(note, taskId)
  addEvent(t.archive_id, '复查', '已提醒家属准备复测', note, actorName)
  return hydrateTask(db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId))
}

/**
 * 家属再次改约复测任务。第二次改约 → 升级社区医生判断电话干预或建议直接就诊。
 * 由预约改约路由在改到“复查”预约时调用，也支持任务自身改期。
 */
export function rescheduleRecheckTask(taskId, { scheduledTime, reason }, actorName) {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复测任务不存在'), { status: 404 })
  const count = (t.reschedule_count || 0) + 1
  const time = scheduledTime ? String(scheduledTime).replace('T', ' ') : t.scheduled_time
  db.prepare(`UPDATE recheck_tasks SET reschedule_count=?, scheduled_time=?, status=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(count, time, count >= 2 ? '已升级' : '已改约', taskId)
  if (t.appointment_id) {
    db.prepare(`UPDATE appointments SET scheduled_time=?, status='待访视', reason=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(time.length === 16 ? `${time}:00` : time, `家属复测改约第 ${count} 次：${reason || '未填原因'}`, t.appointment_id)
  }
  if (count >= 2) {
    const note = `家属已第 ${count} 次改约复测（${reason || '未填原因'}），临界值黄疸未按时复测，升级社区医生判断是否电话干预或建议直接就诊`
    db.prepare(`UPDATE recheck_tasks SET escalation_note=? WHERE id=?`).run(note, taskId)
    openFollowup(t.archive_id, '电话随访', '复测反复改约，升级社区医生干预', note, time.slice(0, 10), t.visit_id, '系统')
    addEvent(t.archive_id, '改约', `复测任务第 ${count} 次改约，升级社区医生`, note, actorName)
  } else {
    addEvent(t.archive_id, '改约', `复测任务改约（第 ${count} 次）`, `改至 ${time}：${reason || ''}`, actorName)
  }
  return hydrateTask(db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId))
}

/** 社区医生对升级任务的处置：电话干预 / 建议直接就诊 */
export function doctorIntervene(taskId, { action, note }, doctor) {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复测任务不存在'), { status: 404 })
  if (!['phone_call', 'direct_visit'].includes(action)) throw Object.assign(new Error('无效处置'), { status: 400 })
  db.prepare(`UPDATE recheck_tasks SET doctor_action=?, doctor_note=?, doctor_id=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(action, String(note || ''), doctor.id, taskId)
  const text = action === 'phone_call' ? '社区医生电话干预' : '社区医生建议直接就诊'
  addEvent(t.archive_id, '决策', `复测改约升级 - ${text}`, note || '', doctor.name)
  // 闭环“复测反复改约”电话随访事项
  const f = db.prepare(`SELECT * FROM followups WHERE archive_id=? AND type='电话随访' AND status!='已闭环' ORDER BY id DESC LIMIT 1`).get(t.archive_id)
  if (f) closeFollowup(f.id, doctor.name, `${text}：${note || ''}`)
  if (action === 'direct_visit') {
    const v = t.visit_id ? db.prepare('SELECT * FROM visits WHERE id=?').get(t.visit_id) : null
    openFollowup(t.archive_id, '转诊', '反复未复测，医生建议直接就诊',
      `临界值黄疸${v ? ` ${v.bilirubin} µmol/L` : ''}，复测经 ${t.reschedule_count} 次改约未完成；医生建议直接到儿科测胆红素评估`,
      null, t.visit_id, doctor.name)
  }
  return hydrateTask(db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId))
}

// ---------- 转诊单 ----------
export function listReferrals(openOnly = true) {
  const rows = db.prepare(`
    SELECT r.*, ar.mother_name, ar.baby_name, ar.birth_date, ar.address, ar.contact_name, ar.contact_phone,
      pn.name prev_nurse_name, cn.name current_nurse_name,
      tp.bilirubin_site prev_site, tc.bilirubin_site current_site,
      tp.feeding_freq prev_feeding, tc.feeding_freq current_feeding,
      tp.stool_count prev_stool, tp.stool_color prev_stool_color,
      tc.stool_count current_stool, tc.stool_color current_stool_color,
      tp.weight prev_weight, tc.weight current_weight,
      tp.visit_time prev_time, tc.visit_time current_time,
      tp.device_code prev_device, tc.device_code current_device
    FROM referrals r
    JOIN archives ar ON ar.id=r.archive_id
    LEFT JOIN visits tp ON tp.id=r.baseline_visit_id
    LEFT JOIN visits tc ON tc.id=r.current_visit_id
    LEFT JOIN users pn ON pn.id=tp.nurse_id
    LEFT JOIN users cn ON cn.id=tc.nurse_id
    ${openOnly ? `WHERE r.status!='已闭环'` : ''}
    ORDER BY r.created_at DESC`).all()
  return rows
}

export function referralFeedback(id, { feedback, close }, actorName) {
  const r = db.prepare('SELECT * FROM referrals WHERE id=?').get(id)
  if (!r) throw Object.assign(new Error('转诊单不存在'), { status: 404 })
  db.prepare(`UPDATE referrals SET hospital_feedback=?, status=?, closed_at=?, closed_by=? WHERE id=?`)
    .run(String(feedback || r.hospital_feedback), close ? '已闭环' : '已就诊',
      close ? new Date().toISOString().slice(0, 16).replace('T', ' ') : null, close ? actorName : null, id)
  if (close) {
    const f = db.prepare(`SELECT * FROM followups WHERE archive_id=? AND type='转诊' AND status!='已闭环' ORDER BY id DESC LIMIT 1`).get(r.archive_id)
    if (f) closeFollowup(f.id, actorName, `转诊单 #${id} 就诊反馈闭环：${feedback || ''}`)
    addEvent(r.archive_id, '闭环', `转诊单 #${id} 已闭环`, feedback || '', actorName)
  }
  return db.prepare('SELECT * FROM referrals WHERE id=?').get(id)
}
