// 黄疸复测任务站
// 护士：指派上门护士、登记携带设备、确认时间、复测前提醒家属、处理改约
// 医生：查看二次改约升级任务，决定电话干预或建议直接就诊
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import type { RecheckTask } from '../../types'
import { AgeText, Badge, Empty, Modal, fmtTime, toast } from '../../components/ui'
import { useAuth } from '../../store/auth'

interface NurseLite { id: number; name: string; title: string; phone: string }

export default function RecheckTasks({ doctor }: { doctor?: boolean }) {
  const user = useAuth((s) => s.user)
  const isDoctor = doctor || user?.role === 'doctor'
  const [tasks, setTasks] = useState<RecheckTask[]>([])
  const [nurses, setNurses] = useState<NurseLite[]>([])
  const [loading, setLoading] = useState(true)
  const nav = useNavigate()

  function load() {
    setLoading(true)
    Promise.all([
      api.get<{ tasks: RecheckTask[] }>(`/api/recheck-tasks${isDoctor ? '?status=escalated' : ''}`),
      isDoctor ? Promise.resolve({ nurses: [] }) : api.get<{ nurses: NurseLite[] }>('/api/nurses'),
    ]).then(([t, n]) => { setTasks(t.tasks); setNurses(n.nurses) })
      .finally(() => setLoading(false))
  }
  useEffect(load, [isDoctor])

  const escalated = useMemo(() => tasks.filter((t) => t.status === '已升级' && !t.doctor_action), [tasks])
  const normal = useMemo(() => tasks.filter((t) => !(t.status === '已升级' && !t.doctor_action)), [tasks])

  return (
    <div>
      <div className="page-title">{isDoctor ? '复测升级处置' : '黄疸复测任务'}</div>
      <div className="page-sub">
        {isDoctor
          ? '复测被家属反复改约的临界值病例，需判断电话干预或建议直接就诊'
          : '临界值黄疸次日复测：明确由哪名护士携带哪台设备上门，复测前提醒家属准备喂养与排便记录'}
      </div>

      {loading && <Empty text="加载中…" icon="⏳" />}
      {!loading && tasks.length === 0 && <Empty text={isDoctor ? '暂无待处置的升级任务 🎉' : '暂无复测任务'} icon="🔁" />}

      {escalated.length > 0 && (
        <div className="alert-box danger">
          <b>{escalated.length} 项任务二次改约已升级</b>，请尽快联系家属判断处置
        </div>
      )}

      {[...escalated, ...normal].map((t) => (
        <TaskCard key={t.id} t={t} nurses={nurses} isDoctor={!!isDoctor} reload={load}
          onArchive={() => nav(`/nurse/archives/${t.archive_id}`)} />
      ))}
    </div>
  )
}

