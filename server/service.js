// 访视落库与随访闭环的领域服务：种子数据与 HTTP 路由共用，保证行为一致
import db, { addEvent } from './db.js'
import { assessVisit, ageDaysOf, bilirubinThreshold } from './risk.js'

const VISIT_COLS = ['client_id','appointment_id','archive_id','nurse_id','visit_time','weight','bilirubin',
  'bilirubin_site','cord','stool_count','stool_color','urine_count','feeding_type','feeding_freq','spit_up',
  'sleep','breast','mood','wound_check','care_ability','device_issue','photos','advice','risk_level','flags',
  'need_recheck','need_referral','need_lactation','need_phone','device_no','doctor_advice','created_offline']

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

function closeOpenByType(archiveId, types, closedBy, note) {
  for (const f of db.prepare(`SELECT * FROM followups WHERE archive_id=? AND status!='已闭环'`).all(archiveId)) {
    if (types.includes(f.type)) closeFollowup(f.id, closedBy, note)
  }
}

// 黄疸临界值风险告知（家属选择“继续观察”时展示并存档）
export function buildRiskNotice(archive, v, r) {
  const gap = r.threshold - Number(v.bilirubin)
  return [
    `【黄疸临界值风险告知】${archive.baby_name} 出生第 ${r.ageDays + 1} 天，本次经皮胆红素 ${v.bilirubin} µmol/L（${v.bilirubin_site}），`,
    `距当日光疗参考阈值 ${r.threshold} 仅差 ${gap} µmol/L，尚未达转诊标准但需密切观察。`,
    '居家观察期间请：① 增加喂养至每日 8~12 次，促进胆红素排泄；② 记录每次喂养时间、奶量与大小便次数、颜色；',
    '③ 在自然光下观察皮肤黄染是否加重（可蔓延至四肢、手心脚心）。',
    '如出现以下任一情况请立即到儿科就诊：皮肤黄染明显加重、嗜睡难以唤醒、拒奶、尖叫、抽搐、发热、大便颜色变浅发白、小便深黄染尿布。',
    `建议 ${plusDays(v.visit_time, 1)} 前后复查胆红素；逾期未复查社区将电话随访，必要时建议直接就诊。`,
  ].join('\n')
}

/**
 * 提交一次访视：风险评估 → 落库 → 更新预约 → 生成/闭环随访事项 → 临界值复查流程 → 写时间线
 */
