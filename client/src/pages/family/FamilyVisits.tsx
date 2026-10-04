// 家属端：历次访视记录与护理建议
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { FamilyOverview } from '../../types'
import { Badge, Empty, RiskBadge, fmtTime } from '../../components/ui'

export default function FamilyVisits() {
  const [d, setD] = useState<FamilyOverview | null>(null)
  useEffect(() => { api.get<FamilyOverview>('/api/family/overview').then(setD) }, [])
  if (!d) return <Empty text="加载中…" icon="⏳" />
  if (d.visits.length === 0) return <Empty text="还没有访视记录，护士首次上门后这里会显示护理建议" icon="🩺" />

  return (
    <div>
      <div className="page-title">访视与护理建议</div>
      {d.visits.map((v) => (
        <div key={v.id} className="card">
          <div className="row between">
            <span className="strong">{fmtTime(v.visit_time)}</span>
            <RiskBadge level={v.risk_level} />
          </div>
          <div className="grid2 mt8 small">
            <div>⚖️ 体重 {v.weight ?? '-'} g</div>
            <div>🟡 黄疸 {v.bilirubin ?? '-'} µmol/L（{v.bilirubin_site}）</div>
            <div>📟 设备 {v.device_no || '未记录'}</div>
            <div>喂养 {v.feeding_type} {v.feeding_freq} 次/日</div>
            <div>大便 {v.stool_count} 次（{v.stool_color}）</div>
            <div>小便 {v.urine_count} 次</div>
          </div>
          {v.doctor_advice && (
            <div className="advice-pre mt8" style={{ borderStyle: 'solid', borderColor: '#bfe6e4', background: 'var(--teal-soft)' }}>
              <b>🩺 医生建议：</b>{v.doctor_advice}
            </div>
          )}
          {v.flags.length > 0 && (
            <div className="mt8">
              {v.flags.map((f, i) => <Badge key={i} color="amber"> {f} </Badge>)}
            </div>
          )}
          <div className="mt12">
            <div className="small strong mb8">护士建议</div>
            <div className="advice-pre">{v.advice}</div>
          </div>
          {v.photos.length > 0 && (
            <div className="photo-row mt8">{v.photos.map((p, i) => <img key={i} src={p} alt={`访视照片${i + 1}`} />)}</div>
          )}
        </div>
      ))}
    </div>
  )
}
