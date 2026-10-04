// 黄疸临界值复查流程（家属端）
// 临界值告知 → 家属选择（次日复测 / 当天去儿科 / 在家观察）
// 观察：风险告知确认 + 复查提醒；复测：明确任务（护士+设备+时间）+ 喂养排便准备提醒 + 再次改约（二次改约升级社区医生）
// 复测升高：转诊单携带前一天记录与变化趋势，供医院判断
import { useState } from 'react'
import { api } from '../../api'
import type { FamilyOverview, JaundicePlan, RecheckTask, Referral, Visit } from '../../types'
import { Badge, Modal, RiskBadge, fmtTime, toast } from '../../components/ui'

type Choice = 'recheck' | 'clinic' | 'observe'
const CHOICE_LABEL: Record<Choice, string> = { recheck: '次日复测', clinic: '当天去儿科', observe: '在家观察' }

export default function JaundiceFlow({ d, reload }: { d: FamilyOverview; reload: () => void }) {
  const plan = d.jaundicePlan as JaundicePlan | null
  const critical: Visit | null = plan?.visit || d.criticalVisit || null
  const openReferral = (d.referrals || []).find((r) => r.status !== '已闭环') || null
  const closedReferral = (d.referrals || []).find((r) => r.status === '已闭环') || null
  const task: RecheckTask | null =
    plan?.recheckTask || (d.recheckTasks || []).find((t) => t.status !== '已完成' && t.status !== '已取消') || null
  const tasks = d.recheckTasks || []

  // 只在最近 48 小时的临界值访视上展示选择，旧记录不打扰家属
  const recentCritical = critical && critical.need_recheck &&
    (Date.now() - new Date(critical.visit_time.replace(' ', 'T')).getTime()) < 48 * 3600000
  // 该访视已经作为基线完成过复测（含升高转诊）→ 不再让家属重复选择
  const alreadyRechecked = critical && tasks.some((t) => t.visit_id === critical.id && t.status === '已完成')

  return (
    <div>
      {openReferral && <ReferralCard r={openReferral} />}
      {recentCritical && !alreadyRechecked && !openReferral && (
        <>
          <CriticalCard v={critical} />
          {plan ? <PlanResult plan={plan} task={task} critical={critical} reload={reload} />
            : <ChoiceCard visitId={critical.id} reload={reload} />}
        </>
      )}
      {closedReferral && !openReferral && (
        <details className="card referral-card" style={{ padding: 0 }}>
          <summary className="row between" style={{ padding: '12px 14px', cursor: 'pointer' }}>
            <span className="strong">📋 黄疸转诊记录（已闭环）</span>
            <Badge color="green">已就诊</Badge>
          </summary>
          <div style={{ padding: '0 14px 14px' }}><ReferralCard r={closedReferral} embedded /></div>
        </details>
      )}
    </div>
  )
}

// 临界值测量信息：测量部位、设备编号、喂养情况、医生建议
function CriticalCard({ v }: { v: Visit }) {
  return (
    <div className="card jaundice-card">
      <div className="row between mb8">
        <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--amber)' }} />黄疸临界值复查</div>
        <RiskBadge level={v.risk_level} />
      </div>
      <div className="measure-grid">
        <div className="measure"><span className="m-val">{v.bilirubin ?? '-'}</span><span className="m-lab">µmol/L · {v.bilirubin_site}</span></div>
        <div className="measure"><span className="m-val">近阈值</span><span className="m-lab">需 24~48h 内复查</span></div>
      </div>
      <dl className="kv mt8">
        <dt>测量部位</dt><dd>{v.bilirubin_site}</dd>
        <dt>设备编号</dt><dd>{v.device_code || '护士未登记'}{v.device_issue ? '（设备故障·手工记录）' : ''}</dd>
        <dt>喂养情况</dt><dd>{v.feeding_type || '未记录'} · {v.feeding_freq} 次/日 · 大便 {v.stool_count} 次（{v.stool_color}）</dd>
        <dt>医生建议</dt>
        <dd>{v.doctor_advice || '护士已告知：接近转诊阈值，建议按时复查、加强喂养，出现嗜睡拒奶或黄疸加重立即就诊。'}</dd>
      </dl>
    </div>
  )
}