export function createVisit(payload, nurse) {
  const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(payload.archive_id)
  if (!archive) throw Object.assign(new Error('母婴档案不存在'), { status: 404 })

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
    device_no: String(payload.device_no || '').trim(),
    doctor_advice: String(payload.doctor_advice || '').trim(),
    photos: JSON.stringify(payload.photos || []),
    created_offline: payload.created_offline ? 1 : 0,
  }
  const r = assessVisit(archive, v)

  // 临界值四项必录：测量部位、设备编号、喂养情况、医生建议（页面与服务端双重校验）
  if (r.nearJaundice) {
    const missing = []
    if (!v.bilirubin_site) missing.push('测量部位')
    if (!v.device_no) missing.push('设备编号')
    if (!v.feeding_type || v.feeding_freq <= 0) missing.push('喂养情况')
    if (!v.doctor_advice) missing.push('医生建议')
    if (missing.length) throw Object.assign(new Error(`黄疸接近转诊阈值，必须补录：${missing.join('、')}`), { status: 400 })
  }

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
  const visitRow = db.prepare('SELECT * FROM visits WHERE id=?').get(visitId)

  // 预约状态联动
  if (v.appointment_id) {
    db.prepare(`UPDATE appointments SET status='已完成', updated_at=datetime('now','localtime') WHERE id=?`)
      .run(v.appointment_id)
  }
  // 本次访视即完成了此前开放的“再次预约”事项 → 自动闭环
  for (const f of db.prepare(`SELECT * FROM followups WHERE archive_id=? AND status!='已闭环'`).all(archive.id)) {
    if (f.type === '再次预约') closeFollowup(f.id, nurse?.name || '系统', `访视 #${visitId} 已完成`)
  }

  // 生成新的随访事项
  const nurseName = nurse?.name || '系统'
  const summary = `黄疸 ${v.bilirubin ?? '-'} µmol/L（第 ${r.ageDays + 1} 天，阈值 ${r.threshold}，${v.bilirubin_site}，设备 ${v.device_no || '未记录'}），体重 ${v.weight ?? '-'} g` +
    (r.weightLossPct != null ? `（较出生 ${r.weightLossPct}%）` : '') + `，喂养 ${v.feeding_type} ${v.feeding_freq} 次/日` +
    (v.doctor_advice ? `；医生建议：${v.doctor_advice}` : '')
  if (v.need_referral) {
    openFollowup(archive.id, '转诊', '转诊儿科评估', summary + '。' + r.flags.join('；'),
      null, visitId, nurseName)
  }

  // —— 黄疸临界值复查流程：不直接排预约，先由家属选择处置方式 ——
  let recheckTask = null
  if (r.nearJaundice && !v.need_referral) {
    const due = plusDays(v.visit_time, 1)
    const taskInfo = db.prepare(`INSERT INTO recheck_tasks
      (archive_id, source_visit_id, status, due_date, device_no)
      VALUES (?,?,'待选择',?,?)`)
      .run(archive.id, visitId, due, v.device_no)
    recheckTask = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskInfo.lastInsertRowid)
    openFollowup(archive.id, '复查', '黄疸临界值复查（待家属选择：次日复测 / 当天就诊 / 居家观察）',
      summary + '。已向家属告知临界值风险，等待家属选择处置方式。',
      due, visitId, nurseName)
    addEvent(archive.id, '复查', '黄疸接近转诊阈值，发起临界值复查',
      `测量部位 ${v.bilirubin_site}，设备 ${v.device_no}；${v.doctor_advice}`, nurseName)
  } else if (v.need_recheck) {
    // 其他高风险情形的常规复查：保留自动排次日预约
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

  // —— 若本次访视是在完成一项复测任务：比对前后黄疸，升高则生成带前日记录的转诊单 ——
  let referral = null
  const task = findTaskByVisitContext(archive.id, v.appointment_id, visitId)
  if (task) {
    referral = completeRecheckTask(task, visitRow, r, nurseName)
  } else if (v.appointment_id) {
    // 常规复查预约完成 → 闭环复查事项
    const appt = db.prepare('SELECT type FROM appointments WHERE id=?').get(v.appointment_id)
    if (appt?.type === '复查') closeOpenByType(archive.id, ['复查'], nurseName, `复查访视 #${visitId} 已完成`)
  }

  return { visit: visitRow, duplicated: false, assessment: r, recheckTask, referral }
}

// 找到本次访视对应的待复测任务（优先按预约关联，兜底取档案下最近的开放任务）
function findTaskByVisitContext(archiveId, appointmentId, visitId) {
  if (appointmentId) {
    const t = db.prepare(`SELECT * FROM recheck_tasks WHERE appointment_id=? AND status IN ('待复测','已升级')`).get(appointmentId)
    if (t) return t
  }
  return db.prepare(`SELECT * FROM recheck_tasks
    WHERE archive_id=? AND source_visit_id!=? AND status IN ('待复测','已升级')
    ORDER BY id DESC LIMIT 1`).get(archiveId, visitId)
}

// 复测完成：回填任务并比对趋势
function completeRecheckTask(task, visitRow, r, nurseName) {
  const src = db.prepare('SELECT * FROM visits WHERE id=?').get(task.source_visit_id)
  const bPrev = src?.bilirubin != null ? Number(src.bilirubin) : null
  const bNow = visitRow.bilirubin != null ? Number(visitRow.bilirubin) : null
  const risen = bPrev != null && bNow != null && bNow > bPrev
  const reached = bNow != null && bNow >= r.threshold

  db.prepare(`UPDATE recheck_tasks SET recheck_visit_id=?, status='已完成', family_choice=COALESCE(NULLIF(family_choice,''),'复测'),
              updated_at=datetime('now','localtime') WHERE id=?`).run(visitRow.id, task.id)
  closeOpenByType(task.archive_id, ['复查'], nurseName, `复测访视 #${visitRow.id} 已完成`)

  let referral = null
  if (risen || reached) {
    referral = generateReferral(task, src, visitRow, r, nurseName, { risen, reached })
  } else {
    addEvent(task.archive_id, '复查', '复测黄疸未升高，继续居家观察',
      `前日 ${bPrev ?? '-'} → 本次 ${bNow ?? '-'} µmol/L（阈值 ${r.threshold}），持平或下降。`, nurseName)
  }
  return referral
}

