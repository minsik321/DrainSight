const METRICS = [
  { key: 'occlusion_norm', label: '차폐율', weightKey: 'occlusion' },
  { key: 'flood_history_flag', label: '침수 이력', weightKey: 'flood_history' },
  { key: 'elevation_risk', label: '고도 위험도', weightKey: 'elevation' },
  { key: 'staleness_risk', label: '미점검 경과', weightKey: 'staleness' },
]

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
            return (
              <div className={`reason-metric ${inactive ? 'reason-metric-inactive' : ''}`} key={m.key}>
                <span className="reason-metric-label">
                  {m.label}
                  {weight != null && <span className="reason-metric-weight"> ×{weight.toFixed(2)}</span>}
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
