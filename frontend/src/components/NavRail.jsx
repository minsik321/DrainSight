import {
  Broadcast,
  SquaresFour,
  MapTrifold,
  ListNumbers,
  Path,
  Truck,
  Sun,
  MoonStars,
} from '@phosphor-icons/react'

// 아이콘은 Phosphor 한 종류만 쓰고 굵기도 전역으로 1.5(regular 대신 duotone 없이)로 고정.
const ICON_PROPS = { size: 18, weight: 'regular' }

export const VIEWS = [
  { id: 'overview', label: '개요', Icon: Broadcast },
  { id: 'status', label: '현황', Icon: SquaresFour },
  { id: 'map', label: '지도', Icon: MapTrifold },
  { id: 'priority', label: '우선순위', Icon: ListNumbers },
  { id: 'route', label: '동선', Icon: Path },
  { id: 'fleet', label: '차량', Icon: Truck },
]

export default function NavRail({ current, onNavigate, counts = {}, theme, onToggleTheme }) {
  return (
    <nav className="rail" aria-label="주 메뉴">
      <div className="rail-brand">
        <span className="rail-mark" aria-hidden="true">
          <Broadcast size={15} weight="bold" />
        </span>
        <span className="rail-brand-text">
          <span className="rail-brand-name">drainSight</span>
          <span className="rail-brand-sub">천안시 빗물받이 관제</span>
        </span>
      </div>

      <div className="rail-nav">
        {VIEWS.map(({ id, label, Icon }) => {
          const count = counts[id]
          const active = current === id
          return (
            <button
              key={id}
              type="button"
              className={`rail-item ${active ? 'active' : ''}`}
              onClick={() => onNavigate(id)}
              aria-current={active ? 'page' : undefined}
              title={label}
            >
              <Icon className="rail-item-icon" {...ICON_PROPS} />
              <span className="rail-item-label">{label}</span>
              {count != null && <span className="rail-item-count">{count}</span>}
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className="rail-theme-toggle"
        onClick={onToggleTheme}
        title={theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'}
        aria-label={theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'}
      >
        {theme === 'light' ? <MoonStars size={16} weight="regular" /> : <Sun size={16} weight="regular" />}
        <span className="rail-theme-toggle-label">
          {theme === 'light' ? '다크 모드' : '라이트 모드'}
        </span>
      </button>

      <div className="rail-foot">
        판정은 차량 탑재 Pod가 보내고,
        <br />
        우선순위는 예보에 따라 재계산됩니다.
      </div>
    </nav>
  )
}
