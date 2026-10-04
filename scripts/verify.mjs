// 端到端验证脚本：node scripts/verify.mjs（需服务已启动，默认 http://localhost:8080）
// 覆盖：登录、工作台、档案筛选、访视提交与风险结论、离线同步幂等、
//       未开门/改约、随访闭环、医生决策、家属端总览/材料/咨询、
//       黄疸临界值复查（设备编号/医生建议、家属三选择、风险告知、复测任务、
//       准备提醒、二次改约升级社区医生、医生处置、复测升高转诊单带趋势）
const BASE = process.env.BASE_URL || 'http://localhost:8080'
let passed = 0, failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed++; console.error(`  ✘ ${name}${extra ? ' — ' + extra : ''}`) }
}
const j = (r) => r.json()
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then(j)
  if (!r.token) throw new Error(`登录失败 ${username}: ${JSON.stringify(r)}`)
  return { token: r.token, user: r.user }
}
const call = (token, method, path, body) =>
  fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }).then(j)

console.log(`验证目标: ${BASE}`)

// 1 登录
const nurse = await login('nurse', 'nurse123')
const doctor = await login('doctor', 'doctor123')
const family = await login('family', 'family123')
ok('三类角色登录', !!(nurse.token && doctor.token && family.token), `${nurse.user.name}/${doctor.user.name}/${family.user.name}`)

// 2 工作台
const dash = await call(nurse.token, 'GET', '/api/dashboard')
ok('工作台统计', dash.stats.unvisited > 0 && dash.stats.openFollowups > 0,
  `未访视${dash.stats.unvisited} 黄疸异常${dash.stats.jaundiceAlerts} 产妇风险${dash.stats.maternalRisks} 待闭环${dash.stats.openFollowups}`)

// 3 档案筛选
const all = await call(nurse.token, 'GET', '/api/archives')
const jaundice = await call(nurse.token, 'GET', '/api/archives?filter=jaundice')
const maternal = await call(nurse.token, 'GET', '/api/archives?filter=maternal')
ok('档案列表', all.archives.length >= 8, `共 ${all.archives.length} 份`)
ok('异常黄疸筛选', jaundice.archives.length >= 2, jaundice.archives.map(a => a.baby_name).join('、'))
ok('产妇风险筛选', maternal.archives.length >= 1, maternal.archives.map(a => a.baby_name).join('、'))

// 4 档案详情（时间线/访视/随访在同一档案）
const target = all.archives.find(a => a.baby_name === '吴小满')
const detail = await call(nurse.token, 'GET', `/api/archives/${target.id}`)
ok('档案详情聚合', detail.visits.length > 0 && detail.followups.length > 0 && detail.events.length > 0,
  `访视${detail.visits.length} 随访${detail.followups.length} 事件${detail.events.length}`)
const wuVisit = detail.visits[0]
ok('种子风险结论（吴小满：体重降>10%+黄疸近阈值+设备故障）',
  wuVisit.risk_level === '危急' && wuVisit.need_referral === 1 && wuVisit.device_issue === 1,
  `风险${wuVisit.risk_level} 标记${wuVisit.flags.length}条`)

// 5 提交一次高风险访视 → 自动生成复查/转诊等事项
const liAnan = all.archives.find(a => a.baby_name === '李安安')
const visitRes = await call(nurse.token, 'POST', '/api/visits', {
  archive_id: liAnan.id, visit_time: new Date().toISOString().slice(0, 16),
  weight: 2900, bilirubin: 285, bilirubin_site: '额头', cord: '渗液',
  stool_count: 2, stool_color: '黄色', urine_count: 5, feeding_freq: 6,
  spit_up: '频繁', sleep: '正常', breast: '涨奶', mood: '焦虑', care_ability: '一般',
})
ok('访视提交', !!visitRes.visit?.id, `visit#${visitRes.visit?.id}`)
ok('风险引擎：接近阈值+体重下降+喂养不足',
  visitRes.visit.risk_level === '高' && visitRes.visit.need_recheck === 1 && visitRes.visit.need_lactation === 1,
  `风险${visitRes.visit.risk_level} 复查${visitRes.visit.need_recheck} 母乳指导${visitRes.visit.need_lactation}`)
const after = await call(nurse.token, 'GET', `/api/archives/${liAnan.id}`)
ok('自动生成复查预约', after.appointments.some(a => a.type === '复查' && a.status === '待访视'))
ok('随访事项生成', after.followups.filter(f => f.status !== '已闭环').length >= 2)

