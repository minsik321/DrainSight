import { useEffect, useState } from 'react'
import { ArrowRight, X } from '@phosphor-icons/react'
import MaintenanceAction from './MaintenanceAction.jsx'
import PriorityReasons from './PriorityReasons.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import { statusColor, statusLabel, statusDetail, formatTime } from '../format'

// 선택이 해제된 뒤 닫힘 모션이 끝날 때까지 마지막 빗물받이 정보를 유지한다.
export default function Inspector({
  drain,
  history,
  systemEvents,
  loading,
  error,
  weightProfile,
  onResolved,
  onClose,
  onViewDetails,
  open,
}) {
  const [visibleDrain, setVisibleDrain] = useState(drain)

  useEffect(() => {
    if (drain) setVisibleDrain(drain)
  }, [drain])

  if (!visibleDrain) return null

  const color = statusColor(visibleDrain.last_status)
  const detail = statusDetail(visibleDrain.last_status)

  return (
    <aside
      className={`inspector ${open && drain ? 'open' : ''}`}
      aria-label="빗물받이 상세 패널"
      aria-hidden={!open}
      onTransitionEnd={() => {
        if (!open) setVisibleDrain(null)
      }}
    >
      <div className="inspector-head">
        <div>
          <h2 className="inspector-title">
            {visibleDrain.name}
            <span className="inspector-code">{visibleDrain.external_code || '-'}</span>
          </h2>
        </div>
        <div className="inspector-head-actions">
          {onViewDetails && (
            <button
              type="button"
              className="btn btn-sm inspector-detail-button"
              onClick={() => onViewDetails(visibleDrain.id)}
            >
              상세보기
              <ArrowRight size={13} weight="bold" />
            </button>
          )}
          <button type="button" className="inspector-close" onClick={onClose} aria-label="패널 닫기">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="inspector-body">
        <section className="inspector-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="chip" style={{ '--chip-color': color }}>
              {statusLabel(visibleDrain.last_status)}
            </span>
            {detail && <span className="muted" style={{ fontSize: 12 }}>{detail}</span>}
          </div>
          <div className="status-card-figures" style={{ marginTop: 12, marginBottom: 0 }}>
            <span>
              <span className="figure-label">차폐율</span>
              <span className="figure-value">
                {visibleDrain.last_occlusion_pct != null
                  ? `${visibleDrain.last_occlusion_pct.toFixed(1)}%`
                  : '-'}
              </span>
            </span>
            <span>
              <span className="figure-label">우선순위</span>
              <span className="figure-value">
                {visibleDrain.priority_score != null ? visibleDrain.priority_score.toFixed(3) : '-'}
              </span>
            </span>
            <span>
              <span className="figure-label">마지막 판정</span>
              <span className="figure-value" style={{ fontSize: 12 }}>
                {formatTime(visibleDrain.last_updated)}
              </span>
            </span>
          </div>
        </section>

        <MaintenanceAction drain={visibleDrain} onResolved={onResolved} />
        <PriorityReasons drain={visibleDrain} weightProfile={weightProfile} />
        <HistoryPanel
          drain={visibleDrain}
          history={history}
          systemEvents={systemEvents}
          loading={loading}
          error={error}
        />
      </div>
    </aside>
  )
}