// 生成带变化趋势的转诊单（自动带入前一天记录）
export function generateReferral(task, prevVisit, nowVisit, r, actor = '系统', opts = {}) {
  const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(task.archive_id)
  const bPrev = prevVisit?.bilirubin != null ? Number(prevVisit.bilirubin) : null
  const bNow = nowVisit.bilirubin != null ? Number(nowVisit.bilirubin) : null
  const agePrev = prevVisit ? ageDaysOf(archive.birth_date, prevVisit.visit_time) : null
  const ageNow = ageDaysOf(archive.birth_date, nowVisit.visit_time)
  const thresholdNow = bilirubinThreshold(ageNow)
  const delta = bPrev != null && bNow != null ? Math.round((bNow - bPrev) * 10) / 10 : null

  const trendParts = []
  if (delta != null) {
    trendParts.push(delta > 0
      ? `24 小时胆红素由 ${bPrev} 升至 ${bNow} µmol/L，升高 ${delta} µmol/L`
      : `胆红素 ${bPrev} → ${bNow} µmol/L，未升高`)
  }
  if (opts.reached || bNow >= thresholdNow) trendParts.push(`本次已达出生第 ${ageNow + 1} 天光疗参考阈值 ${thresholdNow}`)
  if (prevVisit) {
    trendParts.push(`前日喂养 ${prevVisit.feeding_type} ${prevVisit.feeding_freq} 次/日、大便 ${prevVisit.stool_count} 次（${prevVisit.stool_color}）、小便 ${prevVisit.urine_count} 次`)
    trendParts.push(`本次喂养 ${nowVisit.feeding_type} ${nowVisit.feeding_freq} 次/日、大便 ${nowVisit.stool_count} 次（${nowVisit.stool_color}）、小便 ${nowVisit.urine_count} 次`)
  }
  if (prevVisit?.weight != null && nowVisit.weight != null) {
    trendParts.push(`体重 ${prevVisit.weight}g → ${nowVisit.weight}g`)
  }
  const trendNote = trendParts.join('；')

  const title = '复测黄疸升高，转诊儿科（附变化趋势）'
  const fu = db.prepare(`SELECT * FROM followups WHERE archive_id=? AND type='转诊' AND status!='已闭环'
                         ORDER BY id DESC LIMIT 1`).get(task.archive_id)
  let followupId = fu?.id || null
  if (!fu) {
    const info = db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, created_by)
                             VALUES (?,?,?,?,?,?)`)
      .run(task.archive_id, nowVisit.id, '转诊', title, trendNote, actor)
    followupId = info.lastInsertRowid
  }

  const info = db.prepare(`INSERT INTO referrals
    (archive_id, recheck_task_id, previous_visit_id, current_visit_id, followup_id,
     bilirubin_prev, bilirubin_site_prev, bilirubin_now, bilirubin_site_now, bilirubin_delta,
     threshold_now, age_days_prev, age_days_now, weight_prev, weight_now,
     feeding_prev, feeding_now, trend_note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      task.archive_id, task.id, prevVisit?.id ?? null, nowVisit.id, followupId,
      bPrev, prevVisit?.bilirubin_site || '', bNow, nowVisit.bilirubin_site, delta,
      thresholdNow, agePrev, ageNow, prevVisit?.weight ?? null, nowVisit.weight,
      prevVisit ? `${prevVisit.feeding_type} ${prevVisit.feeding_freq}次/日` : '',
      `${nowVisit.feeding_type} ${nowVisit.feeding_freq}次/日`, trendNote, actor)
  const referral = db.prepare('SELECT * FROM referrals WHERE id=?').get(info.lastInsertRowid)

  addEvent(task.archive_id, '转诊', title,
    `转诊单 #${referral.id}：${trendNote}。前日记录（${prevVisit ? `设备 ${prevVisit.device_no || '未记录'}、${prevVisit.bilirubin_site}、医生建议：${prevVisit.doctor_advice || '无'}` : '无'}）已随转诊单一并提交。`,
    actor)
  return referral
}

