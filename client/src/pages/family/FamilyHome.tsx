// 家属端首页：护理建议、复查时间、风险说明
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import type { FamilyOverview } from '../../types'
import { AgeText, Badge, Empty, RiskBadge, fmtTime } from '../../components/ui'
import JaundiceFlow from './JaundiceFlow'

export default function FamilyHome() {
  const [d, setD] = useState<FamilyOverview | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    api.get<FamilyOverview>('/api/family/overview').then(setD).catch((e) => setErr(e.message))
  }, [])
  useEffect(load, [])

  if (err) return <div className="alert-box danger">{err}</div>
  if (!d) return <Empty text="加载中…" icon="⏳" />
  const a = d.archive
  const last = d.visits[0]
  const recheck = d.followups.find((f) => f.type === '复查')
  const referral = d.followups.find((f) => f.type === '转诊')
  // 临界值流程已自带转诊单/复测任务卡时，不再重复显示通用提醒
  const jaundiceReferral = (d.referrals || []).some((r) => r.status !== '已闭环')
  const jaundiceRecheck = !!d.jaundicePlan?.recheckTask && d.jaundicePlan.choice === 'recheck'

  return (
    <div>
      <div className="page-title">{a.baby_name} 的护理档案</div>
      <div className="page-sub">妈妈 {a.mother_name} · <AgeText birthDate={a.birth_date} /> · 出生体重 {a.birth_weight}g</div>

      <JaundiceFlow d={d} reload={load} />

      {referral && !jaundiceReferral && (
        <div className="alert-box danger">
          <b>转诊提醒：</b>{referral.detail || referral.title}。请尽快带宝宝到儿科就诊，就诊后请告知社区护士。
        </div>
      )}
      {recheck && !jaundiceRecheck && (
        <div className="alert-box warn">
          <b>复查提醒：</b>建议 {recheck.due_date || '近期'} 前复查黄疸/体重。
          {d.nextAppointment && <>护士将于 <b>{fmtTime(d.nextAppointment.scheduled_time)}</b> 上门。</>}
        </div>
      )}
      {!recheck && !referral && d.nextAppointment && (
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
            <div>🟡 黄疸 <b>{last.bilirubin ?? '-'} µmol/L</b></div>
          </div>
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
