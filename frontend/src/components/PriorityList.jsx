import { useMemo, useState } from 'react'
import { SlidersHorizontal } from '@phosphor-icons/react'
import { statusColor, statusLabel, formatTime } from '../format'
import Pagination, { usePagination } from './Pagination.jsx'

const PAGE_SIZE = 8
const DISTRICTS = ['전체', '동남구', '서북구']
const DONGS = {
  동남구: ['신방동', '청수동', '신부동', '원성동', '문성동'],
  서북구: ['불당동', '쌍용동', '성정동', '두정동', '백석동'],
}
const SORT_OPTIONS = [
  { value: 'priority', label: '우선순위' },
  { value: 'recent', label: '최근관측' },
  { value: 'oldest', label: '오래된관측' },
  { value: 'name', label: '가나다순' },
]

function timeValue(iso) {
  if (!iso) return 0
  const hasTz = /Z$|[+-]\d\d:\d\d$/.test(iso)
  const time = new Date(hasTz ? iso : `${iso}Z`).getTime()
  return Number.isNaN(time) ? 0 : time
}

function areaMeta(drain) {
  const text = `${drain.name || ''} ${drain.external_code || ''}`
  const explicitDistrict = DISTRICTS.find((district) => district !== '전체' && text.includes(district))
  const district = explicitDistrict || (drain.lng >= 127.1 ? '동남구' : '서북구')
  const explicitDong = DONGS[district].find((dong) => text.includes(dong))
  const fallbackIndex = Math.abs(Number(drain.id) || 0) % DONGS[district].length
  return {
    district,
    dong: explicitDong || DONGS[district][fallbackIndex],
  }
}

// 표(table) 대신 행 단위 버튼. 각 행이 클릭 대상이자 선택 상태를 갖는 컨트롤이라
// 시맨틱상 button이 맞고, 모바일에서 열을 접기도 쉽다.
export default function PriorityList({ drains, selectedId, onSelect, sort = 'priority', emptyMessage }) {
  const [district, setDistrict] = useState('전체')
  const [dong, setDong] = useState('전체')
  const [sortMode, setSortMode] = useState(sort)
  const availableDongs = useMemo(() => {
    if (district === '전체') {
      return [...new Set([...DONGS.동남구, ...DONGS.서북구])]
    }
    return DONGS[district]
  }, [district])
  const sorted = useMemo(() => {
    return drains
      .filter((drain) => {
        const meta = areaMeta(drain)
        if (district !== '전체' && meta.district !== district) return false
        if (dong !== '전체' && meta.dong !== dong) return false
        return true
      })
      .sort((a, b) => {
        if (sortMode === 'recent') {
          const byTime = timeValue(b.last_updated) - timeValue(a.last_updated)
          if (byTime !== 0) return byTime
        }
        if (sortMode === 'oldest') {
          const byTime = timeValue(a.last_updated) - timeValue(b.last_updated)
          if (byTime !== 0) return byTime
        }
        if (sortMode === 'name') {
          return (a.name || '').localeCompare(b.name || '', 'ko')
        }
        return (b.priority_score ?? 0) - (a.priority_score ?? 0)
      })
  }, [drains, district, dong, sortMode])
  const maxScore = Math.max(0.0001, ...sorted.map((d) => d.priority_score ?? 0))
  const { page, setPage, totalPages, pageItems } = usePagination(sorted, PAGE_SIZE, {
    selectedKey: selectedId,
    getKey: (drain) => drain.id,
  })
  const rankOffset = (page - 1) * PAGE_SIZE

  if (sorted.length === 0) {
    return (
      <>
        <ListControls
          district={district}
          dong={dong}
          sortMode={sortMode}
          availableDongs={availableDongs}
          onDistrictChange={(next) => {
            setDistrict(next)
            setDong('전체')
          }}
          onDongChange={setDong}
          onSortChange={setSortMode}
        />
        <div className="empty">
          {emptyMessage || '표시할 지점이 없습니다.'}
        </div>
      </>
    )
  }

  return (
    <>
      <ListControls
        district={district}
        dong={dong}
        sortMode={sortMode}
        availableDongs={availableDongs}
        onDistrictChange={(next) => {
          setDistrict(next)
          setDong('전체')
        }}
        onDongChange={setDong}
        onSortChange={setSortMode}
      />
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
                <span className="priority-meta">
                  {areaMeta(d).district} {areaMeta(d).dong} · {d.external_code || `ID ${d.id}`} · 차폐율{' '}
                  {d.last_occlusion_pct != null ? `${d.last_occlusion_pct.toFixed(1)}%` : '-'} · 최근 판정{' '}
                  {formatTime(d.last_updated)}
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
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} label="빗물받이 목록" />
    </>
  )
}

function ListControls({
  district,
  dong,
  sortMode,
  availableDongs,
  onDistrictChange,
  onDongChange,
  onSortChange,
}) {
  return (
    <div className="list-controls">
      <div className="list-filter-group">
        <div className="list-tabs" role="tablist" aria-label="구 필터">
          {DISTRICTS.map((item) => (
            <button
              type="button"
              className={`list-tab ${district === item ? 'active' : ''}`}
              key={item}
              onClick={() => onDistrictChange(item)}
              role="tab"
              aria-selected={district === item}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="list-select-label">
          <span>동 선택</span>
          <select
            value={district === '전체' ? '전체' : dong}
            onChange={(event) => onDongChange(event.target.value)}
            disabled={district === '전체'}
          >
            <option value="전체">전체 동</option>
            {availableDongs.map((item) => (
              <option value={item} key={item}>{item}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="sort-select-label">
        <SlidersHorizontal size={15} weight="bold" />
        <span>정렬</span>
        <select value={sortMode} onChange={(event) => onSortChange(event.target.value)}>
          {SORT_OPTIONS.map((option) => (
            <option value={option.value} key={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </div>
  )
}