function num(x) { return x === undefined || x === null || x === '' ? null : Number(x) }
function int(x) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0 }
function plusDays(isoLike, days) {
  const d = new Date(String(isoLike).replace(' ', 'T'))
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ===================== 黄疸临界值复查流程 =====================

const TASK_SELECT = `
  SELECT t.*, ar.mother_name, ar.baby_name, ar.address, ar.contact_name, ar.contact_phone, ar.birth_date,
         u.name AS assign_nurse_name
  FROM recheck_tasks t
  JOIN archives ar ON ar.id=t.archive_id
  LEFT JOIN users u ON u.id=t.assign_nurse_id`

export function getRecheckTask(id) {
  const t = db.prepare(`${TASK_SELECT} WHERE t.id=?`).get(id)
  if (!t) return null
  t.source_visit = db.prepare('SELECT * FROM visits WHERE id=?').get(t.source_visit_id)
  if (t.source_visit) {
    t.source_visit.flags = JSON.parse(t.source_visit.flags || '[]')
    t.source_visit.photos = JSON.parse(t.source_visit.photos || '[]')
  }
  return t
}

export function listRecheckTasks(scope = 'open') {
  const where = scope === 'all' ? '' : `WHERE t.status NOT IN ('已完成','已取消')`
  const order = `ORDER BY CASE t.status WHEN '待选择' THEN 0 WHEN '待安排' THEN 1 WHEN '已升级' THEN 2 WHEN '待复测' THEN 3 ELSE 4 END, t.id DESC`
  return db.prepare(`${TASK_SELECT} ${where} ${order}`).all()
}

function touch(id) {
  db.prepare(`UPDATE recheck_tasks SET updated_at=datetime('now','localtime') WHERE id=?`).run(id)
}

/**
 * 家属处置选择：次日复测 / 当天去儿科 / 居家观察
 */
export function familyChooseRecheck(taskId, choice, actor = '家属') {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复查任务不存在'), { status: 404 })
  if (!['复测', '当天就诊', '观察'].includes(choice)) throw Object.assign(new Error('无效选择'), { status: 400 })
  if (!['待选择', '待安排', '观察中'].includes(t.status) && !(t.status === '待复测' && choice === '当天就诊')) {
    throw Object.assign(new Error('当前任务状态不能再做该选择'), { status: 400 })
  }

  if (choice === '当天就诊') {
    db.prepare(`UPDATE recheck_tasks SET family_choice='当天就诊', status='已就诊', updated_at=datetime('now','localtime') WHERE id=?`).run(t.id)
    closeOpenByType(t.archive_id, ['复查'], actor, '家属选择当天自行前往儿科就诊')
    db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, created_by)
                VALUES (?,?, '转诊', '家属当天带新生儿前往儿科就诊', '黄疸临界值，家属选择不等复测、当天就诊，待反馈就诊结果。', ?)`)
      .run(t.archive_id, t.source_visit_id, actor)
    addEvent(t.archive_id, '转诊', '家属选择当天去儿科就诊', '放弃次日复测，当天自行前往儿科。', actor)
    return { task: getRecheckTask(t.id) }
  }

  if (choice === '观察') {
    const src = db.prepare('SELECT * FROM visits WHERE id=?').get(t.source_visit_id)
    const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(t.archive_id)
    const r = assessVisit(archive, src)
    const notice = buildRiskNotice(archive, src, r)
    db.prepare(`UPDATE recheck_tasks SET family_choice='观察', status='观察中', risk_notice=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(notice, t.id)
    // 观察仍保留复查提醒（次日），并新增电话随访
    db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, due_date, created_by)
                VALUES (?,?,'电话随访','居家观察·次日电话随访确认黄疸情况',?,?,'系统')`)
      .run(t.archive_id, t.source_visit_id, '家属选择居家观察，已告知风险与红旗症状；次日需电话确认并争取复测。', t.due_date)
    addEvent(t.archive_id, '决策', '家属选择居家观察', '已生成复查提醒并签收风险告知。', actor)
    return { task: getRecheckTask(t.id), riskNotice: notice }
  }

  // 次日复测：进入“待安排”，由护士/社区在分配动作中明确上门护士与设备后转为“待复测”
  db.prepare(`UPDATE recheck_tasks SET family_choice='复测', status='待安排', updated_at=datetime('now','localtime') WHERE id=?`).run(t.id)
  addEvent(t.archive_id, '复查', '家属选择次日复测', '等待社区安排上门护士与测量设备。', actor)
  return { task: getRecheckTask(t.id) }
}

/**
 * 安排/确认复测任务：明确由哪名护士携带哪台设备、什么时间上门；同时创建/更新复查预约
 */
export function assignRecheckTask(taskId, { nurseId, deviceNo, scheduledTime }, actor = '系统') {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复查任务不存在'), { status: 404 })
  if (['已完成', '已就诊', '已取消'].includes(t.status)) throw Object.assign(new Error('任务已结束，不能再安排'), { status: 400 })
  const device = String(deviceNo || '').trim()
  if (!device) throw Object.assign(new Error('请填写本次复测携带的设备编号'), { status: 400 })
  const when = scheduledTime ? String(scheduledTime).replace('T', ' ') : `${t.due_date} 09:00:00`

  let appointmentId = t.appointment_id
  if (appointmentId) {
    db.prepare(`UPDATE appointments SET nurse_id=?, type='复查', scheduled_time=?, status='待访视',
                reason=?, recheck_task_id=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(nurseId, when, '黄疸临界值次日复测', t.id, appointmentId)
  } else {
    const info = db.prepare(`INSERT INTO appointments (archive_id, nurse_id, type, scheduled_time, status, reason, recheck_task_id)
                             VALUES (?,?,'复查',?,'待访视',?,?)`)
      .run(t.archive_id, nurseId, when, '黄疸临界值次日复测', t.id)
    appointmentId = info.lastInsertRowid
  }

  db.prepare(`UPDATE recheck_tasks SET family_choice=COALESCE(NULLIF(family_choice,''),'复测'), status='待复测',
              assign_nurse_id=?, device_no=?, appointment_id=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(nurseId, device, appointmentId, t.id)
  const nurseName = db.prepare('SELECT name FROM users WHERE id=?').get(nurseId)?.name || '护士'
  closeOpenByType(t.archive_id, ['复查'], actor, `已安排 ${nurseName} 携带设备 ${device} 于 ${when} 上门复测`)
  db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, due_date, created_by)
              VALUES (?,?,'复查','次日黄疸复测任务',?,?,'系统')`)
    .run(t.archive_id, t.source_visit_id, `${nurseName} 携带经皮胆红素仪 ${device} 于 ${when} 上门；复测前提醒家属备好喂养与排便记录。`, when.slice(0, 10))
  addEvent(t.archive_id, '复查', '生成次日复测任务',
    `上门护士：${nurseName}；设备编号：${device}；时间：${when}`, actor)
  return { task: getRecheckTask(t.id) }
}

