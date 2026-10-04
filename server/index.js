// 社区新生儿上门访视与黄疸随访 - API 服务
import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import db, { addEvent } from './db.js'
import { seed } from './seed.js'
import {
  createVisit, closeFollowup,
  getRecheckTask, listRecheckTasks, familyChooseRecheck, assignRecheckTask,
  markRecheckReminder, escalateRecheckOnReschedule, doctorRecheckDecision,
  markReferralVisited, listReferrals,
} from './service.js'
import { assessVisit } from './risk.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '10mb' }))

seed() // 首次启动自动写入演示数据

const hash = (s) => createHash('sha256').update('nbv:' + s).digest('hex')

// ---------- 鉴权 ----------
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const row = token && db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(token)
  if (!row) return res.status(401).json({ error: '未登录或会话已过期' })
  req.user = row
  next()
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: '无权访问' })

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  const user = db.prepare('SELECT * FROM users WHERE username=? AND password_hash=?').get(String(username || ''), hash(String(password || '')))
  if (!user) return res.status(401).json({ error: '用户名或密码错误' })
  const token = randomBytes(24).toString('hex')
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)').run(token, user.id)
  res.json({ token, user: pubUser(user) })
})
app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id)
  res.json({ ok: true })
})
app.get('/api/me', auth, (req, res) => res.json({ user: pubUser(req.user) }))
const pubUser = (u) => ({ id: u.id, username: u.username, role: u.role, name: u.name, title: u.title, phone: u.phone })

// ---------- 工作台 ----------
app.get('/api/dashboard', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const today = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
  const appts = db.prepare(`
    SELECT a.*, ar.mother_name, ar.baby_name, ar.birth_date, ar.address, ar.contact_name, ar.contact_phone, ar.jaundice_risk
    FROM appointments a JOIN archives ar ON ar.id=a.archive_id
    WHERE a.status='待访视' AND date(a.scheduled_time) <= date(?) ORDER BY a.scheduled_time`).all(todayStr + ' 23:59')
  const openFollowups = db.prepare(`SELECT * FROM followups WHERE status!='已闭环'`).all()
  const byType = {}
  for (const f of openFollowups) byType[f.type] = (byType[f.type] || 0) + 1
  const cnt = (sql, ...args) => db.prepare(sql).get(...args).c
  res.json({
    stats: {
      unvisited: appts.length,
      jaundiceAlerts: cnt(`SELECT COUNT(DISTINCT archive_id) c FROM followups WHERE status!='已闭环' AND type IN ('复查','转诊')`),
      maternalRisks: cnt(`SELECT COUNT(DISTINCT archive_id) c FROM followups WHERE status!='已闭环' AND type='电话随访'`),
      openFollowups: openFollowups.length,
      todayAppointments: cnt(`SELECT COUNT(*) c FROM appointments WHERE date(scheduled_time)=date(?) AND status='待访视'`, todayStr + ' 12:00'),
      recheckPending: cnt(`SELECT COUNT(*) c FROM recheck_tasks WHERE status IN ('待选择','待安排','待复测','观察中')`),
      recheckEscalated: cnt(`SELECT COUNT(*) c FROM recheck_tasks WHERE status='已升级'`),
      referralsPending: cnt(`SELECT COUNT(*) c FROM referrals WHERE status='待就诊'`),
    },
    followupsByType: byType,
    todayAppointments: appts,
    recentHighRiskVisits: db.prepare(`
      SELECT v.id, v.visit_time, v.risk_level, v.bilirubin, v.weight, ar.id archive_id, ar.mother_name, ar.baby_name
      FROM visits v JOIN archives ar ON ar.id=v.archive_id
      WHERE v.risk_level IN ('高','危急') ORDER BY v.created_at DESC LIMIT 8`).all(),
  })
})

