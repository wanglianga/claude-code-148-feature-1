// 黄疸临界值复查任务中心（护士/社区医生）
// 待选择 → 安排护士+设备生成复测任务 → 复测前提醒 → 完成复测；再次改约 → 已升级 → 社区医生判断
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import type { RecheckTask, Referral } from '../../types'
import { Badge, Empty, Modal, RiskBadge, fmtTime, toast } from '../../components/ui'
import { useAuth } from '../../store/auth'

const STATUS_COLOR: Record<string, string> = {
  待选择: 'amber', 待安排: 'teal', 待复测: 'teal', 观察中: 'amber', 已升级: 'red', 已完成: 'green', 已就诊: 'coral', 已取消: 'gray',
}

export default function Rechecks({ doctor }: { doctor?: boolean }) {
  const [tasks, setTasks] = useState<RecheckTask[]>([])
  const [referrals, setReferrals] = useState<Referral[]>([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const user = useAuth((s) => s.user)
  const isDoctor = doctor || user?.role === 'doctor'
  const nav = useNavigate()

  function load() {
    setLoading(true)
    Promise.all([
      api.get<{ tasks: RecheckTask[] }>(`/api/rechecks${showAll ? '?scope=all' : ''}`),
      api.get<{ referrals: Referral[] }>('/api/referrals').catch(() => ({ referrals: [] })),
    ]).then(([t, r]) => { setTasks(t.tasks); setReferrals(r.referrals) }).finally(() => setLoading(false))
  }
  useEffect(load, [showAll])

  return (
    <div>
      <div className="page-title">{isDoctor ? '黄疸复测 · 升级判断' : '黄疸临界值复查'}</div>
      <div className="page-sub">
        接近转诊阈值：家属选择次日复测/当天就诊/居家观察；复测任务明确护士与设备，复测前提醒家属备好喂养与排便记录；再次改约自动升级社区医生
      </div>
      <div className="tabs">
        <div className={`tab ${!showAll ? 'on' : ''}`} onClick={() => setShowAll(false)}>进行中</div>
        <div className={`tab ${showAll ? 'on' : ''}`} onClick={() => setShowAll(true)}>全部记录</div>
      </div>

      {loading && <Empty text="加载中…" icon="⏳" />}
      {!loading && tasks.length === 0 && <Empty text="暂无临界值复查任务" icon="🌿" />}
      {tasks.map((t) => (
        <TaskCard key={t.id} t={t} isDoctor={!!isDoctor} onChanged={load}
          onVisit={() => t.appointment_id
            ? nav(`/nurse/visit/new?appointmentId=${t.appointment_id}&archiveId=${t.archive_id}`)
            : nav(`/nurse/visit/new?archiveId=${t.archive_id}`)}
          onArchive={() => nav(`/nurse/archives/${t.archive_id}`)}
        />
      ))}

      <div className="card">
        <div className="card-title"><span className="dot" style={{ background: 'var(--red)' }} />转诊单（复测升高自动生成，附变化趋势）</div>
        {referrals.length === 0 && <div className="small muted">暂无转诊单</div>}
        {referrals.map((r) => <ReferralRow key={r.id} r={r} onChanged={load} />)}
      </div>
    </div>
  )
}

function TaskCard({ t, isDoctor, onChanged, onVisit, onArchive }: {
  t: RecheckTask; isDoctor: boolean; onChanged: () => void; onVisit: () => void; onArchive: () => void
}) {
  const [assign, setAssign] = useState(false)
  const [docDecide, setDocDecide] = useState(false)
  const v = t.source_visit
  const chosen = t.family_choice

  return (
    <div className="card" style={t.status === '已升级' ? { borderColor: 'var(--red)' } : undefined}>
      <div className="row between">
        <span className="strong" onClick={onArchive} style={{ cursor: 'pointer' }}>
          {t.mother_name} · {t.baby_name}
        </span>
        <Badge color={STATUS_COLOR[t.status] || 'gray'}>{t.status}</Badge>
      </div>
      <div className="small muted mt8">📍 {t.address} · 📞 {t.contact_name} {t.contact_phone}</div>

      {v && (
        <div className="card-inner-box mt8">
          <div className="row between">
            <span className="small strong">临界值访视（{fmtTime(v.visit_time)}）</span>
            <RiskBadge level={v.risk_level} />
          </div>
          <div className="grid2 small mt8">
            <div>🟡 黄疸 <b>{v.bilirubin} µmol/L</b>（{v.bilirubin_site}）</div>
            <div>📟 设备 {v.device_no || '未记录'}</div>
            <div>喂养 {v.feeding_type} {v.feeding_freq} 次/日</div>
            <div>大便 {v.stool_count} 次（{v.stool_color}）</div>
          </div>
          {v.doctor_advice && <div className="small mt8" style={{ color: 'var(--teal)' }}>🩺 医生建议：{v.doctor_advice}</div>}
          <div className="small muted mt8">应复查日期：{t.due_date}</div>
        </div>
      )}

      {/* 待家属选择 / 家属已选复测待安排 / 观察中 */}
      {(t.status === '待选择' || t.status === '待安排' || t.status === '观察中') && (
        <div className="mt8">
          <div className="small mb8">
            家属选择：<b>{chosen || '尚未选择'}</b>
            {t.status === '待安排' && <> · 等待安排上门护士与设备</>}
            {t.status === '观察中' && <> · 已生成复查提醒与风险告知</>}
          </div>
          {!isDoctor && (
            <div className="row wrap">
              {(!chosen || chosen === '复测') && <button className="btn teal sm" onClick={() => setAssign(true)}>
                {t.status === '待安排' ? '安排复测（护士+设备）' : '安排复测（护士+设备）'}
              </button>}
              {t.status !== '待安排' && <button className="btn ghost sm" onClick={() => proxyChoice(t.id, '当天就诊', onChanged)}>代登记：当天就诊</button>}
              {t.status === '待选择' && <button className="btn ghost sm" onClick={() => proxyChoice(t.id, '观察', onChanged)}>代登记：居家观察</button>}
            </div>
          )}
          {t.status === '观察中' && t.risk_notice && (
            <pre className="risk-notice mt8">{t.risk_notice}</pre>
          )}
        </div>
      )}

      {/* 已安排复测 */}
      {t.status === '待复测' && (
        <div className="mt8">
          <dl className="kv">
            <dt>上门护士</dt><dd>{t.assign_nurse_name || '待安排'}</dd>
            <dt>携带设备</dt><dd>📟 {t.device_no}</dd>
            <dt>改约次数</dt><dd>{t.reschedule_count} 次</dd>
          </dl>
          <div className="small mb8">
            准备提醒：{t.remind_prepared
              ? <span style={{ color: 'var(--green)' }}>已于 {fmtTime(t.remind_at)} 提醒家属准备喂养/排便记录 ✔</span>
              : <span className="muted">尚未提醒</span>}
          </div>
          {!isDoctor && (
            <div className="row wrap">
              <button className="btn primary sm" onClick={onVisit}>开始复测访视</button>
              <button className="btn teal sm" disabled={!!t.remind_prepared}
                onClick={() => api.post(`/api/rechecks/${t.id}/remind`).then(() => { toast('已记录：复测前提醒已发送'); onChanged() }).catch((e) => toast(e.message))}>
                {t.remind_prepared ? '已提醒' : '复测前提醒（喂养/排便记录）'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 再次改约 → 升级社区医生 */}
      {t.status === '已升级' && (
        <div className="escalated-banner mt8">
          <b>家属第 {t.reschedule_count} 次改约，已升级社区医生。</b><br />
          请判断：电话干预劝说按时复测，或建议直接到儿科/急诊就诊。
          <div className="row wrap mt8">
            {isDoctor && <button className="btn primary sm" onClick={() => setDocDecide(true)}>社区医生判断</button>}
            {!isDoctor && (
              <>
                <span className="small muted">等待社区医生处理</span>
                <button className="btn ghost sm" onClick={() => api.post(`/api/rechecks/${t.id}/remind`).then(() => onChanged()).catch(() => {})}>补记准备提醒</button>
              </>
            )}
          </div>
          {t.doctor_decision && <div className="small mt8">🩺 已判断：{t.doctor_decision}{t.doctor_note ? `（${t.doctor_note}）` : ''}</div>}
        </div>
      )}

      {t.status === '已完成' && t.recheck_visit_id && (
        <div className="small mt8" style={{ color: 'var(--green)' }}>✔ 复测访视 #{t.recheck_visit_id} 已完成，趋势已自动比对。</div>
      )}
      {t.status === '已就诊' && <div className="small mt8" style={{ color: 'var(--teal)' }}>家属已（选择）当天前往儿科就诊，待就诊反馈。</div>}

      {assign && <AssignModal t={t} onClose={() => setAssign(false)} onDone={() => { setAssign(false); onChanged(); toast('复测任务已生成，家属端可见护士与设备安排') }} />}
      {docDecide && <DoctorModal t={t} onClose={() => setDocDecide(false)} onDone={() => { setDocDecide(false); onChanged(); toast('已记录社区医生判断') }} />}
    </div>
  )
}

async function proxyChoice(taskId: number, choice: string, reload: () => void) {
  if (!window.confirm(`确认代家属登记「${choice}」？`)) return
  try {
    await api.post(`/api/rechecks/${taskId}/choice`, { choice })
    toast('已登记家属选择')
    reload()
  } catch (e: any) { toast(e.message) }
}

function AssignModal({ t, onClose, onDone }: { t: RecheckTask; onClose: () => void; onDone: () => void }) {
  const [nurses, setNurses] = useState<{ id: number; name: string }[]>([])
  const [nurseId, setNurseId] = useState<number | ''>('')
  const [deviceNo, setDeviceNo] = useState(t.device_no || '')
  const [time, setTime] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<{ nurses: { id: number; name: string; title: string }[] }>('/api/nurses').then((r) => {
      setNurses(r.nurses)
      setNurseId(r.nurses[0]?.id ?? '')
    })
    const d = new Date()
    d.setDate(d.getDate() + 1)
    const p = (n: number) => String(n).padStart(2, '0')
    setTime(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`)
  }, [])

  async function ok() {
    if (!deviceNo.trim()) return toast('请填写复测携带的设备编号')
    if (!time) return toast('请选择上门时间')
    setBusy(true)
    try {
      await api.post(`/api/rechecks/${t.id}/assign`, { nurseId: nurseId || undefined, deviceNo, scheduledTime: time })
      onDone()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title={`安排次日复测 - ${t.mother_name}家 ${t.baby_name}`} onClose={onClose}>
      <div className="field">
        <label>上门护士 *</label>
        <select value={nurseId} onChange={(e) => setNurseId(Number(e.target.value))}>
          {nurses.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>携带设备编号 *</label>
        <input value={deviceNo} onChange={(e) => setDeviceNo(e.target.value)} placeholder="如 JM-103 经皮胆红素仪编号" />
        <div className="hint">建议与前次测量使用同一台设备（前次：{t.source_visit?.device_no || '未记录'}）</div>
      </div>
      <div className="field">
        <label>上门时间 *</label>
        <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <button className="btn primary block" disabled={busy} onClick={ok}>{busy ? '提交中…' : '生成复测任务'}</button>
    </Modal>
  )
}

function DoctorModal({ t, onClose, onDone }: { t: RecheckTask; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState('电话干预')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function ok() {
    setBusy(true)
    try {
      await api.post(`/api/rechecks/${t.id}/doctor-decide`, { decision, note })
      onDone()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal title={`社区医生判断 - ${t.baby_name}（第 ${t.reschedule_count} 次改约）`} onClose={onClose}>
      <div className="field">
        <label>处置判断</label>
        <div className="seg">
          {['电话干预', '建议直接就诊', '继续观察'].map((x) => (
            <span key={x} className={`opt ${decision === x ? 'on' : ''}`} onClick={() => setDecision(x)}>{x}</span>
          ))}
        </div>
      </div>
      <div className="field">
        <label>判断依据 / 沟通记录</label>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="如：电话联系家属，告知胆红素上升风险，劝说次日务必复测；家属仍拒绝则建议直接就诊" />
      </div>
      <button className="btn primary block" disabled={busy} onClick={ok}>{busy ? '提交中…' : '提交判断'}</button>
    </Modal>
  )
}

function ReferralRow({ r, onChanged }: { r: Referral; onChanged: () => void }) {
  const [feedback, setFeedback] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  async function ok() {
    setBusy(true)
    try {
      await api.post(`/api/referrals/${r.id}/visited`, { feedback: text })
      setFeedback(false); onChanged(); toast('已登记就诊反馈并闭环')
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px dashed var(--line)' }}>
      <div className="row between">
        <span className="small strong">#{r.id} {r.mother_name}家 {r.baby_name} · {fmtTime(r.created_at)}</span>
        <Badge color={r.status === '待就诊' ? 'red' : 'green'}>{r.status}</Badge>
      </div>
      <div className="small mt8">
        黄疸 {r.bilirubin_prev ?? '-'} → <b style={{ color: 'var(--red)' }}>{r.bilirubin_now ?? '-'}</b> µmol/L
        {r.bilirubin_delta != null ? `（24h ${r.bilirubin_delta > 0 ? '升高' : '变化'} ${r.bilirubin_delta}）` : ''}
      </div>
      <div className="small muted">{r.trend_note}</div>
      {r.status === '待就诊'
        ? (feedback ? (
            <div className="mt8">
              <div className="field"><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="医院诊断/处理（如：已光疗、复查胆红素下降）" /></div>
              <div className="row">
                <button className="btn primary sm" disabled={busy} onClick={ok}>提交反馈并闭环</button>
                <button className="btn ghost sm" onClick={() => setFeedback(false)}>取消</button>
              </div>
            </div>
          ) : <button className="btn ghost sm mt8" onClick={() => setFeedback(true)}>登记就诊反馈</button>)
        : <div className="small" style={{ color: 'var(--green)' }}>✔ {r.hospital_feedback || '已就诊'}</div>}
    </div>
  )
}
