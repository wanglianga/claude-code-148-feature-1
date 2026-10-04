// 家属端：线上咨询 + 申请改约
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { FamilyOverview } from '../../types'
import { APPT_STATUS_COLOR, Badge, Empty, Modal, fmtTime, toast } from '../../components/ui'

export default function FamilyConsult() {
  const [d, setD] = useState<FamilyOverview | null>(null)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [rescheduleId, setRescheduleId] = useState<number | null>(null)

  function load() { api.get<FamilyOverview>('/api/family/overview').then(setD) }
  useEffect(() => { load() }, [])
  if (!d) return <Empty text="加载中…" icon="⏳" />

  async function ask() {
    if (!question.trim()) return toast('请填写想咨询的问题')
    setBusy(true)
    try {
      await api.post('/api/consults', { question })
      toast('已提交，护士会尽快回复')
      setQuestion(''); load()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }

  const pending = d.appointments.filter((a) => a.status === '待访视')

  return (
    <div>
      <div className="page-title">咨询与改约</div>

      <div className="card">
        <div className="card-title"><span className="dot" />线上咨询</div>
        <div className="field">
          <textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="如：宝宝黄疸还没退，可以晒太阳吗？吐奶变多了要紧吗？" />
        </div>
        <button className="btn primary block" disabled={busy} onClick={ask}>{busy ? '提交中…' : '提交咨询'}</button>
      </div>

      <div className="card">
        <div className="card-title"><span className="dot" style={{ background: 'var(--amber)' }} />我的咨询</div>
        {d.consults.length === 0 && <Empty text="暂无咨询记录" icon="💬" />}
        {d.consults.map((c) => (
          <div key={c.id} className="mb12">
            <div className="row between">
              <Badge color={c.status === '已回复' ? 'green' : 'amber'}>{c.status}</Badge>
              <span className="small muted">{fmtTime(c.created_at)}</span>
            </div>
            <div className="small mt8">问：{c.question}</div>
            {c.reply && <div className="small" style={{ color: 'var(--teal)' }}>答（{c.replied_by}）：{c.reply}</div>}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title"><span className="dot" style={{ background: 'var(--teal)' }} />预约改期</div>
        {pending.length === 0 && <Empty text="当前没有待上门的预约" icon="📅" />}
        {pending.map((a) => (
          <div key={a.id} className="row between" style={{ padding: '7px 0', borderBottom: '1px dashed var(--line)' }}>
            <div>
              <div className="strong small">{a.type} · {fmtTime(a.scheduled_time)}</div>
              {a.recheck_task_id ? (
                <div className="small" style={{ color: 'var(--primary)' }}>
                  黄疸临界值复测{a.assign_nurse_name ? ` · 上门护士 ${a.assign_nurse_name}` : ''}{a.device_no ? ` · 设备 ${a.device_no}` : ''}
                </div>
              ) : null}
              {a.reason && <div className="small muted">{a.reason}</div>}
            </div>
            <div className="row">
              <Badge color={APPT_STATUS_COLOR[a.status]}>{a.status}</Badge>
              <button className="btn ghost sm" onClick={() => setRescheduleId(a.id)}>申请改约</button>
            </div>
          </div>
        ))}
      </div>

      {rescheduleId && <Reschedule apptId={rescheduleId} onClose={() => setRescheduleId(null)}
        onDone={(escalated) => {
          setRescheduleId(null); load()
          toast(escalated ? '改约成功：复测已再次改约，任务已升级社区医生判断是否电话干预或建议就诊' : '改约成功，护士会按新时间上门')
        }} />}
    </div>
  )
}

function Reschedule({ apptId, onClose, onDone }: { apptId: number; onClose: () => void; onDone: (escalated: boolean) => void }) {
  const [time, setTime] = useState('')
  const [reason, setReason] = useState('家里临时有事，申请改期')
  const [busy, setBusy] = useState(false)
  async function ok() {
    if (!time) return toast('请选择新的时间')
    setBusy(true)
    try {
      const r = await api.post<{ escalated: unknown }>(`/api/appointments/${apptId}/reschedule`, { scheduledTime: time, reason })
      onDone(!!r.escalated)
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal title="申请改约" onClose={onClose}>
      <div className="field">
        <label>希望的新上门时间</label>
        <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <div className="field">
        <label>原因</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button className="btn primary block" disabled={busy} onClick={ok}>{busy ? '提交中…' : '确认改约'}</button>
    </Modal>
  )
}