// ---------- 预约 ----------
app.get('/api/appointments', auth, (req, res) => {
  const { status } = req.query
  let rows
  if (req.user.role === 'family') {
    rows = db.prepare(`SELECT a.*, ar.mother_name, ar.baby_name, ar.address FROM appointments a
      JOIN archives ar ON ar.id=a.archive_id WHERE ar.family_user_id=? ORDER BY a.scheduled_time DESC`).all(req.user.id)
  } else {
    rows = status
      ? db.prepare(`SELECT a.*, ar.mother_name, ar.baby_name, ar.address, ar.contact_name, ar.contact_phone, ar.jaundice_risk
                    FROM appointments a JOIN archives ar ON ar.id=a.archive_id WHERE a.status=? ORDER BY a.scheduled_time`).all(status)
      : db.prepare(`SELECT a.*, ar.mother_name, ar.baby_name, ar.address, ar.contact_name, ar.contact_phone, ar.jaundice_risk
                    FROM appointments a JOIN archives ar ON ar.id=a.archive_id ORDER BY a.scheduled_time DESC LIMIT 100`).all()
  }
  res.json({ appointments: rows })
})

app.post('/api/appointments', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const { archiveId, scheduledTime, type = '加访', reason = '' } = req.body || {}
  if (!archiveId || !scheduledTime) return res.status(400).json({ error: '缺少档案或时间' })
  const info = db.prepare(`INSERT INTO appointments (archive_id, nurse_id, type, scheduled_time, reason) VALUES (?,?,?,?,?)`)
    .run(archiveId, req.user.id, type, String(scheduledTime).replace('T', ' '), reason)
  addEvent(archiveId, '预约', `新增${type}预约`, `时间 ${scheduledTime}`, req.user.name)
  res.json({ appointment: db.prepare('SELECT * FROM appointments WHERE id=?').get(info.lastInsertRowid) })
})

