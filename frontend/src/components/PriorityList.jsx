import { statusColor, statusLabel } from '../format'
import Pagination, { usePagination } from './Pagination.jsx'

const PAGE_SIZE = 8

// 표(table) 대신 행 단위 버튼. 각 행이 클릭 대상이자 선택 상태를 갖는 컨트롤이라
// 시맨틱상 button이 맞고, 모바일에서 열을 접기도 쉽다.
export default function PriorityList({ drains, selectedId, onSelect }) {
  const sorted = [...drains].sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
  const maxScore = Math.max(0.0001, ...sorted.map((d) => d.priority_score ?? 0))
  const { page, setPage, totalPages, pageItems } = usePagination(sorted, PAGE_SIZE, {
    selectedKey: selectedId,
    getKey: (drain) => drain.id,
  })
  const rankOffset = (page - 1) * PAGE_SIZE

  if (sorted.length === 0) {
    return (
      <div className="empty">
        현재 조치 기준을 넘는 지점이 없습니다.
        <br />
        예보 모드를 올리면 더 낮은 차폐율도 조치 대상이 됩니다.
      </div>
    )
  }

  return (
    <>
      <div className="priority-list">
        {pageItems.map((d, i) => {
          const score = d.priority_score ?? 0
          const color = statusColor(d.last_status)
          return (
            <button
              type="button"
              key={d.id}
              className={`priority-row ${selectedId === d.id ? 'selected' : ''}`}
              style={{ '--row-color': color }}
              onClick={() => onSelect(d.id)}
              aria-pressed={selectedId === d.id}
            >
              <span className="priority-rank">{rankOffset + i + 1}</span>
              <span>
                <span className="priority-name">{d.name}</span>
                <span className="priority-reason">
                  {d.priority_reasons?.[0] || '점검 기록 없음'}
                </span>
              </span>
              <span className="chip chip-sm" style={{ '--chip-color': color }}>
                {statusLabel(d.last_status)}
              </span>
              <span className="score-bar">
                <span
                  className="score-bar-fill"
                  style={{ '--fill': score / maxScore }}
                />
              </span>
              <span className="score-value">{score.toFixed(3)}</span>
            </button>
          )
        })}
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} label="우선순위 목록" />
    </>
  )
}
