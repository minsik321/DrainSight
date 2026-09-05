import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowsClockwise,
  ArrowCounterClockwise,
  DownloadSimple,
  Eye,
  ShareNetwork,
  Warning,
  X,
} from '@phosphor-icons/react'
import { fetchDrains, fetchHistory, fetchSystemEvents, fetchWeatherAlert, refreshPriority, setWeatherMode, wsUrl } from './api'
import NavRail, { VIEWS } from './components/NavRail.jsx'
import ModeControl from './components/ModeControl.jsx'
import TopbarSearch from './components/TopbarSearch.jsx'
import Inspector from './components/Inspector.jsx'
import MaintenanceAction from './components/MaintenanceAction.jsx'
import PriorityMap, { MapLegend } from './components/PriorityMap.jsx'
import PriorityList from './components/PriorityList.jsx'
import RoutePlanner from './components/RoutePlanner.jsx'
import VehiclePanel from './components/VehiclePanel.jsx'
import HistoryPanel from './components/HistoryPanel.jsx'
import OverviewView from './views/OverviewView.jsx'
import drainSampleImage from './assets/drain_sample.jpeg'
import qrSampleImage from './assets/qr_sample.png'
import { formatTime } from './format'

const POLL_MS = 1000 // WS 연결이 끊겼을 때만 쓰는 폴백 주기
const FLASH_MS = 1800
const WS_RECONNECT_BASE_MS = 1000
const WS_RECONNECT_MAX_MS = 8000

const VIEW_IDS = new Set(VIEWS.map((v) => v.id))
const DEFAULT_VIEW = 'overview'

const LEGACY_VIEW_MAP = {
  status: 'list',
  map: 'overview',
  priority: 'list',
}

const DETAIL_METRICS = [
  { key: 'occlusion_norm', label: '차폐율' },
  { key: 'flood_history_flag', label: '침수 이력' },
  { key: 'elevation_risk', label: '고도 위험도' },
  { key: 'staleness_risk', label: '미점검 경과' },
]

// 이 화면들은 지도가 목록과 나란히 화면을 가득 채우므로 뷰 여백을 없앤다(여백은
// split-list/map-view 쪽에서 각자 처리).
const FLUSH_VIEWS = new Set(['overview', 'fleet'])
const SHOW_ROUTE_DRAFT = false

