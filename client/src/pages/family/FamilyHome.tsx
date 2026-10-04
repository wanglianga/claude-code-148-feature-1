// 家属端首页：黄疸临界值复查决策、复测任务（护士/设备/准备提醒）、风险告知、转诊单趋势、护理建议
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import type { FamilyOverview, RecheckTask, Referral } from '../../types'
import { AgeText, Badge, Empty, RiskBadge, fmtTime, toast } from '../../components/ui'

export default function FamilyHome() {
  const [d, setD] = useState<FamilyOverview | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  function load() { api.get<FamilyOverview>('/api/family/overview').then(setD).catch((e) => setErr(e.message)) }
  useEffect(load, [])

  async function choose(taskId: number, choice: string) {
    const confirmText = choice === '当天就诊'
      ? '确认今天带宝宝去儿科就诊吗？社区会收到您的选择并等待就诊反馈。'
      : choice === '观察'
        ? '选择居家观察：我们将为您生成复查提醒和书面风险告知，请务必留意红旗症状并按时复查。确认？'
        : '确认选择次日由社区护士上门复测吗？'
    if (!window.confirm(confirmText)) return
    setBusy(true)
    try {
      await api.post(`/api/rechecks/${taskId}/choice`, { choice })
      toast(choice === '复测' ? '已选择次日复测，请等待社区安排上门护士与设备' : choice === '当天就诊' ? '已登记：今天前往儿科就诊，就诊后请告知社区' : '已生成复查提醒与风险告知')
      load()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }

  if (err) return <div className="alert-box danger">{err}</div>
  if (!d) return <Empty text="加载中…" icon="⏳" />
  const a = d.archive
  const last = d.visits[0]
  const tasks = d.recheckTasks
  const activeTask = tasks.find((t) => ['待选择', '待安排', '待复测', '观察中', '已升级'].includes(t.status))
  const pendingChoice = tasks.find((t) => t.status === '待选择')
  const recheckFollowup = d.followups.find((f) => f.type === '复查')
  const referralFu = d.followups.find((f) => f.type === '转诊')

  return (
    <div>
      <div className="page-title">{a.baby_name} 的护理档案</div>
      <div className="page-sub">妈妈 {a.mother_name} · <AgeText birthDate={a.birth_date} /> · 出生体重 {a.birth_weight}g</div>

      {/* 转诊单（复测升高自动生成，附前后趋势） */}
      {d.referrals.map((r) => <ReferralCard key={r.id} r={r} />)}

      {/* 临界值复查任务各状态 */}
      {pendingChoice && <ChoiceCard t={pendingChoice} busy={busy} onChoose={choose} />}
      {activeTask && activeTask.status !== '待选择' && (
        <TaskCard t={activeTask} busy={busy} onChoose={choose}
          scheduledTime={d.appointments.find((x) => x.recheck_task_id === activeTask.id)?.scheduled_time} />
      )}

      {/* 无临界值任务时的常规提醒 */}
      {!pendingChoice && !activeTask && referralFu && (
        <div className="alert-box danger">
          <b>转诊提醒：</b>{referralFu.detail || referralFu.title}。请尽快带宝宝到儿科就诊，就诊后请告知社区护士。
        </div>
      )}
      {!pendingChoice && !activeTask && recheckFollowup && (
        <div className="alert-box warn">
          <b>复查提醒：</b>建议 {recheckFollowup.due_date || '近期'} 前复查黄疸/体重。
          {d.nextAppointment && <>护士将于 <b>{fmtTime(d.nextAppointment.scheduled_time)}</b> 上门。</>}
        </div>
      )}
      {!pendingChoice && !activeTask && !recheckFollowup && !referralFu && d.nextAppointment && (
        <div className="alert-box info">📅 下次上门访视：{fmtTime(d.nextAppointment.scheduled_time)}（{d.nextAppointment.type}）</div>
      )}

      {last && (
        <div className="card">
          <div className="row between mb8">
            <div className="card-title" style={{ margin: 0 }}><span className="dot" />最近一次访视</div>
            <RiskBadge level={last.risk_level} />
          </div>
          <div className="small muted mb8">{fmtTime(last.visit_time)}</div>
          <div className="grid2 small mb8">
            <div>⚖️ 体重 <b>{last.weight ?? '-'} g</b></div>
            <div>🟡 黄疸 <b>{last.bilirubin ?? '-'} µmol/L</b>（{last.bilirubin_site}）</div>
            <div>📟 设备编号：{last.device_no || '未记录'}</div>
            <div>喂养 {last.feeding_type} {last.feeding_freq} 次/日</div>
          </div>
          {last.doctor_advice && (
            <div className="advice-pre mb8" style={{ borderStyle: 'solid', borderColor: '#bfe6e4', background: 'var(--teal-soft)' }}>
              <b>🩺 医生建议：</b>{last.doctor_advice}
            </div>
          )}
          {last.flags.length > 0 && (
            <div className="alert-box warn" style={{ marginBottom: 8 }}>
              <b>风险说明</b>
              <ul className="flag-list" style={{ marginTop: 4 }}>{last.flags.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          <div className="advice-pre">{last.advice}</div>
        </div>
      )}

      <div className="card">
        <div className="card-title"><span className="dot" style={{ background: 'var(--teal)' }} />待办与提醒</div>
        {d.followups.length === 0 && <div className="small muted">暂无待办，按需喂养、注意脐部护理 🌿</div>}
        {d.followups.map((f) => (
          <div key={f.id} className="row between small" style={{ padding: '6px 0', borderBottom: '1px dashed var(--line)' }}>
            <span>【{f.type}】{f.title}{f.due_date ? `（${f.due_date} 前）` : ''}</span>
            <Badge color="amber">进行中</Badge>
          </div>
        ))}
      </div>

      <div className="grid2">
        <Link to="/family/docs" className="stat teal" style={{ display: 'block' }}>
          <div className="num" style={{ fontSize: 20 }}>📎</div>
          <div className="label">补充出生证明 / 出院小结 / 喂养记录</div>
        </Link>
        <Link to="/family/consult" className="stat coral" style={{ display: 'block' }}>
          <div className="num" style={{ fontSize: 20 }}>💬</div>
          <div className="label">线上咨询 / 申请改约</div>
        </Link>
      </div>
    </div>
  )
}

// 黄疸接近阈值：家属三选一
function ChoiceCard({ t, busy, onChoose }: { t: RecheckTask; busy: boolean; onChoose: (id: number, c: string) => void }) {
  const v = t.source_visit
  return (
    <div className="card" style={{ borderColor: 'var(--primary)' }}>
      <div className="row between mb8">
        <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--primary)' }} />黄疸接近转诊阈值，请选择处置方式</div>
      </div>
      {v && (
        <div className="small muted mb8">
          {fmtTime(v.visit_time)} 上门测量：黄疸 <b style={{ color: 'var(--primary)' }}>{v.bilirubin} µmol/L</b>（{v.bilirubin_site}，设备 {v.device_no || '未记录'}），
          喂养 {v.feeding_type} {v.feeding_freq} 次/日。
        </div>
      )}
      {v?.doctor_advice && <div className="small mb8" style={{ color: 'var(--teal)' }}>🩺 医生建议：{v.doctor_advice}</div>}
      <div className="small muted mb12">建议在 {t.due_date} 前完成复查。请根据宝宝情况选择：</div>
      <div className="recheck-choices">
        <button className="btn teal block" disabled={busy} onClick={() => onChoose(t.id, '复测')}>
          🏠 次日复测（护士上门复查）
        </button>
        <button className="btn primary block" disabled={busy} onClick={() => onChoose(t.id, '当天就诊')}>
          🏥 当天去儿科就诊
        </button>
        <button className="btn ghost block" disabled={busy} onClick={() => onChoose(t.id, '观察')}>
          👀 继续居家观察（生成复查提醒与风险告知）
        </button>
      </div>
    </div>
  )
}

// 已生成复测任务 / 观察中 / 已升级
function TaskCard({ t, busy, onChoose, scheduledTime }: {
  t: RecheckTask; busy: boolean; onChoose: (id: number, c: string) => void; scheduledTime?: string
}) {
  return (
    <div>
      {t.status === '待安排' && (
        <div className="card" style={{ borderColor: 'var(--teal)' }}>
          <div className="row between mb8">
            <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--teal)' }} />已选择次日复测</div>
            <Badge color="teal">等待安排</Badge>
          </div>
          <div className="small muted">社区正在为您安排<b>上门护士与测量设备</b>，安排完成后这里会显示护士姓名、设备编号和上门时间，请保持电话畅通。</div>
          <div className="row wrap mt8">
            <button className="btn ghost sm" disabled={busy} onClick={() => onChoose(t.id, '当天就诊')}>改主意：今天去儿科</button>
          </div>
        </div>
      )}

      {t.status === '待复测' && (
        <div className="card" style={{ borderColor: 'var(--teal)' }}>
          <div className="row between mb8">
            <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--teal)' }} />次日复测任务</div>
            <Badge color="teal">已安排</Badge>
          </div>
          <dl className="kv">
            <dt>上门护士</dt><dd>{t.assign_nurse_name || '待安排'}</dd>
            <dt>测量设备</dt><dd>📟 {t.device_no || '待安排'}</dd>
            <dt>计划时间</dt><dd>{scheduledTime ? fmtTime(scheduledTime) : `${t.due_date} 前后（具体时间以预约为准，可在下方「咨询改约」查看）`}</dd>
          </dl>
          <div className="alert-box info mt8" style={{ marginBottom: 8 }}>
            <b>复测前请准备：</b>
            <ul className="flag-list" style={{ marginTop: 4 }}>
              <li>复测前 24 小时的<b>喂养记录</b>：每次喂养时间、方式（母乳/配方奶）、奶量或喂养时长</li>
              <li><b>排便/排尿记录</b>：大小便次数与颜色（大便颜色变浅发白需立即就诊）</li>
            </ul>
            {t.remind_prepared
              ? <div className="small" style={{ color: 'var(--green)' }}>✔ {fmtTime(t.remind_at)} 已收到社区的准备提醒</div>
              : <div className="small muted">社区将在复测前再次提醒您准备以上记录</div>}
          </div>
          <div className="small muted">复测后系统会自动与前一天测量对比，若黄疸升高将直接生成转诊单供医院判断趋势。</div>
          <div className="small mt8"><Link to="/family/consult" className="btn ghost sm">如确需改约请点此申请（再次改约将转社区医生评估）</Link></div>
        </div>
      )}

      {t.status === '观察中' && (
        <div className="card" style={{ borderColor: 'var(--amber)' }}>
          <div className="row between mb8">
            <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--amber)' }} />居家观察 · 复查提醒</div>
            <Badge color="amber">观察中</Badge>
          </div>
          <div className="small muted mb8">社区将于 <b>{t.due_date}</b> 电话随访并安排复测；如不放心，您仍可随时改选次日复测或当天就诊。</div>
          {t.risk_notice && <pre className="risk-notice">{t.risk_notice}</pre>}
          <div className="row wrap mt8">
            <button className="btn teal sm" disabled={busy} onClick={() => onChoose(t.id, '复测')}>改选：次日复测</button>
            <button className="btn primary sm" disabled={busy} onClick={() => onChoose(t.id, '当天就诊')}>改选：当天去儿科</button>
          </div>
        </div>
      )}

      {t.status === '已升级' && (
        <div className="alert-box danger">
          <b>复测预约已再次改约（第 {t.reschedule_count} 次），任务已升级给社区医生。</b>
          <div className="small mt8">社区医生将判断是否需要<b>电话干预</b>劝说按时复测，或<b>建议直接到儿科就诊</b>，请保持电话畅通。黄疸接近阈值时不建议一再推迟复测。</div>
          {t.doctor_decision && <div className="small mt8">🩺 医生决定：{t.doctor_decision}{t.doctor_note ? `（${t.doctor_note}）` : ''}</div>}
        </div>
      )}

      {t.status === '已就诊' && (
        <div className="alert-box info">已登记您选择当天前往儿科就诊，就诊后请把结果告诉社区护士，也可以在「线上咨询」里留言。</div>
      )}
    </div>
  )
}

