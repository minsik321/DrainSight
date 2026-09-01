import { statusColor, statusLabel, statusDetail, formatTime, daysSince } from '../format'

export default function StatusCard({ drain, flashing, selected, onClick, staleThresholdDays }) {
  const color = statusColor(drain.last_status)
  const classes = ['status-card']
  if (selected) classes.push('selected')
  if (flashing) classes.push('flash')

  const elapsed = daysSince(drain.last_updated)
  const isStale =
    drain.last_updated == null ||
    (staleThresholdDays != null && elapsed != null && elapsed >= staleThresholdDays)
  const detail = statusDetail(drain.last_status)

  return (
    <button className={classes.join(' ')} style={{ '--status-color': color }} onClick={onClick}>
      <div className="status-card-top">
        <span className="status-card-title">{drain.name}</span>
        <span className="status-card-code">{drain.external_code || '-'}</span>
      </div>

      <div className="status-card-status">
        {statusLabel(drain.last_status)}
        {detail && <span className="status-card-code"> {detail}</span>}
      </div>

      <div className="status-card-figures">
        <span>
          <span className="figure-label">차폐율</span>
          <span className="figure-value">
            {drain.last_occlusion_pct != null ? `${drain.last_occlusion_pct.toFixed(1)}%` : '-'}
          </span>
        </span>
        <span>
          <span className="figure-label">우선순위</span>
          <span className="figure-value">
            {drain.priority_score != null ? drain.priority_score.toFixed(3) : '-'}
          </span>
        </span>
      </div>

      {drain.priority_reasons?.[0] && (
        <div className="status-card-reason">{drain.priority_reasons[0]}</div>
      )}

      <div className="status-card-time">
        {formatTime(drain.last_updated)}
        {isStale && (
          <span className="stale-badge">
            {drain.last_updated == null ? '미점검' : `${Math.floor(elapsed)}일 경과`}
          </span>
        )}
      </div>
    </button>
  )
}
