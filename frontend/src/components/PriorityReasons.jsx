const METRICS = [
  { key: 'occlusion_norm', label: '차폐율', weightKey: 'occlusion' },
  { key: 'flood_history_flag', label: '침수 이력', weightKey: 'flood_history' },
  { key: 'elevation_risk', label: '고도 위험도', weightKey: 'elevation' },
  { key: 'staleness_risk', label: '미점검 경과', weightKey: 'staleness' },
]

// 각 지표가 어디서 왔는지 — analytics.py/rainfall.py/weather_source와 같은 "출처를 숨기지
// 않는다" 원칙을 우선순위 근거 패널까지 확장(v2.17). 차폐율만 drain마다 달라질 수 있어
// last_source(가장 최근 판정을 보낸 쪽)로 동적으로 판정하고, 나머지 세 지표는 이 시스템에서
// 항상 같은 방식으로 채워지는 정적 값이라 고정 라벨을 쓴다.
function sourceLabel(key, drain) {
  if (key === 'occlusion_norm') {
    if (drain.last_source === 'pi') return { text: '실기기 판정', tone: 'live' }
    if (drain.last_source === 'simulator') return { text: '데모(시뮬레이터)', tone: 'demo' }
    return null // 한 번도 판정된 적 없음 — value 자체가 '-'로 표시되므로 배지 불필요
  }
  if (key === 'elevation_risk') {
    return drain.elevation != null ? { text: 'Open-Elevation 실측', tone: 'live' } : null
  }
  if (key === 'flood_history_flag') {
    return { text: '수동 입력값', tone: 'static' }
  }
  if (key === 'staleness_risk') {
    return { text: '자동 계산값', tone: 'static' }
  }
  return null
}

export default function PriorityReasons({ drain, weightProfile }) {
  if (!drain) return null

  const reasons = drain.priority_reasons || []
  const hasMetrics = METRICS.some((m) => drain[m.key] != null)
  if (reasons.length === 0 && !hasMetrics) return null

  return (
    <section className="inspector-section">
      <h3>우선순위 근거</h3>

      {reasons.length > 0 && (
        <ul className="reason-list">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {hasMetrics && (
        <div className="reason-metrics">
          {METRICS.map((m) => {
            const value = drain[m.key]
            const weight = weightProfile?.[m.weightKey]
            const inactive = weight === 0
const fill = value != null ? Math.max(0, Math.min(1, value)) : 0
            const source = sourceLabel(m.key, drain)
            return (
              <div className={`reason-metric ${inactive ? 'reason-metric-inactive' : ''}`} key={m.key}>
                <span className="reason-metric-label">
                  {m.label}
                  {weight != null && <span className="reason-metric-weight"> ×{weight.toFixed(2)}</span>}
                  {source && (
                    <span className={`reason-metric-source reason-metric-source-${source.tone}`}>
                      {source.text}
                    </span>
                  )}
                </span>
                <span className="reason-metric-value">{value != null ? value.toFixed(2) : '-'}</span>
                <span className="score-bar">
                  <span className="score-bar-fill" style={{ '--fill': fill }} />
                </span>
              </div>
            )
          })}
        </div>
      )}

      {weightProfile && (
        <p className="reason-note">
          가중치가 0인 항목(흐리게 표시)은 값이 있어도 현재 모드의 점수에 반영되지 않습니다.
        </p>
      )}
    </section>
  )
}
