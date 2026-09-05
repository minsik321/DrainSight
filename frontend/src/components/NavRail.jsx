import {
  Broadcast,
  SquaresFour,
  ChartBar,
  ListNumbers,
  Path,
  Truck,
  Sun,
  MoonStars,
} from '@phosphor-icons/react'
import drainSightLogo from '../assets/drainsight_logo.svg'

// 아이콘은 Phosphor 한 종류만 쓰고 굵기도 전역으로 1.5(regular 대신 duotone 없이)로 고정.
const ICON_PROPS = { size: 18, weight: 'regular' }

export const VIEWS = [
  { id: 'overview', label: '현황', Icon: Broadcast },
  { id: 'list', label: '목록', Icon: ListNumbers },
  { id: 'analysis', label: '분석', Icon: ChartBar },
  { id: 'route', label: '동선', Icon: Path },
  { id: 'fleet', label: '차량', Icon: Truck },
]

export default function NavRail({ current, onNavigate, counts = {}, theme, onToggleTheme }) {
  return (
    <nav className="rail" aria-label="주 메뉴">
      <div className="rail-brand">
        <img className="rail-brand-logo" src={drainSightLogo} alt="drainSight" />
        <span className="rail-brand-sub">천안시 빗물받이 관제</span>
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