// 转诊单：前后两天测量对比，方便医院判断变化趋势
function ReferralCard({ r }: { r: Referral }) {
  return (
    <div className="card" style={{ borderColor: 'var(--red)' }}>
      <div className="row between mb8">
        <div className="card-title" style={{ margin: 0 }}><span className="dot" style={{ background: 'var(--red)' }} />转诊单 #{r.id} · 黄疸复测升高</div>
        <Badge color={r.status === '待就诊' ? 'red' : 'green'}>{r.status}</Badge>
      </div>
      <div className="small muted mb8">{a2baby(r)} · 开具时间 {fmtTime(r.created_at)} · {r.created_by}</div>
      <table className="trend-table">
        <thead>
          <tr><th>项目</th><th>前一天记录</th><th>本次复测</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>黄疸值</td>
            <td>{r.bilirubin_prev ?? '-'} µmol/L{r.bilirubin_site_prev ? `（${r.bilirubin_site_prev}）` : ''}</td>
            <td className="trend-up">{r.bilirubin_now ?? '-'} µmol/L{r.bilirubin_site_now ? `（${r.bilirubin_site_now}）` : ''}</td>
          </tr>
          <tr><td>出生日龄</td><td>第 {(r.age_days_prev ?? 0) + 1} 天</td><td>第 {(r.age_days_now ?? 0) + 1} 天（阈值 {r.threshold_now}）</td></tr>
          <tr><td>体重</td><td>{r.weight_prev ?? '-'} g</td><td>{r.weight_now ?? '-'} g</td></tr>
          <tr><td>喂养</td><td>{r.feeding_prev || '-'}</td><td>{r.feeding_now || '-'}</td></tr>
        </tbody>
      </table>
      {r.bilirubin_delta != null && (
        <div className="alert-box danger mt8" style={{ marginBottom: 8 }}>
          24 小时升高 <b>{r.bilirubin_delta} µmol/L</b>
        </div>
      )}
      <div className="small">📋 {r.trend_note}</div>
      <div className="small muted mt8">请携带本转诊单尽快到儿科就诊；前两天的测量部位、设备编号与医生建议已一并带给医院参考。</div>
      {r.status === '已就诊' && (
        <div className="small mt8" style={{ color: 'var(--green)' }}>
          ✔ {fmtTime(r.visited_at)} 已就诊反馈：{r.hospital_feedback || '已就诊'}
        </div>
      )}
    </div>
  )
}

function a2baby(r: Referral) {
  return `${r.mother_name || ''}家 · ${r.baby_name || ''}`
}