// 家属三选一
function ChoiceCard({ visitId, reload }: { visitId: number; reload: () => void }) {
  const [busy, setBusy] = useState<Choice | ''>('')
  const [observe, setObserve] = useState(false)
  const [ack, setAck] = useState(false)

  async function submit(choice: Choice, acknowledged = false) {
    setBusy(choice)
    try {
      await api.post('/api/jaundice/plan', { visitId, choice, acknowledged })
      toast(choice === 'recheck' ? '已生成次日复测任务' : choice === 'clinic' ? '已记录：当天去儿科就诊' : '已确认风险告知')
      reload()
    } catch (e: any) { toast(e.message) } finally { setBusy('') }
  }

  return (
    <div className="card">
      <div className="strong mb8">请选择接下来的安排</div>
      <div className="choice-col">
        <button className="choice-btn primary" disabled={busy !== ''} onClick={() => submit('recheck')}>
          <span className="c-ico">🔁</span>
          <span className="c-body"><b>次日复测</b><small>护士携带设备上门再测一次，免费、不用跑医院</small></span>
        </button>
        <button className="choice-btn" disabled={busy !== ''} onClick={() => submit('clinic')}>
          <span className="c-ico">🏥</span>
          <span className="c-body"><b>当天去儿科</b><small>直接到医院测胆红素，系统可生成转诊记录</small></span>
        </button>
        <button className="choice-btn" disabled={busy !== ''} onClick={() => setObserve(true)}>
          <span className="c-ico">👀</span>
          <span className="c-body"><b>在家观察</b><small>需阅读风险告知并确认，仍建议 24~48h 内复测</small></span>
        </button>
      </div>

      {observe && (
        <Modal title="居家观察风险告知" onClose={() => { setObserve(false); setAck(false) }}>
          <RiskNotice visitId={visitId} ack={ack} setAck={setAck} />
          <button className="btn danger block" disabled={!ack || busy !== ''} onClick={() => submit('observe', true)}>
            {busy === 'observe' ? '提交中…' : '我已阅读并知晓，选择在家观察'}
          </button>
        </Modal>
      )}
    </div>
  )
}

// 风险告知正文（与后端文案一致，从计划里取；未建计划时给通用版）
function RiskNotice({ ack, setAck, text }: { visitId?: number; ack: boolean; setAck: (b: boolean) => void; text?: string }) {
  const body = text || [
    '宝宝本次经皮黄疸值已接近出生日龄光疗参考阈值。居家观察不能替代医疗评估。',
    '居家期间请：① 每日喂养 8~12 次，勤喂母乳促进排泄；② 观察黄染是否蔓延到四肢、手足心；③ 观察吃奶、精神反应、哭声与大小便颜色；④ 记录喂养次数与排便次数/颜色，供复测护士核对。',
    '出现黄疸明显加重、嗜睡难以唤醒、拒奶、尖叫或抽搐、大便白陶土色、发热任一情况，请立即就诊，勿等复测。',
  ].join('\n')
  return (
    <div>
      <div className="risk-notice">{body}</div>
      <label className="row small mt8" style={{ gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 'auto' }} />
        我已阅读并知晓上述风险与红旗症状，知道何时必须立即就诊
      </label>
    </div>
  )
}