function readHashView() {
  const id = window.location.hash.replace(/^#\/?/, '')
  if (LEGACY_VIEW_MAP[id]) return LEGACY_VIEW_MAP[id]
  return VIEW_IDS.has(id) ? id : DEFAULT_VIEW
}

function occlusionSeries(history, drain) {
  const measured = history
    .filter((item) => item.occlusion_pct != null)
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((item) => ({
      label: formatTime(item.created_at),
      value: item.occlusion_pct,
    }))

  if (measured.length > 0) return measured

  const value = drain?.last_occlusion_pct ?? 0
  return [
    { label: '이전', value: Math.max(0, value - 8) },
    { label: '현재', value },
  ]
}

function OcclusionTrendChart({ history, drain }) {
  const points = occlusionSeries(history, drain)
  const width = 520
  const height = 220
  const pad = 28
  const innerWidth = width - pad * 2
  const innerHeight = height - pad * 2
  const xStep = points.length > 1 ? innerWidth / (points.length - 1) : 0
  const coords = points.map((point, index) => {
    const x = pad + index * xStep
    const y = pad + innerHeight - (Math.max(0, Math.min(100, point.value)) / 100) * innerHeight
    return { ...point, x, y }
  })
  const path = coords.map((point) => `${point.x},${point.y}`).join(' ')
  const latest = points[points.length - 1]?.value ?? 0

  return (
    <div className="occlusion-chart">
      <div className="occlusion-chart-top">
        <span>최근 차폐율</span>
        <strong>{latest.toFixed(1)}%</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="차폐율 시계열 차트">
        {[0, 25, 50, 75, 100].map((tick) => {
          const y = pad + innerHeight - (tick / 100) * innerHeight
          return (
            <g key={tick}>
              <line className="chart-grid-line" x1={pad} x2={width - pad} y1={y} y2={y} />
              <text className="chart-tick" x={8} y={y + 4}>{tick}</text>
            </g>
          )
        })}
        <polyline className="chart-line" points={path} />
        {coords.map((point, index) => (
          <circle className="chart-dot" key={`${point.label}-${index}`} cx={point.x} cy={point.y} r="4" />
        ))}
      </svg>
    </div>
  )
}

function DetailMetricGraphs({ drain }) {
  return (
    <div className="detail-metric-graphs">
      {DETAIL_METRICS.map((metric) => {
        const value = drain?.[metric.key]
        const fill = value != null ? Math.max(0, Math.min(1, value)) : 0
        return (
          <div className="detail-metric" key={metric.key}>
            <div className="detail-metric-head">
              <span>{metric.label}</span>
              <strong>{value != null ? value.toFixed(2) : '-'}</strong>
            </div>
            <span className="detail-metric-track">
              <span className="detail-metric-fill" style={{ '--fill': fill }} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

function buildDraftRoutes(count, drains = []) {
  const routeCount = Math.max(1, Math.min(12, Number(count) || 1))
  const candidates = [...drains]
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .slice(0, Math.max(routeCount * 2, routeCount))

  return Array.from({ length: routeCount }, (_, index) => {
    const stops = candidates.filter((_, stopIndex) => stopIndex % routeCount === index)
    const priority = stops.reduce((sum, drain) => sum + (drain.priority_score ?? 0), 0)
    return {
      id: index + 1,
      name: `동선 ${index + 1}`,
      team: `${index + 1}팀`,
      path: stops.map((drain) => drain.name).join(' → ') || '배정 대기',
      distance: `${(2.4 + index * 0.8 + stops.length * 0.35).toFixed(1)}km`,
      duration: `${Math.round(18 + index * 6 + stops.length * 5)}분`,
      priority,
      stops,
    }
  })
}

const THEME_STORAGE_KEY = 'dvp-theme-toss'

// 관제 콘솔이라 기본은 다크 — 시스템 설정을 따라가지 않고, 사용자가 명시적으로
// 고른 값만 저장/복원한다(껐다 켜도 매번 시스템 설정으로 되돌아가지 않도록).
function readStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'dark' ? 'dark' : 'light'
}

export default function App() {
  const [drains, setDrains] = useState(null)
  const [error, setError] = useState(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [listDetailId, setListDetailId] = useState(null)
  const [history, setHistory] = useState([])
  const [systemEvents, setSystemEvents] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(null)
  const [flashIds, setFlashIds] = useState(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [routePlan, setRoutePlan] = useState(null)
  const [weatherAlert, setWeatherAlert] = useState(null)
  const [weatherToastVisible, setWeatherToastVisible] = useState(false)
  const [modeChanging, setModeChanging] = useState(false)
  const [vehicleMapSelection, setVehicleMapSelection] = useState(null)
  const [selectedVehicleId, setSelectedVehicleId] = useState(null)
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  const [routeTeamCount, setRouteTeamCount] = useState(2)
  const [draftRoutes, setDraftRoutes] = useState([])
  const [view, setView] = useState(readHashView)
  const [theme, setTheme] = useState(readStoredTheme)

  // holds the latest scores/list so WS/poll callbacks can merge without stale closures
  const prevScoresRef = useRef(new Map())
  const drainsRef = useRef(null)
  const pollIntervalRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const reconnectDelayRef = useRef(WS_RECONNECT_BASE_MS)
  const wsRef = useRef(null)
  const mountedRef = useRef(true)
  const weatherToastShownRef = useRef(false)

  // 뷰는 해시에 담는다 — 데모 중 새로고침해도 보던 화면이 유지되고, 뒤로가기도 동작한다.
  useEffect(() => {
    const onHashChange = () => setView(readHashView())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((id, options = {}) => {
    if (!options.preserveSelection && id !== view) {
      setSelectedId(null)
      setListDetailId(null)
    }
    window.location.hash = `#/${id}`
    setView(id)
  }, [view])

  // data-theme 속성 하나로 App.css 전체 토큰이 갈아끼워진다.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    if (view !== 'list') {
      setListDetailId(null)
    }
  }, [view])

  useEffect(() => {
    if (!weatherAlert?.active || weatherToastShownRef.current) return
    weatherToastShownRef.current = true
    setWeatherToastVisible(true)
    const timer = setTimeout(() => setWeatherToastVisible(false), 6000)
    return () => clearTimeout(timer)
  }, [weatherAlert?.active])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))
  }, [])

  function flashRisen(updates) {
    const prev = prevScoresRef.current
    const risen = updates
      .filter((d) => {
        const prevScore = prev.get(d.id)
        return prevScore !== undefined && d.priority_score != null && d.priority_score > prevScore
      })
      .map((d) => d.id)

    updates.forEach((d) => prev.set(d.id, d.priority_score))

    if (risen.length > 0) {
      setFlashIds((curr) => new Set([...curr, ...risen]))
      risen.forEach((id) => {
        setTimeout(() => {
          setFlashIds((curr) => {
            const next = new Set(curr)
            next.delete(id)
            return next
          })
        }, FLASH_MS)
      })
    }
  }

  // payload is either one drain (POST /api/detections broadcast) or the full list
  // (GET /api/drains, POST /api/priority/refresh, or its WS broadcast) — merge either way
  function ingest(payload) {
    const updates = Array.isArray(payload) ? payload : [payload]
    flashRisen(updates)

    const merged = new Map((drainsRef.current || []).map((d) => [d.id, d]))
    updates.forEach((d) => merged.set(d.id, d))
    const next = Array.from(merged.values()).sort((a, b) => a.id - b.id)
    drainsRef.current = next
    setDrains(next)
    setError(null)
  }

  function startPollingFallback() {
    if (pollIntervalRef.current) return
    pollIntervalRef.current = setInterval(async () => {
      try {
        ingest(await fetchDrains())
      } catch (e) {
        setError(e.message)
      }
    }, POLL_MS)
  }

  function stopPollingFallback() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }

  function connectWs() {
    const ws = new WebSocket(wsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      setWsConnected(true)
      setError(null)
      reconnectDelayRef.current = WS_RECONNECT_BASE_MS
      stopPollingFallback() // WS가 살아있으니 폴백 폴링은 끔 — 끊기면 onclose에서 다시 켠다
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (!Array.isArray(payload) && payload.type === 'weather_alert') {
          setWeatherAlert(payload)
        } else {
          ingest(payload)
        }
      } catch {
        // 손상된 프레임 하나 때문에 연결 전체를 끊지 않고 다음 메시지로 넘어감
      }
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setWsConnected(false)
      startPollingFallback() // 현장 Wi-Fi가 끊겨도 대시보드가 멈추지 않도록 폴링으로 대체
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, WS_RECONNECT_MAX_MS)
        connectWs()
      }, reconnectDelayRef.current)
    }

    ws.onerror = () => ws.close()
  }

  useEffect(() => {
    mountedRef.current = true

    fetchDrains()
      .then((data) => {
        prevScoresRef.current = new Map(data.map((d) => [d.id, d.priority_score]))
        drainsRef.current = data
        setDrains(data)
      })
      .catch((e) => setError(e.message))
      .finally(connectWs)

    fetchWeatherAlert()
      .then(setWeatherAlert)
      .catch(() => {}) // 모드 표시는 부가 정보라 실패해도 대시보드 로딩을 막지 않음

    return () => {
      mountedRef.current = false
      stopPollingFallback()
      clearTimeout(reconnectTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [])

  useEffect(() => {
    const detailId = selectedId ?? listDetailId
    if (detailId == null) {
      setHistory([])
      setSystemEvents([])
      setHistoryError(null)
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(null)
    Promise.all([fetchHistory(detailId), fetchSystemEvents(detailId)])
      .then(([historyData, eventData]) => {
        if (!cancelled) {
          setHistory(historyData)
          setSystemEvents(eventData)
          setHistoryLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setHistoryError(e.message)
          setHistoryLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, listDetailId])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      // 이 응답으로 즉시 반영하지만, 같은 데이터가 WS 브로드캐스트로도 곧 도착함(멱등적 병합이라 중복 반영돼도 무해)
      ingest(await refreshPriority())
    } catch (e) {
      setError(e.message)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleSetMode(mode) {
    setModeChanging(true)
    try {
      // drain 우선순위 재계산 결과는 WS 브로드캐스트로 곧 도착하니 여기선 모드 상태만 즉시 반영
      setWeatherAlert(await setWeatherMode(mode))
    } catch (e) {
      setError(e.message)
    } finally {
      setModeChanging(false)
    }
  }

  const selectedDrain = drains ? drains.find((d) => d.id === selectedId) : null
  const listDetailDrain = drains ? drains.find((d) => d.id === listDetailId) : null
  const actionDrains = useMemo(
    () => (drains || []).filter((drain) => drain.requires_action),
    [drains],
  )
  const vehicleMapDrainIds = useMemo(
    () => vehicleMapSelection ? new Set(vehicleMapSelection.drainIds) : null,
    [vehicleMapSelection],
  )
  const handleVehicleMapChange = useCallback((selection) => setVehicleMapSelection(selection), [])
  const selectedTeam = useMemo(
    () => (selectedTeamId != null ? routePlan?.teams?.find((t) => t.team_id === selectedTeamId) : null),
    [selectedTeamId, routePlan],
  )
  const teamDrainIds = useMemo(
    () => (selectedTeam ? new Set(selectedTeam.stops.map((s) => s.drain_id)) : null),
    [selectedTeam],
  )
  // 차량 선택과 동선(팀) 선택은 상호 배타적 — 둘 다 지도의 "보이는 지점"을 좁히는 동일한
  // 슬롯을 다투므로, 하나를 고르면 다른 쪽은 자동으로 해제한다.
  const effectiveVisibleDrainIds = vehicleMapDrainIds || teamDrainIds
  const effectiveTeams = selectedTeam ? [selectedTeam] : (vehicleMapSelection ? null : routePlan?.teams)
  const handleSelectVehicle = useCallback((id) => {
    setSelectedVehicleId(id)
    setSelectedTeamId(null)
  }, [])
  const handleSelectTeam = useCallback((teamId) => {
    setSelectedTeamId((prev) => (prev === teamId ? null : teamId))
    setSelectedVehicleId(null)
  }, [])
  const handleRoutePlanResult = useCallback((result) => {
    setRoutePlan(result)
    setSelectedTeamId(null)
  }, [])
  const handleGenerateDraftRoutes = useCallback(() => {
    setDraftRoutes(buildDraftRoutes(routeTeamCount, drains || []))
  }, [drains, routeTeamCount])
  const handleResetMapView = useCallback(() => {
    setSelectedVehicleId(null)
    setSelectedTeamId(null)
    setRoutePlan(null)
  }, [])

  // 개요에서 급한 지점을 누르면 위치와 상세를 같이 볼 수 있는 지도 화면으로 넘긴다.
  const handleInspectFromOverview = useCallback((id) => {
    setSelectedId(id)
    setListDetailId(null)
    navigate('overview', { preserveSelection: true })
  }, [navigate])

  const handleSearchSelect = useCallback((id) => {
    setSelectedId(id)
    setListDetailId(null)
    navigate('overview', { preserveSelection: true })
  }, [navigate])

  const handleSelectFromList = useCallback((id) => {
    setSelectedId(null)
    setListDetailId(id)
  }, [])

  const mapFilterLabel = vehicleMapSelection
    ? `${vehicleMapSelection.vehicleCode} 판정 지점`
    : selectedTeam
      ? `팀 ${selectedTeam.team_id} 동선`
      : routePlan
        ? '동선 추천 표시 중'
        : null

  const loading = drains === null && !error

  const TITLES = {
    overview: ['현황', '전체 지점'],
    list: ['목록', `최근 판정순 · 전체 ${drains?.length ?? 0}개 지점`],
    analysis: ['분석', ''],
    route: ['동선', '조치 대상을 팀별로 묶어 방문 순서 추천'],
    fleet: ['차량', '차량이 판정한 지점 조회'],
  }
  const [title, subtitle] = TITLES[view] || TITLES[DEFAULT_VIEW]

  return (
    <div className="shell">
      <NavRail
        current={view}
        onNavigate={navigate}
        counts={{ list: drains?.length }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <div className="shell-main">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <span className="topbar-sub">{subtitle}</span>

          <span className="topbar-spacer" />

          <div className="topbar-right">
            <TopbarSearch drains={drains || []} onSelect={handleSearchSelect} />

            <ModeControl alert={weatherAlert} busy={modeChanging} onSetMode={handleSetMode} />

            <span className={`link-state ${wsConnected ? 'link-live' : 'link-poll'}`}>
              <span className="link-state-dot" />
              {wsConnected ? '실시간' : '재연결 중'}
            </span>

            <button className="btn btn-primary" onClick={handleRefresh} disabled={refreshing}>
              <ArrowsClockwise size={14} weight="bold" />
              {refreshing ? '재계산 중...' : '우선순위 재계산'}
            </button>
          </div>
        </header>

        {/* 폭우 예보는 첫 진입 때만 잠깐 뜨는 토스트로 처리한다. 레이아웃 흐름에서
            빼야 지도 높이와 합쳐져 세로 스크롤이 생기지 않는다. */}
        {weatherAlert?.active && (
          <div className={`alert-strip ${weatherToastVisible ? 'visible' : ''}`} role="status">
            <Warning size={16} weight="fill" />
            <span>{weatherAlert.message}</span>
            <button
              type="button"
              className="alert-close"
              onClick={() => setWeatherToastVisible(false)}
              aria-label="폭우 예보 알림 닫기"
            >
              <X size={12} weight="bold" />
            </button>
          </div>
        )}

        {error && (
          <div className="topbar-error">
            <div className="error-banner">서버 연결 오류: {error}</div>
          </div>
        )}

        <div className="workspace">
          {/* 개요·지도·차량·동선은 지도가 화면을 가득 써야 하므로 뷰 여백을 없앤다. */}
          <main className={FLUSH_VIEWS.has(view) ? 'view view-flush' : 'view'}>
            {loading && (
              <div className="loading-pad">
                <div className="skeleton-grid">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div className="skeleton-block" key={i} />
                  ))}
                </div>
              </div>
            )}

            {drains && view === 'overview' && (
              <OverviewView
                drains={drains}
                actionDrains={actionDrains}
                weatherAlert={weatherAlert}
                wsConnected={wsConnected}
                flashIds={flashIds}
                selectedId={selectedId}
                onSelect={handleInspectFromOverview}
              />
            )}

            {drains && view === 'list' && (
              listDetailDrain ? (
                <div className="list-detail-page">
                  <div className="list-detail-head">
                    <button
                      type="button"
                      className="btn btn-sm list-detail-back"
                      onClick={() => setListDetailId(null)}
                    >
                      <ArrowLeft size={14} weight="bold" />
                      목록으로
                    </button>
                    <div>
                      <h2>{listDetailDrain.name}</h2>
                      <p>{listDetailDrain.external_code || `ID ${listDetailDrain.id}`}</p>
                    </div>
                  </div>

                  <div className="list-detail-body">
                    <div className="list-detail-row">
                      <section className="list-detail-card list-detail-analysis-card">
                        <h3>분석 내용</h3>
                        <DetailMetricGraphs drain={listDetailDrain} />
                      </section>
                      <section className="list-detail-card list-detail-photo-card">
                        <h3>Drain Vision Pod 촬영 이미지</h3>
                        <div className="drain-photo-frame">
                          <img src={drainSampleImage} alt={`${listDetailDrain.name} 빗물받이 촬영 이미지`} />
                        </div>
                      </section>
                    </div>
                    <div className="list-detail-row">
                      <section className="list-detail-card list-detail-square-card">
                        <div className="list-detail-card-scroll">
                          <HistoryPanel
                            drain={listDetailDrain}
                            history={history}
                            systemEvents={systemEvents}
                            loading={historyLoading}
                            error={historyError}
                          />
                        </div>
                      </section>
                      <section className="list-detail-card list-detail-chart-card">
                        <h3>차폐율 시계열 분석</h3>
                        <OcclusionTrendChart history={history} drain={listDetailDrain} />
                      </section>
                    </div>
                  </div>

                  <div className="list-detail-actions">
                    <MaintenanceAction drain={listDetailDrain} onResolved={ingest} />
                  </div>
                </div>
              ) : (
                <PriorityList
                  drains={drains}
                  selectedId={null}
                  onSelect={handleSelectFromList}
                  sort="recent"
                  emptyMessage="표시할 빗물받이 데이터가 없습니다."
                />
              )
            )}

            {drains && view === 'analysis' && (
              <div className="empty analysis-empty">분석 화면은 아직 준비 중입니다.</div>
            )}

            {drains && view === 'route' && (
              SHOW_ROUTE_DRAFT ? (
                <div className="split-view">
                  <div className="split-list">
                    <RoutePlanner
                      onResult={handleRoutePlanResult}
                      selectedTeamId={selectedTeamId}
                      onSelectTeam={handleSelectTeam}
                    />
                  </div>
                  <div className="split-map">
                    <PriorityMap
                      drains={drains}
                      flashIds={flashIds}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      teams={selectedTeam ? [selectedTeam] : routePlan?.teams}
                      visibleDrainIds={teamDrainIds}
                    />
                    <MapLegend />
                    {!routePlan && (
                      <div className="split-map-hint">
                        투입 팀 수를 정하고 동선 추천을 생성하면
                        <br />
                        각 팀의 경로가 여기 지도에 표시됩니다.
                      </div>
                    )}
                    {selectedTeamId != null && (
                      <button
                        type="button"
                        className="btn btn-sm split-map-reset"
                        onClick={() => handleSelectTeam(null)}
                      >
                        <ArrowCounterClockwise size={13} weight="bold" />
                        전체 팀 보기
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="route-draft-view">
                  <div className="route-draft-main">
                    <section className="route-setup-card">
                      <label htmlFor="route-team-count">투입 팀 수</label>
                      <input
                        id="route-team-count"
                        type="number"
                        min="1"
                        max="12"
                        value={routeTeamCount}
                        onChange={(event) => setRouteTeamCount(event.target.value)}
                      />
                      <button type="button" className="btn btn-primary" onClick={handleGenerateDraftRoutes}>
                        동선 생성
                      </button>
                    </section>

                    <section className="route-result-card">
                      <div className="route-result-head">
                        <span>번호</span>
                        <span>팀(명)</span>
                        <span>동선</span>
                        <span>거리</span>
                        <span>소요시간</span>
                        <span>지도</span>
                      </div>
                      <div className="route-result-body">
                        {draftRoutes.length > 0 ? (
                          <div className="route-result-list">
                            {draftRoutes.map((route) => (
                              <div className="route-result-row" key={route.id}>
                                <span>{route.id}</span>
                                <span>{route.team}</span>
                                <span>{route.path}</span>
                                <span>{route.distance}</span>
                                <span>{route.duration}</span>
                                <span>대기</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="route-result-empty">생성된 동선이 없습니다.</div>
                        )}
                        <button type="button" className="btn btn-sm route-map-button">
                          전체 동선 지도
                        </button>
                      </div>
                    </section>

                    <section className="route-qr-card">
                      <div className="route-qr-head">
                        <h3>QR 생성</h3>
                      </div>
                      <div className="route-qr-content">
                        <div className="route-qr-preview">
                          {draftRoutes.length > 0 && <img src={qrSampleImage} alt="동선 QR 코드" />}
                        </div>
                        <div className="route-qr-list">
                          {draftRoutes.length > 0 ? (
                            draftRoutes.map((route) => (
                              <div className="route-qr-row" key={route.id}>
                                <span>{route.name}</span>
                                <div className="route-qr-actions" aria-label={`${route.name} QR 작업`}>
                                  <button type="button" aria-label={`${route.name} QR 보기`}>
                                    <Eye size={16} weight="bold" />
                                  </button>
                                  <button type="button" aria-label={`${route.name} QR 다운로드`}>
                                    <DownloadSimple size={16} weight="bold" />
                                  </button>
                                  <button type="button" aria-label={`${route.name} QR 공유`}>
                                    <ShareNetwork size={16} weight="bold" />
                                  </button>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="route-qr-empty">생성된 동선명이 없습니다.</div>
                          )}
                        </div>
                      </div>
                    </section>
                    <button type="button" className="btn btn-primary route-qr-bulk">
                      QR 일괄 생성
                    </button>
                  </div>

                  <aside className="route-priority-card">
                    <div className="route-priority-head">
                      <h3>우선순위</h3>
                      <span>동선 생성 후 자동 정렬</span>
                    </div>
                    {draftRoutes.length > 0 ? (
                      <div className="route-priority-list">
                        {[...draftRoutes]
                          .sort((a, b) => b.priority - a.priority)
                          .map((route, index) => (
                            <div className="route-priority-row" key={route.id}>
                              <span>{index + 1}</span>
                              <strong>{route.name}</strong>
                              <small>{route.team} · {route.stops.length}개 지점</small>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <div className="route-priority-empty">우선순위 대상이 없습니다.</div>
                    )}
                  </aside>
                </div>
              )
            )}

            {/* 차량별 조회도 마찬가지로 목록 옆에 바로 이동 경로를 그린다. */}
            {drains && view === 'fleet' && (
              <div className="split-view">
                <div className="split-list">
                  <VehiclePanel
                    selectedVehicleId={selectedVehicleId}
                    onSelectVehicle={handleSelectVehicle}
                    onSelectDrain={setSelectedId}
                    onVehicleMapChange={handleVehicleMapChange}
                  />
                </div>
                <div className="split-map">
                  <PriorityMap
                    drains={drains}
                    flashIds={flashIds}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    visibleDrainIds={vehicleMapDrainIds}
                    vehicleTrail={vehicleMapSelection?.trail}
                  />
                  <MapLegend />
                  {!vehicleMapSelection && (
                    <div className="split-map-hint">
                      차량을 선택하면 그 차량이 판정한 지점과
                      <br />
                      이동 경로가 여기 지도에 표시됩니다.
                    </div>
                  )}
                  {selectedVehicleId != null && (
                    <button
                      type="button"
                      className="btn btn-sm split-map-reset"
                      onClick={() => handleSelectVehicle(null)}
                    >
                      <ArrowCounterClockwise size={13} weight="bold" />
                      전체 지점 보기
                    </button>
                  )}
                </div>
              </div>
            )}
          </main>

          <Inspector
            drain={selectedDrain}
            history={history}
            systemEvents={systemEvents}
            loading={historyLoading}
            error={historyError}
            weightProfile={weatherAlert?.weight_profile}
            onResolved={ingest}
            onClose={() => setSelectedId(null)}
            open={selectedId != null}
          />
        </div>
      </div>
    </div>
  )
}
