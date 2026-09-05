import { statusColor, statusLabel, reasonLabel, formatTime } from '../format'
import Pagination, { usePagination } from './Pagination.jsx'

export default function HistoryPanel({ drain, history, systemEvents = [], loading, error }) {
  const { page, setPage, totalPages, pageItems } = usePagination(history, 8, {
    resetKey: drain?.id,
  })

  if (!drain) return null

  return (
    <>
      <section className="inspector-section">
        <h3>판정 이력</h3>
        {loading && <p className="muted">불러오는 중...</p>}
        {error && <div className="error-banner">이력 로드 실패: {error}</div>}
        {!loading && !error && history.length === 0 && (
          <p className="muted">아직 이 지점의 판정 기록이 없습니다.</p>
        )}
        {!loading && !error && history.length > 0 && (
          <>
            <ul className="history-list">
              {pageItems.map((h) => (
                <li key={h.id} className="history-item">
                  <span className="chip chip-sm" style={{ '--chip-color': statusColor(h.status) }}>
                    {statusLabel(h.status)}
                  </span>
                  <span className="history-time">{formatTime(h.captured_at)}</span>
                  <span className="history-item-figures">
                    차폐 {h.occlusion_pct != null ? `${h.occlusion_pct.toFixed(1)}%` : '-'} / 신뢰도{' '}
                    {h.confidence != null ? h.confidence.toFixed(2) : '-'}
                  </span>
                  <span className="history-item-meta">
                    <span>
                      {h.vehicle_code
                        ? `${h.vehicle_code}${h.vehicle_type ? ` (${h.vehicle_type})` : ''}`
                        : '차량 미상'}
                    </span>
                    <span>{h.source || '-'}</span>
                    {h.reason_code && <span>{reasonLabel(h.reason_code)}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              label={`${drain.name} 이력`}
            />
          </>
        )}
      </section>

      {/* 시스템 이벤트는 장비/네트워크 사건이지 빗물받이의 물리적 상태가 아니다.
          같은 목록에 섞으면 "판정 결과"로 오해되므로 절대 합치지 말 것. */}
      {!loading && !error && systemEvents.length > 0 && (
        <section className="inspector-section">
          <h3>시스템 이벤트</h3>
          <ul className="history-list">
            {systemEvents.map((event) => (
              <li key={event.id} className="history-item">
                <span className="chip chip-sm">판정 결과 미수신</span>
                <span className="history-time">{formatTime(event.occurred_at)}</span>
                <span className="history-item-meta">
                  <span>{event.detail || event.event_type}</span>
                  <span>{event.source || '-'}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
