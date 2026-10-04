// 端到端验证脚本：node scripts/verify.mjs（需服务已启动，默认 http://localhost:8080）
// 覆盖：登录、工作台、档案筛选、访视提交与风险结论、临界值四项必录、
//       家属三选择（复测/当天就诊/观察+风险告知）、复测任务（护士+设备+准备提醒）、
//       家属再次改约升级社区医生、医生干预决定、复测升高自动生成带前日记录的转诊单（趋势）、
//       离线同步幂等、未开门/改约、随访闭环、医生决策、家属端总览/材料/咨询、越权拦截
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
const callStatus = async (token, method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

console.log(`验证目标: ${BASE}`)

// 1 登录
const nurse = await login('nurse', 'nurse123')
const nurse2 = await login('nurse2', 'nurse123')
const doctor = await login('doctor', 'doctor123')
const family = await login('family', 'family123')
const family2 = await login('family2', 'family123')
ok('多角色登录', !!(nurse.token && doctor.token && family.token && family2.token), `${nurse.user.name}/${nurse2.user.name}/${doctor.user.name}`)

// 2 工作台（含新增复测统计）
const dash = await call(nurse.token, 'GET', '/api/dashboard')
ok('工作台统计', dash.stats.unvisited > 0 && dash.stats.openFollowups > 0,
  `未访视${dash.stats.unvisited} 黄疸异常${dash.stats.jaundiceAlerts} 待闭环${dash.stats.openFollowups}`)
ok('工作台临界值复测统计', dash.stats.recheckPending >= 2 && dash.stats.recheckEscalated >= 1 && dash.stats.referralsPending >= 1,
  `待处理${dash.stats.recheckPending} 已升级${dash.stats.recheckEscalated} 待就诊转诊单${dash.stats.referralsPending}`)

// 3 档案筛选
const all = await call(nurse.token, 'GET', '/api/archives')
const jaundice = await call(nurse.token, 'GET', '/api/archives?filter=jaundice')
const maternal = await call(nurse.token, 'GET', '/api/archives?filter=maternal')
ok('档案列表（11 份）', all.archives.length >= 11, `共 ${all.archives.length} 份`)
ok('异常黄疸筛选', jaundice.archives.length >= 2, jaundice.archives.map(a => a.baby_name).join('、'))
ok('产妇风险筛选', maternal.archives.length >= 1, maternal.archives.map(a => a.baby_name).join('、'))

// 4 种子：吴小满（体重降>10%+黄疸达阈值+设备故障）
const wu = all.archives.find(a => a.baby_name === '吴小满')
const wuDetail = await call(nurse.token, 'GET', `/api/archives/${wu.id}`)
const wuVisit = wuDetail.visits[0]
ok('种子风险结论（吴小满）',
  wuVisit.risk_level === '危急' && wuVisit.need_referral === 1 && wuVisit.device_issue === 1,
  `风险${wuVisit.risk_level} 设备${wuVisit.device_no}`)
ok('种子临界值四字段落库（吴小满）', !!wuVisit.device_no && !!wuVisit.doctor_advice, `医生建议已记录`)

// 5 种子：四个临界值复查场景
const seedTasks = await call(nurse.token, 'GET', '/api/rechecks')
const wang = seedTasks.tasks.find(t => t.baby_name === '王乐乐')
const lin = seedTasks.tasks.find(t => t.baby_name === '林小夏')
const zhou = seedTasks.tasks.find(t => t.baby_name === '周小川')
ok('种子：王乐乐待家属选择', wang?.status === '待选择' && wang.source_visit?.bilirubin === 262, `设备 ${wang?.device_no}`)
ok('种子：林小夏复测任务已明确护士+设备+准备提醒',
  lin?.status === '待复测' && lin.assign_nurse_name === '刘洋' && !!lin.device_no && lin.remind_prepared === 1,
  `${lin?.assign_nurse_name}/${lin?.device_no}`)
ok('种子：周小川再次改约已升级社区医生',
  zhou?.status === '已升级' && zhou.reschedule_count >= 1, `改约 ${zhou?.reschedule_count} 次`)
const seedRefs = await call(nurse.token, 'GET', '/api/referrals')
const he = seedRefs.referrals.find(r => r.baby_name === '何小禾')
ok('种子：何小禾复测升高转诊单带前日记录',
  he && he.bilirubin_prev === 260 && he.bilirubin_now === 295 && he.bilirubin_delta === 35 && he.previous_visit_id && he.current_visit_id,
  `${he?.bilirubin_prev}→${he?.bilirubin_now} 升高${he?.bilirubin_delta}`)

// 6 临界值访视四项必录（测量部位/设备编号/喂养情况/医生建议）
const sun = all.archives.find(a => a.baby_name === '孙果果') // 出生日龄 6 天，阈值 291，临界带 [257,291)
const badVisit = await callStatus(nurse.token, 'POST', '/api/visits', {
  archive_id: sun.id, visit_time: new Date().toISOString().slice(0, 16),
  bilirubin: 275, bilirubin_site: '额头', feeding_freq: 8,
})
ok('临界值缺设备编号/医生建议被拦截（400）', badVisit.status === 400, badVisit.body.error)
const nearVisit = await call(nurse.token, 'POST', '/api/visits', {
  archive_id: sun.id, visit_time: new Date().toISOString().slice(0, 16),
  weight: 3050, bilirubin: 275, bilirubin_site: '额头', device_no: 'JM-103-V1',
  doctor_advice: '张医生嘱：24小时内复测，加强喂养',
  cord: '干燥', stool_count: 3, stool_color: '黄色', urine_count: 7,
  feeding_type: '混合喂养', feeding_freq: 9, spit_up: '无', sleep: '正常',
  breast: '正常', mood: '平稳', care_ability: '良好',
})
ok('临界值访视提交成功并生成待选择复查任务',
  nearVisit.visit?.risk_level === '高' && nearVisit.recheckTask?.status === '待选择',
  `风险${nearVisit.visit?.risk_level} 任务#${nearVisit.recheckTask?.id}`)
const zhengTaskId = nearVisit.recheckTask.id

// 7 完整复测链路：护士代家属选择复测 → 安排护士+设备 → 复测黄疸下降 → 完成不转诊
await call(nurse.token, 'POST', `/api/rechecks/${zhengTaskId}/choice`, { choice: '复测' })
let t = (await call(nurse.token, 'GET', `/api/rechecks/${zhengTaskId}`)).task
ok('家属选择复测 → 任务进入待安排', t.status === '待安排' && t.family_choice === '复测')
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const assigned = await call(nurse2.token, 'POST', `/api/rechecks/${zhengTaskId}/assign`, {
  nurseId: nurse2.user.id, deviceNo: 'JM-103-V1', scheduledTime: `${tomorrow}T09:30`,
})
ok('安排复测：明确护士+设备+时间并生成预约',
  assigned.task.status === '待复测' && assigned.task.assign_nurse_name === '刘洋' &&
  assigned.task.device_no === 'JM-103-V1' && !!assigned.task.appointment_id)
const assignMissing = await callStatus(nurse.token, 'POST', `/api/rechecks/${zhengTaskId}/assign`, { deviceNo: '', scheduledTime: `${tomorrow}T09:30` })
ok('安排复测缺设备编号被拦截', assignMissing.status === 400)
const reminded = await call(nurse2.token, 'POST', `/api/rechecks/${zhengTaskId}/remind`, {})
ok('复测前提醒家属准备喂养/排便记录', reminded.task.remind_prepared === 1 && !!reminded.task.remind_at)

// 复测：黄疸较前日下降 → 完成，无新增转诊单
const downVisit = await call(nurse2.token, 'POST', '/api/visits', {
  archive_id: sun.id, appointment_id: assigned.task.appointment_id,
  visit_time: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
  weight: 3060, bilirubin: 210, bilirubin_site: '额头', device_no: 'JM-103-V1',
  doctor_advice: '复测明显下降，继续居家观察', feeding_type: '混合喂养', feeding_freq: 10,
  stool_count: 4, stool_color: '黄色', urine_count: 8,
})
const doneTask = (await call(nurse2.token, 'GET', `/api/rechecks/${zhengTaskId}`)).task
ok('复测完成（黄疸下降，不升转诊单）',
  downVisit.visit?.id && !downVisit.referral && doneTask.status === '已完成' && doneTask.recheck_visit_id === downVisit.visit.id,
  `任务状态 ${doneTask.status}`)

// 8 完整链路二：复测黄疸升高 → 自动转诊单带前一天记录
const chenmi = all.archives.find(a => a.baby_name === '陈小米')
const srcVisit = await call(nurse.token, 'POST', '/api/visits', {
  archive_id: chenmi.id, visit_time: new Date().toISOString().slice(0, 16),
  bilirubin: 258, bilirubin_site: '胸口', device_no: 'JM-103-V2',
  doctor_advice: '临界值，嘱次日复测', feeding_type: '配方奶喂养', feeding_freq: 8,
  stool_count: 2, stool_color: '黄色', urine_count: 6,
})
ok('第二次临界值访视（陈小米）', srcVisit.recheckTask?.status === '待选择')
const t2Id = srcVisit.recheckTask.id
await call(nurse.token, 'POST', `/api/rechecks/${t2Id}/choice`, { choice: '复测' })
const a2res = await call(nurse.token, 'POST', `/api/rechecks/${t2Id}/assign`, {
  nurseId: nurse.user.id, deviceNo: 'JM-103-V2', scheduledTime: `${tomorrow}T10:00`,
})
const upVisit = await call(nurse.token, 'POST', '/api/visits', {
  archive_id: chenmi.id, appointment_id: a2res.task.appointment_id,
  visit_time: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
  bilirubin: 294, bilirubin_site: '胸口', device_no: 'JM-103-V2',
  doctor_advice: '升高达阈值，立即转诊', feeding_type: '配方奶喂养', feeding_freq: 7,
  stool_count: 2, stool_color: '黄色', urine_count: 5,
})
ok('复测黄疸升高 → 自动生成带前日记录的转诊单',
  upVisit.referral && upVisit.referral.bilirubin_prev === 258 && upVisit.referral.bilirubin_now === 294 &&
  upVisit.referral.bilirubin_delta === 36 && upVisit.referral.previous_visit_id === srcVisit.visit.id,
  `趋势 ${upVisit.referral?.bilirubin_prev}→${upVisit.referral?.bilirubin_now}`)
ok('转诊单含喂养/体重趋势描述', upVisit.referral.trend_note.includes('配方奶喂养') && upVisit.referral.status === '待就诊')
const visitFb = await call(nurse.token, 'POST', `/api/referrals/${upVisit.referral.id}/visited`, { feedback: '已光疗，胆红素下降' })
ok('转诊单就诊反馈闭环', visitFb.referral.status === '已就诊')

// 9 家属（李安安）临界值：观察 → 风险告知 + 复查提醒
const liAnan = all.archives.find(a => a.baby_name === '李安安')
const liVisit = await call(nurse.token, 'POST', '/api/visits', {
  archive_id: liAnan.id, visit_time: new Date().toISOString().slice(0, 16),
  weight: 2900, bilirubin: 285, bilirubin_site: '额头', device_no: 'JM-103-F1',
  doctor_advice: '张医生嘱24小时复测，出现嗜睡拒奶立即就诊',
  cord: '渗液', stool_count: 2, stool_color: '黄色', urine_count: 5,
  feeding_type: '母乳喂养', feeding_freq: 6, spit_up: '频繁', sleep: '正常',
  breast: '涨奶', mood: '焦虑', care_ability: '一般',
})
ok('李安安临界值访视', liVisit.visit.risk_level === '高' && liVisit.recheckTask.status === '待选择')
const liFamOverview0 = await call(family.token, 'GET', '/api/family/overview')
ok('家属端总览含复查任务与转诊单', Array.isArray(liFamOverview0.recheckTasks) && Array.isArray(liFamOverview0.referrals))
const observe = await call(family.token, 'POST', `/api/rechecks/${liVisit.recheckTask.id}/choice`, { choice: '观察' })
ok('家属选观察 → 生成书面风险告知', observe.task.status === '观察中' && (observe.riskNotice || '').includes('黄疸临界值风险告知'))
const liFamOverview = await call(family.token, 'GET', '/api/family/overview')
const obsTask = liFamOverview.recheckTasks.find(x => x.id === liVisit.recheckTask.id)
ok('观察任务保留复查提醒（次日电话随访事项）',
  obsTask.status === '观察中' && !!obsTask.risk_notice && liFamOverview.followups.some(f => f.type === '电话随访'))
// 观察中可改选
const switchRe = await call(family.token, 'POST', `/api/rechecks/${liVisit.recheckTask.id}/choice`, { choice: '复测' })
ok('观察后可改选次日复测', switchRe.task.status === '待安排')
const forbid = await callStatus(family2.token, 'POST', `/api/rechecks/${liVisit.recheckTask.id}/choice`, { choice: '观察' })
ok('跨家庭操作复查任务被拒（403）', forbid.status === 403)

// 10 家属（王乐乐 family2）：复测 → 安排 → 家属再次改约 → 升级社区医生 → 医生决定
await call(family2.token, 'POST', `/api/rechecks/${wang.id}/choice`, { choice: '复测' })
const wangAssign = await call(nurse.token, 'POST', `/api/rechecks/${wang.id}/assign`, {
  nurseId: nurse.user.id, deviceNo: 'JM-103-002', scheduledTime: `${tomorrow}T09:00`,
})
ok('王乐乐复测任务已安排', wangAssign.task.status === '待复测' && !!wangAssign.task.appointment_id)
const resched = await call(family2.token, 'POST', `/api/appointments/${wangAssign.task.appointment_id}/reschedule`, {
  scheduledTime: `${tomorrow}T15:00`, reason: '白天家里没人',
})
ok('家属再次改约 → 任务自动升级社区医生', !!resched.escalated && resched.escalated.status === '已升级' && resched.escalated.reschedule_count === 1)
const docPhone = await call(doctor.token, 'POST', `/api/rechecks/${wang.id}/doctor-decide`, {
  decision: '电话干预', note: '电话劝说家属次日务必复测',
})
ok('社区医生电话干预决定', docPhone.task.status === '已升级' && docPhone.task.doctor_decision === '电话干预')
const docDirect = await call(doctor.token, 'POST', `/api/rechecks/${wang.id}/doctor-decide`, {
  decision: '建议直接就诊', note: '家属再次推迟复测，建议直接儿科就诊',
})
ok('社区医生改判建议直接就诊', docDirect.task.status === '已就诊')

// 11 离线同步幂等：同一 client_id 提交两次只落一条
const cid = `verify-${Date.now()}`
const syncBody = { visits: [{ client_id: cid, archive_id: liAnan.id, visit_time: new Date().toISOString().slice(0, 16), weight: 2910, bilirubin: 200, device_no: 'JM-103-OFF', feeding_type: '母乳喂养', feeding_freq: 8, stool_count: 3, stool_color: '黄色', urine_count: 7 }] }
const s1 = await call(nurse.token, 'POST', '/api/sync/visits', syncBody)
const s2 = await call(nurse.token, 'POST', '/api/sync/visits', syncBody)
ok('离线草稿同步', s1.results[0].ok === true, `visit#${s1.results[0].visit_id}`)
ok('同步幂等（重复 client_id 不产生重复记录）', s2.results[0].ok && s2.results[0].duplicated === true && s2.results[0].visit_id === s1.results[0].visit_id)

// 12 未开门 → 再次预约事项（避开复测预约，防止污染）
const appts = await call(nurse.token, 'GET', '/api/appointments?status=待访视')
const someAppt = appts.appointments.find(a => a.archive_id !== liAnan.id && !a.recheck_task_id)
if (someAppt) {
  await call(nurse.token, 'POST', `/api/appointments/${someAppt.id}/no-show`, { note: '验证脚本：无人应答' })
  const fu = await call(nurse.token, 'GET', '/api/followups')
  ok('未开门生成再次预约事项', fu.followups.some(f => f.type === '再次预约' && f.archive_id === someAppt.archive_id))
  const r2 = await call(nurse.token, 'POST', `/api/appointments/${someAppt.id}/reschedule`, { scheduledTime: '2099-01-01 09:00', reason: '验证脚本改约' })
  ok('护士改约（不触发升级）', r2.appointment.status === '待访视' && !r2.escalated)
} else ok('未开门/改约', false, '没有可用预约')

// 13 医生决策 + 闭环
const fus = await call(doctor.token, 'GET', '/api/followups')
const openOne = fus.followups.find(f => f.status !== '已闭环')
const dec = await call(doctor.token, 'POST', `/api/followups/${openOne.id}/decide`, { decision: '电话随访', note: '验证脚本：先电话随访观察' })
ok('医生常规随访决策', dec.ok === true)

// 14 家属材料 + 咨询 + 护士回复
const doc = await call(family.token, 'POST', '/api/documents', { type: '喂养记录', filename: 'verify.jpg', note: '验证脚本上传' })
ok('家属补充材料', !!doc.document?.id)
const con = await call(family.token, 'POST', '/api/consults', { question: '验证脚本：宝宝可以晒太阳吗？' })
ok('家属线上咨询', !!con.consult?.id)
const reply = await call(nurse.token, 'POST', `/api/consults/${con.consult.id}/reply`, { reply: '可以，避开正午，每次15分钟左右。' })
ok('护士回复咨询并闭环', reply.consult.status === '已回复')

// 15 权限
const deny = await fetch(`${BASE}/api/dashboard`, { headers: { Authorization: `Bearer ${family.token}` } })
ok('家属无权访问护士工作台（403）', deny.status === 403)
const deny2 = await fetch(`${BASE}/api/rechecks`, { headers: { Authorization: `Bearer ${family.token}` } })
ok('家属无权列出全部复查任务（403）', deny2.status === 403)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed ? 1 : 0)