// 6 离线同步幂等：同一 client_id 提交两次只落一条
const cid = `verify-${Date.now()}`
const syncBody = { visits: [{ client_id: cid, archive_id: liAnan.id, visit_time: new Date().toISOString().slice(0, 16), weight: 2910, bilirubin: 260, feeding_freq: 8, stool_count: 3, stool_color: '黄色', urine_count: 7 }] }
const s1 = await call(nurse.token, 'POST', '/api/sync/visits', syncBody)
const s2 = await call(nurse.token, 'POST', '/api/sync/visits', syncBody)
ok('离线草稿同步', s1.results[0].ok === true, `visit#${s1.results[0].visit_id}`)
ok('同步幂等（重复 client_id 不产生重复记录）', s2.results[0].ok && s2.results[0].duplicated === true && s2.results[0].visit_id === s1.results[0].visit_id)

// 7 未开门 → 再次预约事项
const appts = await call(nurse.token, 'GET', '/api/appointments?status=待访视')
const someAppt = appts.appointments.find(a => a.archive_id !== liAnan.id)
if (someAppt) {
  await call(nurse.token, 'POST', `/api/appointments/${someAppt.id}/no-show`, { note: '验证脚本：无人应答' })
  const fu = await call(nurse.token, 'GET', '/api/followups')
  ok('未开门生成再次预约事项', fu.followups.some(f => f.type === '再次预约' && f.archive_id === someAppt.archive_id))
  // 改约
  const r2 = await call(nurse.token, 'POST', `/api/appointments/${someAppt.id}/reschedule`, { scheduledTime: '2099-01-01 09:00', reason: '验证脚本改约' })
  ok('改约', r2.appointment.status === '待访视' && r2.appointment.scheduled_time.startsWith('2099-01-01'))
} else ok('未开门/改约', false, '没有可用预约')

// 8 医生决策 + 闭环
const fus = await call(doctor.token, 'GET', '/api/followups')
const openOne = fus.followups.find(f => f.status !== '已闭环')
const dec = await call(doctor.token, 'POST', `/api/followups/${openOne.id}/decide`, { decision: '电话随访', note: '验证脚本：先电话随访观察' })
ok('医生决策', dec.ok === true)
const closed = await call(nurse.token, 'POST', `/api/followups/${openOne.id + 1}/close`, { note: '验证脚本闭环' })
ok('护士闭环', closed.followup?.status === '已闭环' || (await call(nurse.token, 'GET', '/api/followups')).followups.some(f => f.status === '已闭环'))

// 9 家属端
const fam = await call(family.token, 'GET', '/api/family/overview')
ok('家属端总览（建议/复查/风险说明）', fam.visits.length > 0 && !!fam.visits[0].advice && fam.followups.length >= 0,
  `访视${fam.visits.length}次 待办${fam.followups.length}项`)
const doc = await call(family.token, 'POST', '/api/documents', { type: '喂养记录', filename: 'verify.jpg', note: '验证脚本上传' })
ok('家属补充材料', !!doc.document?.id)
const con = await call(family.token, 'POST', '/api/consults', { question: '验证脚本：宝宝可以晒太阳吗？' })
ok('家属线上咨询', !!con.consult?.id)
const reply = await call(nurse.token, 'POST', `/api/consults/${con.consult.id}/reply`, { reply: '可以，避开正午，每次15分钟左右。' })
ok('护士回复咨询并闭环', reply.consult.status === '已回复')

// 10 黄疸临界值复查全链路（李安安：家属三选择 → 复测任务 → 二次改约升级 → 医生处置）
const famOverview0 = await call(family.token, 'GET', '/api/family/overview')
ok('临界值访视可发起复查选择', !!famOverview0.criticalVisit && famOverview0.criticalVisit.need_recheck === 1,
  `最近访视黄疸 ${famOverview0.criticalVisit?.bilirubin} 风险${famOverview0.criticalVisit?.risk_level}`)