app.post('/api/appointments/:id/reschedule', auth, (req, res) => {
  const appt = db.prepare('SELECT a.*, ar.family_user_id FROM appointments a JOIN archives ar ON ar.id=a.archive_id WHERE a.id=?').get(req.params.id)
  if (!appt) return res.status(404).json({ error: '预约不存在' })
  if (req.user.role === 'family' && appt.family_user_id !== req.user.id) return res.status(403).json({ error: '无权操作' })
  const { scheduledTime, reason = '' } = req.body || {}
  if (!scheduledTime) return res.status(400).json({ error: '缺少新的预约时间' })
  const t = String(scheduledTime).replace('T', ' ')
  db.prepare(`UPDATE appointments SET scheduled_time=?, status='待访视', reason=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(t, reason || appt.reason, appt.id)
  addEvent(appt.archive_id, '改约', `预约改期至 ${t}`, reason, req.user.name)
  // 家属再次改约黄疸复测预约 → 自动升级社区医生（电话干预 / 建议直接就诊）
  let escalated = null
  if (req.user.role === 'family' && appt.recheck_task_id) {
    escalated = escalateRecheckOnReschedule(appt.id, reason || '家属申请改期', req.user.name)
  }
  res.json({ appointment: db.prepare('SELECT * FROM appointments WHERE id=?').get(appt.id), escalated })
})

app.post('/api/appointments/:id/no-show', auth, requireRole('nurse'), (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id)
  if (!appt) return res.status(404).json({ error: '预约不存在' })
  const note = req.body?.note || '上门无人应答'
  db.prepare(`UPDATE appointments SET status='未开门', reason=?, updated_at=datetime('now','localtime') WHERE id=?`).run(note, appt.id)
  db.prepare(`INSERT INTO followups (archive_id, type, title, detail, created_by) VALUES (?,?,?,?,?)`)
    .run(appt.archive_id, '再次预约', '家属未开门，需再次预约上门', note, req.user.name)
  addEvent(appt.archive_id, '未开门', '上门访视家属未开门', note, req.user.name)
  res.json({ ok: true })
})

// ---------- 母婴档案 ----------
app.get('/api/archives', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const { filter, q } = req.query
  let rows = db.prepare(`
    SELECT ar.*,
      (SELECT COUNT(*) FROM appointments a WHERE a.archive_id=ar.id AND a.status='待访视') pending_appts,
      (SELECT COUNT(*) FROM followups f WHERE f.archive_id=ar.id AND f.status!='已闭环') open_followups,
      (SELECT v.risk_level FROM visits v WHERE v.archive_id=ar.id ORDER BY v.visit_time DESC LIMIT 1) last_risk,
      (SELECT v.bilirubin FROM visits v WHERE v.archive_id=ar.id ORDER BY v.visit_time DESC LIMIT 1) last_bilirubin,
      (SELECT MIN(a.scheduled_time) FROM appointments a WHERE a.archive_id=ar.id AND a.status='待访视') next_appt
    FROM archives ar ORDER BY ar.created_at DESC`).all()
  if (q) {
    const s = String(q).toLowerCase()
    rows = rows.filter(r => [r.mother_name, r.baby_name, r.address, r.contact_phone].join(' ').toLowerCase().includes(s))
  }
  if (filter === 'unvisited') rows = rows.filter(r => r.pending_appts > 0)
  if (filter === 'jaundice') rows = rows.filter(r => r.last_bilirubin != null && ['高', '危急'].includes(r.last_risk))
  if (filter === 'maternal') rows = rows.filter(r =>
    db.prepare(`SELECT COUNT(*) c FROM followups WHERE archive_id=? AND status!='已闭环' AND type='电话随访'`).get(r.id).c > 0)
  if (filter === 'unclosed') rows = rows.filter(r => r.open_followups > 0)
  res.json({ archives: rows })
})

app.get('/api/archives/:id', auth, (req, res) => {
  const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(req.params.id)
  if (!archive) return res.status(404).json({ error: '档案不存在' })
  if (req.user.role === 'family' && archive.family_user_id !== req.user.id) return res.status(403).json({ error: '无权访问' })
  const visits = db.prepare('SELECT * FROM visits WHERE archive_id=? ORDER BY visit_time DESC').all(archive.id)
    .map(v => ({ ...v, flags: JSON.parse(v.flags || '[]'), photos: JSON.parse(v.photos || '[]') }))
  res.json({
    archive,
    appointments: db.prepare(`
      SELECT a.*, u.name nurse_name, t.assign_nurse_id AS task_nurse_id, t.device_no AS task_device_no,
             nu.name AS assign_nurse_name
      FROM appointments a
      LEFT JOIN users u ON u.id=a.nurse_id
      LEFT JOIN recheck_tasks t ON t.id=a.recheck_task_id
      LEFT JOIN users nu ON nu.id=t.assign_nurse_id
      WHERE a.archive_id=? ORDER BY a.scheduled_time DESC`).all(archive.id),
    visits,
    followups: db.prepare('SELECT * FROM followups WHERE archive_id=? ORDER BY created_at DESC').all(archive.id),
    documents: db.prepare('SELECT id, archive_id, type, filename, data_url, note, created_at FROM documents WHERE archive_id=? ORDER BY created_at DESC').all(archive.id),
    consults: db.prepare('SELECT * FROM consults WHERE archive_id=? ORDER BY created_at DESC').all(archive.id),
    events: db.prepare('SELECT * FROM events WHERE archive_id=? ORDER BY created_at DESC, id DESC LIMIT 100').all(archive.id),
    recheckTasks: listRecheckTasks('all').filter((t) => t.archive_id === archive.id)
      .map((t) => getRecheckTask(t.id)),
    referrals: listReferrals(archive.id),
  })
})

// ---------- 访视 ----------
app.post('/api/visits/assess', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(req.body?.archive_id)
  if (!archive) return res.status(404).json({ error: '档案不存在' })
  res.json({ assessment: assessVisit(archive, { ...req.body, visit_time: req.body.visit_time || new Date().toISOString() }) })
})

app.post('/api/visits', auth, requireRole('nurse'), (req, res) => {
  try {
    const result = createVisit(req.body || {}, req.user)
    res.status(result.duplicated ? 200 : 201).json(result)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 离线草稿批量同步（幂等：client_id 去重）
app.post('/api/sync/visits', auth, requireRole('nurse'), (req, res) => {
  const items = Array.isArray(req.body?.visits) ? req.body.visits : []
  const results = items.map(item => {
    try {
      const r = createVisit({ ...item, created_offline: 1 }, req.user)
      return { client_id: item.client_id, ok: true, duplicated: r.duplicated, visit_id: r.visit.id }
    } catch (e) {
      return { client_id: item.client_id, ok: false, error: e.message }
    }
  })
  res.json({ results })
})

// ---------- 随访闭环 ----------
app.get('/api/followups', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const openOnly = req.query.status !== 'all'
  const rows = db.prepare(`
    SELECT f.*, ar.mother_name, ar.baby_name, ar.birth_date, ar.address, ar.contact_name, ar.contact_phone
    FROM followups f JOIN archives ar ON ar.id=f.archive_id
    ${openOnly ? `WHERE f.status!='已闭环'` : ''}
    ORDER BY CASE f.status WHEN '待处理' THEN 0 WHEN '进行中' THEN 1 ELSE 2 END, f.created_at DESC`).all()
  res.json({ followups: rows })
})

app.post('/api/followups/:id/close', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const f = closeFollowup(Number(req.params.id), req.user.name, req.body?.note || '')
  if (!f) return res.status(404).json({ error: '随访事项不存在' })
  res.json({ followup: f })
})

// 社区医生决策：复查 / 转诊 / 电话随访 / 母乳指导 / 继续观察
app.post('/api/followups/:id/decide', auth, requireRole('doctor', 'nurse'), (req, res) => {
  const f = db.prepare('SELECT * FROM followups WHERE id=?').get(req.params.id)
  if (!f) return res.status(404).json({ error: '随访事项不存在' })
  const { decision, note = '', dueDate } = req.body || {}
  const valid = ['复查', '转诊', '电话随访', '母乳指导', '继续观察']
  if (!valid.includes(decision)) return res.status(400).json({ error: '无效决策' })
  addEvent(f.archive_id, '决策', `医生决策：${decision}`, note || `针对【${f.type}】${f.title}`, req.user.name)
  closeFollowup(f.id, req.user.name, `医生决策：${decision}${note ? ' - ' + note : ''}`)
  if (decision !== '继续观察') {
    db.prepare(`INSERT INTO followups (archive_id, visit_id, type, title, detail, due_date, created_by)
                VALUES (?,?,?,?,?,?,?)`)
      .run(f.archive_id, f.visit_id, decision, `医生决策：${decision}`, note || `来源：【${f.type}】${f.title}`,
        dueDate || null, req.user.name)
    if (decision === '复查' && dueDate) {
      db.prepare(`INSERT INTO appointments (archive_id, nurse_id, type, scheduled_time, reason) VALUES (?,?,?,?,?)`)
        .run(f.archive_id, null, '复查', `${dueDate} 09:00`, '医生决策安排')
    }
  }
  res.json({ ok: true })
})

// ---------- 家属端 ----------
app.get('/api/family/overview', auth, requireRole('family'), (req, res) => {
  const archive = db.prepare('SELECT * FROM archives WHERE family_user_id=?').get(req.user.id)
  if (!archive) return res.status(404).json({ error: '未关联母婴档案' })
  const visits = db.prepare('SELECT * FROM visits WHERE archive_id=? ORDER BY visit_time DESC').all(archive.id)
    .map(v => ({ ...v, flags: JSON.parse(v.flags || '[]'), photos: JSON.parse(v.photos || '[]') }))
  const followups = db.prepare(`SELECT * FROM followups WHERE archive_id=? AND status!='已闭环' ORDER BY created_at DESC`).all(archive.id)
  const nextAppt = db.prepare(`SELECT * FROM appointments WHERE archive_id=? AND status='待访视' ORDER BY scheduled_time LIMIT 1`).get(archive.id)
  res.json({
    archive, visits, followups, nextAppointment: nextAppt || null,
    appointments: db.prepare(`
      SELECT a.*, t.assign_nurse_id, nu.name AS assign_nurse_name, t.device_no
      FROM appointments a
      LEFT JOIN recheck_tasks t ON t.id=a.recheck_task_id
      LEFT JOIN users nu ON nu.id=t.assign_nurse_id
      WHERE a.archive_id=? ORDER BY a.scheduled_time DESC`).all(archive.id),
    documents: db.prepare('SELECT id, type, filename, data_url, note, created_at FROM documents WHERE archive_id=? ORDER BY created_at DESC').all(archive.id),
    consults: db.prepare('SELECT * FROM consults WHERE archive_id=? ORDER BY created_at DESC').all(archive.id),
    recheckTasks: listRecheckTasks('all').filter((t) => t.archive_id === archive.id).map((t) => getRecheckTask(t.id)),
    referrals: listReferrals(archive.id),
  })
})

app.post('/api/documents', auth, (req, res) => {
  const { type, filename, dataUrl = '', note = '' } = req.body || {}
  if (!type || !filename) return res.status(400).json({ error: '缺少材料类型或文件名' })
  let archiveId = req.body.archiveId
  if (req.user.role === 'family') {
    const arch = db.prepare('SELECT id FROM archives WHERE family_user_id=?').get(req.user.id)
    if (!arch) return res.status(404).json({ error: '未关联母婴档案' })
    archiveId = arch.id
  }
  if (!archiveId) return res.status(400).json({ error: '缺少档案' })
  if (dataUrl && dataUrl.length > 6_000_000) return res.status(413).json({ error: '文件过大（限 4MB 左右）' })
  const info = db.prepare('INSERT INTO documents (archive_id, uploader_id, type, filename, data_url, note) VALUES (?,?,?,?,?,?)')
    .run(archiveId, req.user.id, type, filename, dataUrl, note)
  addEvent(archiveId, '材料', `补充材料：${type}`, filename, req.user.name)
  res.status(201).json({ document: db.prepare('SELECT id, type, filename, note, created_at FROM documents WHERE id=?').get(info.lastInsertRowid) })
})

app.post('/api/consults', auth, requireRole('family'), (req, res) => {
  const question = String(req.body?.question || '').trim()
  if (!question) return res.status(400).json({ error: '请填写咨询内容' })
  const arch = db.prepare('SELECT id FROM archives WHERE family_user_id=?').get(req.user.id)
  if (!arch) return res.status(404).json({ error: '未关联母婴档案' })
  const info = db.prepare('INSERT INTO consults (archive_id, user_id, question) VALUES (?,?,?)').run(arch.id, req.user.id, question)
  db.prepare(`INSERT INTO followups (archive_id, type, title, detail, created_by) VALUES (?,?,?,?,?)`)
    .run(arch.id, '线上咨询', '家属线上咨询待回复', question, req.user.name)
  addEvent(arch.id, '咨询', '家属发起线上咨询', question, req.user.name)
  res.status(201).json({ consult: db.prepare('SELECT * FROM consults WHERE id=?').get(info.lastInsertRowid) })
})

app.post('/api/consults/:id/reply', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const c = db.prepare('SELECT * FROM consults WHERE id=?').get(req.params.id)
  if (!c) return res.status(404).json({ error: '咨询不存在' })
  const reply = String(req.body?.reply || '').trim()
  if (!reply) return res.status(400).json({ error: '请填写回复内容' })
  db.prepare(`UPDATE consults SET status='已回复', reply=?, replied_by=?, replied_at=datetime('now','localtime') WHERE id=?`)
    .run(reply, req.user.name, c.id)
  const f = db.prepare(`SELECT * FROM followups WHERE archive_id=? AND type='线上咨询' AND status!='已闭环'`).get(c.archive_id)
  if (f) closeFollowup(f.id, req.user.name, `已回复咨询 #${c.id}`)
  addEvent(c.archive_id, '咨询', '回复线上咨询', reply, req.user.name)
  res.json({ consult: db.prepare('SELECT * FROM consults WHERE id=?').get(c.id) })
})

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

// ---------- 黄疸临界值复查流程 ----------
function taskOwnedByFamily(task, userId) {
  const arch = db.prepare('SELECT family_user_id FROM archives WHERE id=?').get(task.archive_id)
  return arch && arch.family_user_id === userId
}

app.get('/api/rechecks', auth, requireRole('nurse', 'doctor'), (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'open'
  res.json({ tasks: listRecheckTasks(scope).map((t) => getRecheckTask(t.id)) })
})

app.get('/api/rechecks/:id', auth, (req, res) => {
  const t = getRecheckTask(Number(req.params.id))
  if (!t) return res.status(404).json({ error: '复查任务不存在' })
  if (req.user.role === 'family' && !taskOwnedByFamily(t, req.user.id)) return res.status(403).json({ error: '无权访问' })
  res.json({ task: t })
})

// 家属选择：次日复测 / 当天去儿科 / 居家观察（护士也可代家属登记）
app.post('/api/rechecks/:id/choice', auth, (req, res) => {
  const t = getRecheckTask(Number(req.params.id))
  if (!t) return res.status(404).json({ error: '复查任务不存在' })
  if (req.user.role === 'family' && !taskOwnedByFamily(t, req.user.id)) return res.status(403).json({ error: '无权操作' })
  try {
    const out = familyChooseRecheck(t.id, req.body?.choice, req.user.name)
    res.status(201).json(out)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 安排复测任务：明确护士 + 设备 + 时间
app.post('/api/rechecks/:id/assign', auth, requireRole('nurse', 'doctor'), (req, res) => {
  try {
    const out = assignRecheckTask(Number(req.params.id), {
      nurseId: req.body?.nurseId || req.user.id,
      deviceNo: req.body?.deviceNo,
      scheduledTime: req.body?.scheduledTime,
    }, req.user.name)
    res.status(201).json(out)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 复测前提醒家属准备喂养与排便记录
app.post('/api/rechecks/:id/remind', auth, requireRole('nurse', 'doctor'), (req, res) => {
  try {
    res.json(markRecheckReminder(Number(req.params.id), req.user.name))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 社区医生对升级任务的判断
app.post('/api/rechecks/:id/doctor-decide', auth, requireRole('doctor', 'nurse'), (req, res) => {
  try {
    const out = doctorRecheckDecision(Number(req.params.id), req.body?.decision, req.body?.note, req.user.name)
    res.json(out)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 护士花名册（安排复测护士时选择）
app.get('/api/nurses', auth, requireRole('nurse', 'doctor'), (req, res) => {
  res.json({ nurses: db.prepare(`SELECT id, name, title, phone FROM users WHERE role='nurse' ORDER BY id`).all() })
})

// ---------- 转诊单 ----------
app.get('/api/referrals', auth, requireRole('nurse', 'doctor'), (req, res) => {
  res.json({ referrals: listReferrals() })
})

app.post('/api/referrals/:id/visited', auth, requireRole('nurse', 'doctor'), (req, res) => {
  try {
    const r = markReferralVisited(Number(req.params.id), req.body?.feedback || '', req.user.name)
    res.json({ referral: r })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// ---------- 生产模式：托管前端构建产物 ----------
const dist = path.join(__dirname, '..', 'client', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (req, res, next) => (req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html'))))
}

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`✔ 服务已启动: http://localhost:${PORT}`))
