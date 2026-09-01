import { X } from '@phosphor-icons/react'
import MaintenanceAction from './MaintenanceAction.jsx'
import PriorityReasons from './PriorityReasons.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import { statusColor, statusLabel, statusDetail, formatTime } from '../format'

// 선택된 지점의 상세는 뷰를 옮겨도 따라다녀야 한다 — 지도에서 찍은 지점을 우선순위
// 화면에서 다시 찾게 만들면 안 되기 때문에, 뷰가 아니라 셸에 고정된 우측 패널로 둔다.
export default function Inspector({
  drain,
  history,
  systemEvents,
  loading,
  error,
  weightProfile,
  onResolved,
  onClose,
  forced,
}) {
  if (!drain) {
    return (
      <aside className={`inspector ${forced ? 'inspector-forced' : ''}`} aria-label="선택한 지점 상세">
        <p className="inspector-empty">
          지도, 카드, 우선순위 목록에서
          <br />
          빗물받이를 선택하면
          <br />
          판정 근거와 이력이 여기 표시됩니다.
        </p>
      </aside>
    )
  }

  const color = statusColor(drain.last_status)
  const detail = statusDetail(drain.last_status)

  return (
    <aside className={`inspector ${forced ? 'inspector-forced' : ''}`} aria-label="선택한 지점 상세">
      <div className="inspector-head">
        <div>
          <h2 className="inspector-title">
            {drain.name}
            <span className="inspector-code">{drain.external_code || '-'}</span>
          </h2>
        </div>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="상세 닫기">
          <X size={16} />
        </button>
      </div>

      <section className="inspector-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="chip" style={{ '--chip-color': color }}>
            {statusLabel(drain.last_status)}
          </span>
          {detail && <span className="muted" style={{ fontSize: 12 }}>{detail}</span>}
        </div>
        <div className="status-card-figures" style={{ marginTop: 12, marginBottom: 0 }}>
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
          <span>
            <span className="figure-label">마지막 판정</span>
            <span className="figure-value" style={{ fontSize: 12 }}>
              {formatTime(drain.last_updated)}
            </span>
          </span>
        </div>
      </section>

      <MaintenanceAction drain={drain} onResolved={onResolved} />
      <PriorityReasons drain={drain} weightProfile={weightProfile} />
      <HistoryPanel
        drain={drain}
        history={history}
        systemEvents={systemEvents}
        loading={loading}
        error={error}
      />
    </aside>
  )
}