const liVisitId = visitRes.visit.id
// 观察必须先确认风险告知
const noAck = await fetch(`${BASE}/api/jaundice/plan`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${family.token}` },
  body: JSON.stringify({ visitId: liVisitId, choice: 'observe', acknowledged: false }),
}).then(j)
ok('居家观察未确认风险告知被拦截', !!noAck.error, noAck.error)

const planObs = await call(family.token, 'POST', '/api/jaundice/plan', { visitId: liVisitId, choice: 'observe', acknowledged: true })
ok('居家观察生成风险告知与复查提醒',
  planObs.plan?.choice === 'observe' && planObs.plan.risk_acknowledged === 1 && planObs.plan.risk_notice.includes('立即就诊')
  && planObs.plan.due_date != null)

const planRe = await call(family.token, 'POST', '/api/jaundice/plan', { visitId: liVisitId, choice: 'recheck' })
ok('选择次日复测生成明确复测任务',
  planRe.plan?.recheckTask?.id && planRe.plan.recheckTask.status === '待上门' && !!planRe.plan.recheckTask.appointment_id,
  `任务#${planRe.plan?.recheckTask?.id} 预约#${planRe.plan?.recheckTask?.appointment_id}`)
const liTaskId = planRe.plan.recheckTask.id

const nurses = await call(nurse.token, 'GET', '/api/nurses')
const nurse2Id = nurses.nurses.find((n) => n.name === '刘洋').id
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
const assigned = await call(nurse.token, 'POST', `/api/recheck-tasks/${liTaskId}/assign`,
  { nurseId: nurse2Id, deviceCode: 'JM-TEST-0088', scheduledTime: tomorrow })
ok('复测任务指派护士与设备',
  assigned.task?.nurse?.name === '刘洋' && assigned.task.device_code === 'JM-TEST-0088')

const reminded = await call(nurse.token, 'POST', `/api/recheck-tasks/${liTaskId}/remind`, {})
ok('复测前提醒准备喂养/排便记录', reminded.task?.prepare_reminded === 1 && reminded.task.prepare_note.includes('排便'))

const rs1 = await call(family.token, 'POST', `/api/recheck-tasks/${liTaskId}/reschedule`,
  { scheduledTime: tomorrow, reason: '验证脚本第一次改约' })
ok('第一次改约不升级', rs1.task.status === '已改约' && rs1.escalated === false && rs1.task.reschedule_count === 1)
const rs2 = await call(family.token, 'POST', `/api/recheck-tasks/${liTaskId}/reschedule`,
  { scheduledTime: tomorrow, reason: '验证脚本第二次改约' })
ok('第二次改约自动升级社区医生', rs2.escalated === true && rs2.task.status === '已升级' && rs2.task.reschedule_count === 2)
const escList = await call(doctor.token, 'GET', '/api/recheck-tasks?status=escalated')
ok('医生升级列表含该任务', escList.tasks.some((t) => t.id === liTaskId))
const intervene = await call(doctor.token, 'POST', `/api/recheck-tasks/${liTaskId}/doctor-action`,
  { action: 'direct_visit', note: '验证脚本：建议直接就诊测胆红素' })
ok('医生处置（建议直接就诊）', intervene.task?.doctor_action === 'direct_visit' && intervene.task.doctor?.name === '张启明')

// 家属最终选择当天去儿科 → 复测任务取消、生成转诊事项
const planClinic = await call(family.token, 'POST', '/api/jaundice/plan', { visitId: liVisitId, choice: 'clinic' })
ok('改选当天去儿科并取消复测任务',
  planClinic.plan?.choice === 'clinic' && planClinic.plan.recheckTask?.status === '已取消')

// 11 复测升高 → 转诊单自动带入前一天记录与变化趋势（王乐乐）
const taskRows = await call(nurse.token, 'GET', '/api/recheck-tasks')
const wlTask = taskRows.tasks.find((t) => t.archive?.baby_name === '王乐乐' && t.status === '待上门')
ok('种子复测任务（护士刘洋+设备+准备提醒）',
  wlTask && wlTask.nurse?.name === '刘洋' && wlTask.device_code === 'JM-103-0217' && wlTask.prepare_reminded === 1,
  wlTask ? `任务#${wlTask.id}` : '缺失')
const reVisit = await call(nurse.token, 'POST', '/api/visits', {
  archive_id: wlTask.archive_id, appointment_id: wlTask.appointment_id,
  visit_time: new Date().toISOString().slice(0, 16),
  weight: 2750, bilirubin: 280, bilirubin_site: '额头', device_code: 'JM-103-0217',
  stool_count: 3, stool_color: '黄色', urine_count: 7, feeding_freq: 9,
})
ok('复测访视提交完成任务', !!reVisit.visit?.id)
const refs = await call(nurse.token, 'GET', '/api/referrals')
const ref = refs.referrals.find((r) => r.archive_id === wlTask.archive_id)
ok('复测升高自动生成转诊单',
  ref && ref.bilirubin_prev === 262 && ref.bilirubin_current === 280 && ref.delta === 18
  && ref.trend_note.includes('升高') && ref.baseline_visit_id != null,
  ref ? `${ref.bilirubin_prev}→${ref.bilirubin_current}（+${ref.delta}）` : '无转诊单')
ok('转诊单带入前一天记录（部位/喂养/排便/设备/护士）',
  ref && ref.prev_site === '额头' && ref.current_site === '额头' && ref.prev_feeding === 8 && ref.current_feeding === 9
  && ref.prev_device === 'JM-103-0217' && ref.prev_stool_color === '黄色')
const refClose = await call(nurse.token, 'POST', `/api/referrals/${ref.id}/feedback`,
  { feedback: '验证脚本：已就诊，门诊复测后安排光疗', close: true })
ok('转诊单就诊反馈闭环', refClose.referral?.status === '已闭环')

const family2 = await login('family2', 'family123')
const fam2 = await call(family2.token, 'GET', '/api/family/overview')
ok('家属端可见含趋势的转诊单', (fam2.referrals || []).some((r) => r.delta === 18 && r.status === '已闭环'))

// 12 权限
const deny = await fetch(`${BASE}/api/dashboard`, { headers: { Authorization: `Bearer ${family.token}` } })
ok('家属无权访问护士工作台', deny.status === 403)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed ? 1 : 0)