/** 复测前提醒：已提醒家属准备喂养和排便记录 */
export function markRecheckReminder(taskId, actor = '系统') {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复查任务不存在'), { status: 404 })
  db.prepare(`UPDATE recheck_tasks SET remind_prepared=1, remind_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(t.id)
  addEvent(t.archive_id, '复查', '复测前准备提醒已发送',
    '提醒家属提前记录复测前 24 小时喂养次数/奶量、大小便次数与颜色，供复测趋势判断。', actor)
  return { task: getRecheckTask(t.id) }
}

/**
 * 家属再次改约复测预约：改约次数 +1，并把任务升级给社区医生判断是否电话干预或建议直接就诊
 */
export function escalateRecheckOnReschedule(appointmentId, reason, actor = '家属') {
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId)
  if (!appt?.recheck_task_id) return null
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(appt.recheck_task_id)
  if (!t || ['已完成', '已就诊', '已取消'].includes(t.status)) return null

  const count = t.reschedule_count + 1
  db.prepare(`UPDATE recheck_tasks SET reschedule_count=?, status='已升级', escalated_at=COALESCE(escalated_at,datetime('now','localtime')),
              updated_at=datetime('now','localtime') WHERE id=?`).run(count, t.id)
  db.prepare(`INSERT INTO followups (archive_id, type, title, detail, due_date, created_by)
              VALUES (?, '电话随访', '复测再次改约，升级社区医生判断', ?, ?, ?)`)
    .run(t.archive_id,
      `家属第 ${count} 次改约（${reason || '未填原因'}）。请社区医生判断：电话干预劝说按时复测，或建议直接到儿科/急诊就诊。`,
      t.due_date, actor)
  addEvent(t.archive_id, '改约', `复测任务第 ${count} 次改约，已升级社区医生`,
    `原因：${reason || '未填'}；升级社区医生决定电话干预或建议直接就诊。`, actor)
  return getRecheckTask(t.id)
}

/** 社区医生对升级任务的判断：电话干预 / 建议直接就诊 / 继续观察 */
export function doctorRecheckDecision(taskId, decision, note, actor = '社区医生') {
  const t = db.prepare('SELECT * FROM recheck_tasks WHERE id=?').get(taskId)
  if (!t) throw Object.assign(new Error('复查任务不存在'), { status: 404 })
  if (!['电话干预', '建议直接就诊', '继续观察'].includes(decision)) throw Object.assign(new Error('无效决定'), { status: 400 })

  db.prepare(`UPDATE recheck_tasks SET doctor_decision=?, doctor_note=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(decision, note || '', t.id)

  if (decision === '建议直接就诊') {
    db.prepare(`UPDATE recheck_tasks SET status='已就诊' WHERE id=?`).run(t.id)
    db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, created_by)
                VALUES (?,?,'转诊','社区医生建议直接就诊（复测再次改约）',?,?)`)
      .run(t.archive_id, t.source_visit_id, `家属再次改约未复测；医生判断：${note || '黄疸变化存在风险，建议直接就诊'}`, actor)
    addEvent(t.archive_id, '转诊', '社区医生建议直接到儿科就诊', note, actor)
    closeOpenByType(t.archive_id, ['电话随访'], actor, '医生决定：建议直接就诊')
  } else if (decision === '电话干预') {
    // 保持已升级，电话劝说后由护士继续复测安排；登记一条电话随访闭环
    closeOpenByType(t.archive_id, ['电话随访'], actor, `医生电话干预：${note || '劝说家属按时复测'}`)
    db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, due_date, created_by)
                VALUES (?,?,'复查','电话干预后继续跟进复测',?,?,?)`)
      .run(t.archive_id, t.source_visit_id, `已电话干预：${note || '劝说家属配合次日复测'}`, t.due_date, actor)
    addEvent(t.archive_id, '决策', '社区医生决定电话干预', note, actor)
  } else {
    db.prepare(`UPDATE recheck_tasks SET status='观察中' WHERE id=?`).run(t.id)
    closeOpenByType(t.archive_id, ['电话随访'], actor, `医生判断继续观察：${note || ''}`)
    addEvent(t.archive_id, '决策', '社区医生判断继续观察', note, actor)
  }
  return { task: getRecheckTask(t.id) }
}

