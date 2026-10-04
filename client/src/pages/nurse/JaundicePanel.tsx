// 档案详情内的黄疸临界值复查面板（护士/医生视角）
// 查看家属选择、复测任务安排、含趋势的转诊单；护士可代家属录入选择、登记就诊反馈
import { useState } from 'react'
import { api } from '../../api'
import type { ArchiveDetail, Referral } from '../../types'
import { Badge, RiskBadge, fmtTime, toast } from '../../components/ui'

const CHOICE_TAG: Record<string, { label: string; color: string }> = {
  recheck: { label: '次日复测', color: 'coral' },
  clinic: { label: '当天去儿科', color: 'red' },
  observe: { label: '居家观察', color: 'amber' },
}

export default function JaundicePanel({ d, reload }: { d: ArchiveDetail; reload: () => void }) {
  const plan = d.jaundicePlan
  const critical = plan?.visit || d.criticalVisit
  const tasks = d.recheckTasks || []
  const referrals = d.referrals || []

  if (!critical && tasks.length === 0 && referrals.length === 0) return null

  return (
    <div>
      {critical && (
        <div className="card jaundice-card">
          <div className="row between mb8">
            <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--amber)' }} />临界值访视</div>
            <RiskBadge level={critical.risk_level} />
          </div>
          <div className="small muted mb8">{fmtTime(critical.visit_time)} · 访视 #{critical.id}</div>
          <div className="grid2 small">
            <div>🟡 黄疸 <b>{critical.bilirubin} µmol/L</b>（{critical.bilirubin_site}）</div>
            <div>🔬 设备 <b>{critical.device_code || '未登记'}</b>{critical.device_issue ? '（故障手工记录）' : ''}</div>
            <div>喂养 {critical.feeding_type} {critical.feeding_freq} 次/日</div>
            <div>大便 {critical.stool_count} 次（{critical.stool_color}）· 体重 {critical.weight ?? '-'} g</div>
          </div>
          {critical.doctor_advice && <div className="small mt8">🩺 医生建议：{critical.doctor_advice}</div>}

          <div className="row between mt8">
            <span className="small strong">家属选择</span>
            {plan
              ? <Badge color={CHOICE_TAG[plan.choice]?.color || 'gray'}>
                  {CHOICE_TAG[plan.choice]?.label || plan.choice}
                  {plan.choice === 'observe' ? (plan.risk_acknowledged ? '· 已知晓' : '· 未确认') : ''}
                </Badge>
              : critical.need_referral
                ? <Badge color="red">已达阈值·自动转诊</Badge>
                : <Badge color="gray">家属尚未选择</Badge>}
          </div>
          {!plan && critical.need_recheck && <NurseChoose visitId={critical.id} reload={reload} />}
          {plan && critical.need_recheck && (
            <details className="small mt8">
              <summary style={{ cursor: 'pointer', color: 'var(--teal)' }}>护士代家属修改选择</summary>
              <div className="mt8"><NurseChoose visitId={critical.id} reload={reload} compact /></div>
            </details>
          )}
        </div>
      )}

      {tasks.map((t) => (
        <div key={t.id} className={`card ${t.status === '已升级' && !t.doctor_action ? 'task-escalated' : ''}`}>
          <div className="row between">
            <span className="strong">复测任务 #{t.id}</span>
            <div className="row">
              {t.reschedule_count > 0 && <Badge color="amber">改约 {t.reschedule_count} 次</Badge>}
              <Badge color={t.status === '已升级' ? 'red' : t.status === '已完成' ? 'green' : 'amber'}>{t.status}</Badge>
            </div>
          </div>
          <div className="small mt8">
            时间 {fmtTime(t.scheduled_time)} · 护士 {t.nurse?.name || '待指派'} · 设备 {t.device_code || '待登记'}
          </div>
          {t.prepare_reminded && <div className="small muted mt8">✔ 已提醒准备：{t.prepare_note}</div>}
          {t.status === '已升级' && !t.doctor_action && <div className="alert-box danger mt8">{t.escalation_note}</div>}
          {t.doctor_action && (
            <div className="alert-box danger mt8">
              医生处置：<b>{t.doctor_action === 'phone_call' ? '电话干预' : '建议直接就诊'}</b>
              {t.doctor_note ? ` — ${t.doctor_note}` : ''}（{t.doctor?.name}）
            </div>
          )}
        </div>
      ))}

      {referrals.map((r) => <ReferralBox key={r.id} r={r} reload={reload} />)}
    </div>
  )
}

