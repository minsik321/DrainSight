import { useMemo } from 'react'
import AmbientMap from '../components/AmbientMap.jsx'
import { statusColor, statusLabel, formatTime, weatherModeLabel, daysSince } from '../format'

const METRICS = [
  { key: 'blocked', label: '막힘', status: 'BLOCKED' },
  { key: 'occluded', label: '부분 차폐', status: 'OCCLUDED' },
  { key: 'unassessable', label: '판정 불가', status: 'UNASSESSABLE' },
  { key: 'stale', label: '기준일 초과', status: 'OCCLUDED' },
  { key: 'clear', label: '정상', status: 'CLEAR' },
]

export default function OverviewView({ drains, actionDrains, weatherAlert, wsConnected, onInspect }) {
  const staleDays = weatherAlert?.staleness_threshold_days ?? 14

  const counts = useMemo(() => {
    const c = { blocked: 0, occluded: 0, unassessable: 0, stale: 0, clear: 0 }
    for (const d of drains) {
      if (d.last_status === 'BLOCKED') c.blocked += 1
      else if (d.last_status === 'OCCLUDED') c.occluded += 1
      else if (d.last_status === 'UNASSESSABLE') c.unassessable += 1
      else if (d.last_status === 'CLEAR') c.clear += 1

      const elapsed = daysSince(d.last_updated)
      if (d.last_updated == null || (elapsed != null && elapsed >= staleDays)) c.stale += 1
    }
    return c
  }, [drains, staleDays])

  // 가장 최근에 들어온 판정 시각. Pod가 살아있는지를 보여주는 유일한 지표라 여기 둔다.
  const lastSeen = useMemo(() => {
    let latest = null
    for (const d of drains) {
      if (!d.last_updated) continue
      if (latest == null || d.last_updated > latest) latest = d.last_updated
    }
    return latest
  }, [drains])

  const top = useMemo(
    () => [...actionDrains].sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0)).slice(0, 3),
    [actionDrains],
  )

  const needCount = actionDrains.length
  const allClear = needCount === 0

  return (
    <div className="overview">
      <AmbientMap drains={drains} />
      <div className="overview-scrim" />
      <div className="overview-grid" />
      <div className="overview-sweep" />
      <div className="overview-frame" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>

      <div className="overview-body">
        <div>
          <h1 className={`ov-headline ${allClear ? 'ov-headline-clear' : ''}`}>
            {allClear ? (
              <>지금 조치가 필요한 지점은 없습니다</>
            ) : (
              <>
                지금 조치가 필요한 지점 <span className="num">{needCount}</span>곳
              </>
            )}
          </h1>
          <p className="ov-sub">
            천안 동남구 <strong>{drains.length}개</strong> 빗물받이를 차량 탑재 Pod가 지나갈 때마다
            판정합니다. 현재 <strong>{weatherModeLabel(weatherAlert?.mode)}</strong> 기준으로 차폐율{' '}
            <strong>{weatherAlert?.occlusion_threshold ?? 70}%</strong> 이상이거나{' '}
            <strong>{staleDays}일</strong> 넘게 점검되지 않은 지점을 조치 대상으로 봅니다.
          </p>
        </div>

        <div className="ov-metrics">
          {METRICS.map((m) => (
            <div className="ov-metric" key={m.key} style={{ '--metric-color': statusColor(m.status) }}>
              <span className={`ov-metric-value ${counts[m.key] === 0 ? 'is-zero' : ''}`}>
                {counts[m.key]}
              </span>
              <span className="ov-metric-label">{m.label}</span>
            </div>
          ))}
        </div>

        {top.length > 0 && (
          <div>
            <h2 className="ov-urgent-head">가장 급한 지점</h2>
            <div className="ov-urgent">
              {top.map((d, i) => {
                const color = statusColor(d.last_status)
                return (
                  <button
                    type="button"
                    key={d.id}
                    className="ov-urgent-row"
                    style={{ '--row-color': color }}
                    onClick={() => onInspect(d.id)}
                  >
                    <span className="ov-urgent-rank">{i + 1}</span>
                    <span>
                      <span className="ov-urgent-name">{d.name}</span>
                      <span className="ov-urgent-reason">
                        {d.priority_reasons?.[0] || '점검 기록 없음'}
                      </span>
                    </span>
                    <span className="chip chip-sm" style={{ '--chip-color': color }}>
                      {statusLabel(d.last_status)}
                    </span>
                    <span className="ov-urgent-score">
                      {d.priority_score != null ? d.priority_score.toFixed(3) : '-'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <p className="ov-foot">
          마지막 판정 수신 {formatTime(lastSeen)}
          <br />
          {wsConnected
            ? '실시간 연결이 유지되고 있습니다.'
            : '실시간 연결이 끊겨 1초 간격 조회로 대체 중입니다.'}
        </p>
      </div>
    </div>
  )
}