// 已选择后的结果展示
function PlanResult({ plan, task, critical, reload }: { plan: JaundicePlan; task: RecheckTask | null; critical: Visit; reload: () => void }) {
  const [changing, setChanging] = useState(false)

  return (
    <div>
      {plan.choice === 'recheck' && task && <TaskCard task={task} reload={reload} />}
      {plan.choice === 'recheck' && !task && (
        <div className="alert-box info">复测任务安排中，护士站确认后将显示上门护士与设备信息。</div>
      )}

      {plan.choice === 'clinic' && (
        <div className="card">
          <div className="row between mb8">
            <span className="strong">🏥 您已选择当天去儿科就诊</span>
            <Badge color="red">待就诊反馈</Badge>
          </div>
          <div className="small muted mb8">
            就诊时请向医院出示：黄疸值 <b>{critical.bilirubin} µmol/L</b>（{critical.bilirubin_site}，{fmtTime(critical.visit_time)} 测）、
            设备 {critical.device_code || '未登记'}、出生天数、喂养与排便情况。
          </div>
          <div className="small muted">就诊后请在「咨询改约」里告诉社区护士结果，以便闭环随访。</div>
        </div>
      )}

      {plan.choice === 'observe' && (
        <div className="card">
          <div className="row between mb8">
            <span className="strong">👀 居家观察中</span>
            <Badge color={plan.risk_acknowledged ? 'green' : 'red'}>{plan.risk_acknowledged ? '风险已知晓' : '风险未确认'}</Badge>
          </div>
          <div className="risk-notice">{plan.risk_notice}</div>
          <div className="alert-box warn" style={{ marginTop: 8 }}>
            <b>复查提醒：</b>建议 {plan.due_date || '24~48 小时内'} 前完成胆红素复测。若宝宝出现上述红旗症状，请立即就诊。
          </div>
        </div>
      )}

      <div className="card">
        <div className="small muted mb8">情况有变化？可以重新选择安排：</div>
        {!changing ? (
          <button className="btn ghost sm" onClick={() => setChanging(true)}>修改我的选择</button>
        ) : (
          <ChoiceCard visitId={plan.visit_id} reload={() => { setChanging(false); reload() }} />
        )}
      </div>
    </div>
  )
}

