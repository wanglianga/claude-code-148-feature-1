// 与服务端 server/risk.js 同构的风险评估，用于访视表单实时预评估
import type { Archive, Assessment, VisitPayload } from './types'

export function bilirubinThreshold(ageDays: number): number {
  if (ageDays <= 1) return 137
  if (ageDays === 2) return 205
  if (ageDays === 3) return 257
  return 291
}
const NEAR_GAP = 34

export function ageDaysOf(birthDate: string, at: string): number {
  const ms = new Date(at.replace(' ', 'T')).getTime() - new Date(birthDate.replace(' ', 'T')).getTime()
  return Math.max(0, Math.floor(ms / 86400000))
}

export function assessVisit(archive: Pick<Archive, 'birth_date' | 'birth_weight' | 'jaundice_risk' | 'care_ability'>, v: VisitPayload): Assessment {
  const flags: string[] = []
  const advice: string[] = []
  let level = 0
  let nearJaundice = false
  const raise = (l: number) => { if (l > level) level = l }

  const ageDays = ageDaysOf(archive.birth_date, v.visit_time)
  const threshold = bilirubinThreshold(ageDays)

  if (v.bilirubin != null && !Number.isNaN(v.bilirubin)) {
    const b = Number(v.bilirubin)
    if (b >= threshold) { raise(3); flags.push(`黄疸值 ${b} µmol/L 已达出生第 ${ageDays} 天光疗参考阈值 ${threshold}`); advice.push('黄疸值达到光疗参考阈值，建议立即转诊儿科评估。') }
    else if (b >= threshold - NEAR_GAP) { raise(2); nearJaundice = true; flags.push(`黄疸值 ${b} µmol/L 接近阈值 ${threshold}（差 ${threshold - b}）`); advice.push('黄疸值接近阈值，建议 24~48 小时内复查胆红素，加强喂养促进排泄。') }
    else if (b >= threshold - NEAR_GAP * 2) { raise(1); flags.push(`黄疸值 ${b} µmol/L 偏高，需动态观察`); advice.push('黄疸值偏高，注意复查随访，按需增加喂养次数。') }
  }
  if (archive.jaundice_risk === '高') { raise(Math.max(level, 1)); flags.push('黄疸高风险因素（血型不合/早产/低体重等），按高危儿管理') }

  let weightLossPct: number | null = null
  if (v.weight && archive.birth_weight) {
    weightLossPct = Math.round(((archive.birth_weight - v.weight) / archive.birth_weight) * 1000) / 10
    if (weightLossPct > 10) { raise(3); flags.push(`体重较出生下降 ${weightLossPct}%（超过 10%）`); advice.push('体重下降超过 10%，提示摄入不足，建议转诊儿科并立即安排母乳喂养指导。') }
    else if (weightLossPct > 7) { raise(2); flags.push(`体重较出生下降 ${weightLossPct}%（超过生理性下降 7%）`); advice.push('体重下降偏多，建议增加喂养频次并安排母乳指导，3 天内复测体重。') }
    else if (weightLossPct > 0) advice.push(`体重较出生下降 ${weightLossPct}%，属生理性范围，继续观察。`)
  }

  const freq = Number(v.feeding_freq || 0)
  if (freq > 0 && freq < 8) { raise(2); flags.push(`喂养频次 ${freq} 次/日，不足 8 次`); advice.push('喂养频次不足，建议每日 8~12 次，必要时安排母乳喂养指导。') }
  if (v.spit_up === '喷射性') { raise(2); flags.push('喷射性吐奶'); advice.push('出现喷射性吐奶，建议儿科就诊排除消化道问题。') }
  else if (v.spit_up === '频繁') { raise(1); flags.push('吐奶频繁'); advice.push('吐奶频繁，指导拍嗝与喂养姿势，少量多餐。') }

  if (v.stool_color === '白陶土色') { raise(3); flags.push('大便白陶土色（警惕胆道闭锁）'); advice.push('大便呈白陶土色，需尽快转诊儿科/肝胆专科检查。') }
  else if (v.stool_color === '血丝') { raise(2); flags.push('大便带血丝'); advice.push('大便带血丝，建议儿科就诊。') }
  if (Number(v.urine_count) > 0 && Number(v.urine_count) < 6) { raise(1); flags.push(`小便 ${v.urine_count} 次/日，偏少`); advice.push('小便次数偏少，提示摄入可能不足，注意加强喂养。') }

  if (['渗血', '渗液', '化脓', '异味'].includes(v.cord || '')) { raise(2); flags.push(`脐带${v.cord}`); advice.push(`脐带${v.cord}，指导脐部消毒护理，若加重及时就医。`) }
  if (v.sleep === '嗜睡') { raise(2); flags.push('嗜睡（警惕胆红素脑病早期）'); advice.push('婴儿嗜睡、反应差需警惕，建议尽快儿科评估。') }

  if (['低落', '异常'].includes(v.mood || '')) { raise(2); flags.push(`产妇情绪${v.mood}`); advice.push('产妇情绪异常，建议电话随访关怀，必要时转介心理/妇幼保健门诊。') }
  else if (v.mood === '焦虑') { raise(1); flags.push('产妇情绪焦虑'); advice.push('产妇情绪焦虑，加强心理疏导与家庭支持。') }
  if (['涨奶', '乳头皲裂', '红肿热痛'].includes(v.breast || '')) { raise(1); flags.push(`产妇乳房：${v.breast}`); advice.push(`乳房${v.breast}，安排母乳喂养指导，预防乳腺炎。`) }
  if (['红肿', '渗液'].includes(v.wound_check || '')) { raise(2); flags.push(`产妇伤口${v.wound_check}`); advice.push(`伤口${v.wound_check}，建议社区医生复诊或转妇科。`) }

  const care = v.care_ability || archive.care_ability
  if (care === '薄弱') { raise(1); flags.push('家庭照护能力薄弱'); advice.push('家庭照护能力薄弱，建议增加电话随访频次，必要时加访。') }

  if (v.device_issue) {
    flags.push('社区测量设备故障，本次为手工记录，建议尽快复测核实')
    advice.push('本次测量设备故障，数据为手工记录，建议设备恢复后复测。')
    if (level < 2) raise(1)
  }

  const needReferral = level >= 3 || v.stool_color === '白陶土色' || (weightLossPct != null && weightLossPct > 10)
  const needRecheck = !needReferral && (level >= 2 || (v.bilirubin != null && Number(v.bilirubin) >= threshold - NEAR_GAP * 2))
  const needLactation = (freq > 0 && freq < 8) || (weightLossPct != null && weightLossPct > 7) || ['涨奶', '乳头皲裂', '红肿热痛'].includes(v.breast || '')
  const needPhone = ['低落', '异常', '焦虑'].includes(v.mood || '') || care === '薄弱' || level >= 2

  if (advice.length === 0) advice.push('本次访视未见明显异常，按需喂养、注意脐部护理，不适随诊。')

  return {
    riskLevel: ['低', '中', '高', '危急'][level],
    flags, advice: advice.join('\n'),
    nearJaundice,
    needRecheck: needRecheck ? 1 : 0, needReferral: needReferral ? 1 : 0,
    needLactation: needLactation ? 1 : 0, needPhone: needPhone ? 1 : 0,
    ageDays, threshold, weightLossPct,
  }
}