function TaskCard({ t, nurses, isDoctor, reload, onArchive }: {
  t: RecheckTask; nurses: NurseLite[]; isDoctor: boolean; reload: () => void; onArchive: () => void
}) {
  const [nurseId, setNurseId] = useState(t.nurse_id || 0)
  const [device, setDevice] = useState(t.device_code || '')
  const [time, setTime] = useState(t.scheduled_time.replace(' ', 'T').slice(0, 16))
  const [busy, setBusy] = useState(false)
  const [rs, setRs] = useState<{ time: string; reason: string } | null>(null)
  const [doc, setDoc] = useState(false)
  const escalated = t.status === '已升级' && !t.doctor_action

  async function save() {
    setBusy(true)
    try {
      await api.post(`/api/recheck-tasks/${t.id}/assign`, { nurseId: nurseId || null, deviceCode: device, scheduledTime: time })
      toast('复测任务已安排')
      reload()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  async function remind() {
    try { await api.post(`/api/recheck-tasks/${t.id}/remind`, {}); toast('已生成复测前准备提醒（家属端可见）'); reload() }
    catch (e: any) { toast(e.message) }
  }
  async function reschedule() {
    if (!rs?.time) return toast('请选择时间')
    setBusy(true)
    try {
      const r = await api.post<{ escalated: boolean }>(`/api/recheck-tasks/${t.id}/reschedule`, { scheduledTime: rs.time, reason: rs.reason })
      toast(r.escalated ? '第二次改约：已升级社区医生' : '改约成功')
      setRs(null); reload()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }

  return (
    <div className={`card ${escalated ? 'task-escalated' : ''}`}>
      <div className="row between">
        <span className="strong" onClick={onArchive} style={{ cursor: 'pointer' }}>
          {t.archive?.mother_name} · {t.archive?.baby_name}
        </span>
        <div className="row">
          {t.reschedule_count > 0 && <Badge color="amber">改约 {t.reschedule_count} 次</Badge>}
          <Badge color={escalated ? 'red' : t.status === '已完成' ? 'green' : t.doctor_action ? 'red' : 'amber'}>{t.status}</Badge>
        </div>
      </div>
      <div className="small muted mt8">
        <AgeText birthDate={t.archive?.birth_date || ''} /> · 📍 {t.archive?.address} · 📞 {t.archive?.contact_name} {t.archive?.contact_phone}
      </div>

      {isDoctor ? (
        <div className="mt8">
          {t.doctor_action ? (
            <div className="alert-box danger">
              已处置：<b>{t.doctor_action === 'phone_call' ? '电话干预' : '建议直接就诊'}</b>
              {t.doctor_note && <div className="small mt8">{t.doctor_note}</div>}
            </div>
          ) : (
            <>
              <div className="alert-box warn" style={{ marginBottom: 8 }}>{t.escalation_note}</div>
              <button className="btn primary sm" onClick={() => setDoc(true)}>电话干预 / 建议直接就诊</button>
            </>
          )}
          <div className="small muted mt8">复测基线：{t.visit_id ? `访视 #${t.visit_id}` : '-'}</div>
        </div>
      ) : (
        <div className="mt8">
          <div className="grid2">
            <div className="field">
              <label>上门护士</label>
              <select value={nurseId} onChange={(e) => setNurseId(Number(e.target.value))}>
                <option value={0}>待指派</option>
                {nurses.map((n) => <option key={n.id} value={n.id}>{n.name}（{n.title}）</option>)}
              </select>
            </div>
            <div className="field">
              <label>携带设备编号</label>
              <input placeholder="如 JM-103-0217" value={device} onChange={(e) => setDevice(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>上门时间</label>
            <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="row wrap">
            <button className="btn primary sm" disabled={busy} onClick={save}>保存安排</button>
            <button className="btn teal sm" onClick={remind}>提醒家属准备喂养/排便记录</button>
            {t.status !== '已完成' && <button className="btn ghost sm" onClick={() => setRs({ time, reason: '护士侧改约' })}>改约</button>}
            <button className="btn ghost sm" onClick={onArchive}>档案 →</button>
          </div>
          {t.prepare_reminded && <div className="small muted mt8">✔ 已提醒：{t.prepare_note}</div>}
          {escalated && <div className="alert-box danger mt8">{t.escalation_note}（已进入医生升级列表）</div>}
          {t.doctor_action && (
            <div className="alert-box danger mt8">
              医生处置：<b>{t.doctor_action === 'phone_call' ? '电话干预' : '建议直接就诊'}</b>
              {t.doctor_note && <div className="small mt8">{t.doctor_note}</div>}
            </div>
          )}
        </div>
      )}

      <div className="small muted mt8">建立于 {fmtTime(t.created_at)}</div>

      {rs && (
        <Modal title="复测改约" onClose={() => setRs(null)}>
          <div className={t.reschedule_count >= 1 ? 'alert-box danger' : 'alert-box warn'}>
            {t.reschedule_count >= 1 ? '这是第二次改约，提交后将自动升级社区医生' : '第二次改约将自动升级社区医生'}
          </div>
          <div className="field">
            <label>新时间</label>
            <input type="datetime-local" value={rs.time} onChange={(e) => setRs({ ...rs, time: e.target.value })} />
          </div>
          <div className="field">
            <label>原因</label>
            <input value={rs.reason} onChange={(e) => setRs({ ...rs, reason: e.target.value })} />
          </div>
          <button className="btn primary block" disabled={busy} onClick={reschedule}>{busy ? '提交中…' : '确认改约'}</button>
        </Modal>
      )}

      {doc && <DoctorActionModal taskId={t.id} onClose={() => setDoc(false)} onDone={() => { setDoc(false); reload(); toast('已记录处置') }} />}
    </div>
  )
}

function DoctorActionModal({ taskId, onClose, onDone }: { taskId: number; onClose: () => void; onDone: () => void }) {
  const [action, setAction] = useState<'phone_call' | 'direct_visit'>('phone_call')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function ok() {
    setBusy(true)
    try { await api.post(`/api/recheck-tasks/${taskId}/doctor-action`, { action, note }); onDone() }
    catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal title="社区医生处置" onClose={onClose}>
      <div className="field">
        <label>处置方式</label>
        <div className="seg">
          <span className={`opt ${action === 'phone_call' ? 'on' : ''}`} onClick={() => setAction('phone_call')}>电话干预</span>
          <span className={`opt ${action === 'direct_visit' ? 'on' : ''}`} onClick={() => setAction('direct_visit')}>建议直接就诊</span>
        </div>
      </div>
      <div className="field">
        <label>处置记录</label>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={action === 'phone_call' ? '电话沟通情况、家属反馈、下一步安排' : '建议就诊的医院科室与紧迫程度'} />
      </div>
      <button className="btn primary block" disabled={busy} onClick={ok}>{busy ? '提交中…' : '提交处置'}</button>
    </Modal>
  )
}