// 次日复测任务卡：哪名护士、哪台设备、何时上门、准备提醒、再次改约、升级提示
function TaskCard({ task, reload }: { task: RecheckTask; reload: () => void }) {
  const [rs, setRs] = useState<{ time: string; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const escalated = task.status === '已升级'
  const doctorDone = !!task.doctor_action

  async function remindAck() {
    try { await api.post(`/api/recheck-tasks/${task.id}/prepare-ack`, {}); toast('已告知护士，复测时见'); reload() }
    catch (e: any) { toast(e.message) }
  }
  async function submitReschedule() {
    if (!rs?.time) return toast('请选择新的时间')
    setBusy(true)
    try {
      const r = await api.post<{ escalated: boolean }>(`/api/recheck-tasks/${task.id}/reschedule`, { scheduledTime: rs.time, reason: rs.reason })
      toast(r.escalated ? '这是第二次改约，任务已升级社区医生判断' : '改约成功，护士将按新时间上门')
      setRs(null); reload()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }

  return (
    <div className={`card ${escalated && !doctorDone ? 'task-escalated' : ''}`}>
      <div className="row between mb8">
        <span className="strong">🔁 次日黄疸复测任务</span>
        <Badge color={escalated ? 'red' : task.status === '已完成' ? 'green' : 'amber'}>{task.status}</Badge>
      </div>
      <dl className="kv">
        <dt>上门时间</dt><dd>{fmtTime(task.scheduled_time)}</dd>
        <dt>上门护士</dt><dd>{task.nurse ? `${task.nurse.name}（${task.nurse.title}）${task.nurse.phone}` : '护士站待指派'}</dd>
        <dt>携带设备</dt><dd>{task.device_code || '待登记'}（经皮胆红素仪）</dd>
        <dt>改约次数</dt><dd>{task.reschedule_count} 次</dd>
      </dl>

      {task.prepare_reminded ? (
        <div className="alert-box info mt8">
          <b>复测前准备：</b>{task.prepare_note}
          <button className="btn teal sm" style={{ marginLeft: 8 }} onClick={remindAck}>我知道了，会准备好记录</button>
        </div>
      ) : (
        <div className="small muted mt8">复测前护士会提醒您准备喂养与排便记录。</div>
      )}

      {escalated && !doctorDone && (
        <div className="alert-box danger mt8">
          <b>⚠ 复测已两次改约，任务升级社区医生。</b><br />
          {task.escalation_note}
          <div className="small mt8">社区医生将电话沟通，判断电话干预或建议直接就诊，请保持电话畅通。</div>
        </div>
      )}
      {escalated && doctorDone && (
        <div className="alert-box danger mt8">
          <b>社区医生处置：{task.doctor_action === 'phone_call' ? '电话干预' : '建议直接就诊'}</b>
          {task.doctor_note && <div className="small mt8">{task.doctor_note}</div>}
          <div className="small mt8">{task.doctor?.name} 医生将与您联系，请保持电话畅通。</div>
        </div>
      )}

      {!escalated && task.status !== '已完成' && (
        <div className="row mt8">
          <button className="btn ghost sm" onClick={() => setRs({ time: task.scheduled_time.replace(' ', 'T').slice(0, 16), reason: '家里临时有事' })}>
            再次改约
          </button>
        </div>
      )}

      {rs && (
        <Modal title="复测改约" onClose={() => setRs(null)}>
          <div className="alert-box warn">提示：反复改约可能错过最佳复测时机；第二次改约将自动升级社区医生评估。</div>
          <div className="field">
            <label>新的上门时间</label>
            <input type="datetime-local" value={rs.time} onChange={(e) => setRs({ ...rs, time: e.target.value })} />
          </div>
          <div className="field">
            <label>改约原因</label>
            <input value={rs.reason} onChange={(e) => setRs({ ...rs, reason: e.target.value })} />
          </div>
          <button className="btn primary block" disabled={busy} onClick={submitReschedule}>{busy ? '提交中…' : '确认改约'}</button>
        </Modal>
      )}
    </div>
  )
}

// 转诊单（含前一天记录与趋势），家属可出示给医院
function ReferralCard({ r, embedded }: { r: Referral; embedded?: boolean }) {
  return (
    <div className={embedded ? '' : 'card referral-card'}>
      <div className="row between mb8">
        <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--red)' }} />儿科转诊单</div>
        <Badge color="red">{r.status}</Badge>
      </div>
      <div className="small muted mb8">
        {r.mother_name} · {r.baby_name}（{fmtTime(r.birth_date)} 出生） · 📍 {r.address} · {r.contact_name} {r.contact_phone}
      </div>
      <div className="alert-box danger">
        <b>{r.trend_note}</b>
      </div>
      <table className="trend-table">
        <thead>
          <tr><th></th><th>前一天记录</th><th>本次复测</th></tr>
        </thead>
        <tbody>
          <tr><td>时间</td><td>{fmtTime(r.prev_time)}</td><td>{fmtTime(r.current_time)}</td></tr>
          <tr className="hl"><td>黄疸 µmol/L</td><td>{r.bilirubin_prev ?? '-'}（{r.prev_site}）</td><td>{r.bilirubin_current ?? '-'}（{r.current_site}）</td></tr>
          <tr><td>变化</td><td colSpan={2}><b className="trend-up">↑ 升高 {r.delta} µmol/L</b></td></tr>
          <tr><td>体重 g</td><td>{r.prev_weight ?? '-'}</td><td>{r.current_weight ?? '-'}</td></tr>
          <tr><td>喂养 次/日</td><td>{r.prev_feeding ?? '-'}</td><td>{r.current_feeding ?? '-'}</td></tr>
          <tr><td>大便</td><td>{r.prev_stool ?? '-'} 次（{r.prev_stool_color}）</td><td>{r.current_stool ?? '-'} 次（{r.current_stool_color}）</td></tr>
          <tr><td>测量设备</td><td>{r.prev_device || '未登记'}</td><td>{r.current_device || '未登记'}</td></tr>
          <tr><td>测量护士</td><td>{r.prev_nurse_name || '-'}</td><td>{r.current_nurse_name || '-'}</td></tr>
        </tbody>
      </table>
      <div className="small muted mt8">请尽快带宝宝到儿科就诊，并向医院出示本页记录以便判断变化趋势。就诊后请告知社区护士。</div>
    </div>
  )
}