function NurseChoose({ visitId, reload, compact }: { visitId: number; reload: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState('')
  async function choose(choice: string) {
    setBusy(choice)
    try {
      await api.post('/api/jaundice/plan', { visitId, choice, acknowledged: true })
      toast('已代家属记录选择')
      reload()
    } catch (e: any) { toast(e.message) } finally { setBusy('') }
  }
  return (
    <div className={`row wrap ${compact ? '' : 'mt8'}`}>
      <span className="small muted">护士代录：</span>
      <button className="btn ghost sm" disabled={!!busy} onClick={() => choose('recheck')}>次日复测</button>
      <button className="btn ghost sm" disabled={!!busy} onClick={() => choose('clinic')}>当天去儿科</button>
      <button className="btn ghost sm" disabled={!!busy} onClick={() => choose('observe')}>居家观察（已知晓风险）</button>
    </div>
  )
}

function ReferralBox({ r, reload }: { r: Referral; reload: () => void }) {
  const [fb, setFb] = useState(r.hospital_feedback || '')
  const [busy, setBusy] = useState(false)
  async function save(close: boolean) {
    if (!fb.trim()) return toast('请先填写医院反馈')
    setBusy(true)
    try {
      await api.post(`/api/referrals/${r.id}/feedback`, { feedback: fb, close })
      toast(close ? '转诊单已闭环' : '反馈已保存')
      reload()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="card referral-card">
      <div className="row between mb8">
        <span className="strong">儿科转诊单 #{r.id}</span>
        <Badge color="red">{r.status}</Badge>
      </div>
      <div className="alert-box danger"><b>{r.trend_note}</b></div>
      <table className="trend-table">
        <thead><tr><th></th><th>前一天记录</th><th>本次复测</th></tr></thead>
        <tbody>
          <tr><td>时间</td><td>{fmtTime(r.prev_time)}</td><td>{fmtTime(r.current_time)}</td></tr>
          <tr className="hl"><td>黄疸 µmol/L</td><td>{r.bilirubin_prev ?? '-'}（{r.prev_site}）</td><td>{r.bilirubin_current ?? '-'}（{r.current_site}）</td></tr>
          <tr><td>体重 g</td><td>{r.prev_weight ?? '-'}</td><td>{r.current_weight ?? '-'}</td></tr>
          <tr><td>喂养 次/日</td><td>{r.prev_feeding ?? '-'}</td><td>{r.current_feeding ?? '-'}</td></tr>
          <tr><td>大便</td><td>{r.prev_stool ?? '-'} 次（{r.prev_stool_color}）</td><td>{r.current_stool ?? '-'} 次（{r.current_stool_color}）</td></tr>
          <tr><td>设备 / 护士</td><td>{r.prev_device || '未登记'} / {r.prev_nurse_name || '-'}</td><td>{r.current_device || '未登记'} / {r.current_nurse_name || '-'}</td></tr>
        </tbody>
      </table>
      {r.status !== '已闭环' && (
        <div className="field mt8">
          <label>医院就诊反馈（家属反馈/电话回访）</label>
          <textarea rows={2} value={fb} onChange={(e) => setFb(e.target.value)} placeholder="如：已光疗 12 小时，胆红素降至…，嘱门诊复查" />
          <div className="row">
            <button className="btn ghost sm" disabled={busy} onClick={() => save(false)}>保存反馈</button>
            <button className="btn primary sm" disabled={busy} onClick={() => save(true)}>保存并闭环</button>
          </div>
        </div>
      )}
      {r.status === '已闭环' && <div className="small" style={{ color: 'var(--green)' }}>✔ 已由 {r.closed_by} 闭环：{r.hospital_feedback}</div>}
    </div>
  )
}