/** 转诊单反馈：家属已到医院就诊 */
export function markReferralVisited(referralId, feedback, actor = '护士') {
  const r = db.prepare('SELECT * FROM referrals WHERE id=?').get(referralId)
  if (!r) throw Object.assign(new Error('转诊单不存在'), { status: 404 })
  db.prepare(`UPDATE referrals SET status='已就诊', visited_at=datetime('now','localtime'), hospital_feedback=? WHERE id=?`)
    .run(feedback || '', r.id)
  db.prepare(`UPDATE followups SET status='已闭环', closed_at=datetime('now','localtime'), closed_by=?, close_note=? WHERE id=?`)
    .run(actor, `医院就诊反馈：${feedback || '已就诊'}`, r.followup_id)
  addEvent(r.archive_id, '闭环', `转诊单 #${r.id} 就诊闭环`, feedback, actor)
  return db.prepare('SELECT * FROM referrals WHERE id=?').get(r.id)
}

export function listReferrals(archiveId = null) {
  const sql = `SELECT r.*, ar.mother_name, ar.baby_name FROM referrals r
               JOIN archives ar ON ar.id=r.archive_id
               ${archiveId ? 'WHERE r.archive_id=?' : ''} ORDER BY r.id DESC`
  return archiveId ? db.prepare(sql).all(archiveId) : db.prepare(sql).all()
}
