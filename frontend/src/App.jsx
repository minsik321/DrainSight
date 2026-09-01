import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsClockwise, ArrowCounterClockwise, Warning } from '@phosphor-icons/react'
import { fetchDrains, fetchHistory, fetchSystemEvents, fetchWeatherAlert, refreshPriority, setWeatherMode, wsUrl } from './api'
import NavRail, { VIEWS } from './components/NavRail.jsx'
import ModeControl from './components/ModeControl.jsx'
import Inspector from './components/Inspector.jsx'
import StatusCard from './components/StatusCard.jsx'
import PriorityMap, { MapLegend } from './components/PriorityMap.jsx'
import PriorityList from './components/PriorityList.jsx'
import RoutePlanner from './components/RoutePlanner.jsx'
import VehiclePanel from './components/VehiclePanel.jsx'
import OverviewView from './views/OverviewView.jsx'
import Pagination, { usePagination } from './components/Pagination.jsx'

const POLL_MS = 1000 // WS 연결이 끊겼을 때만 쓰는 폴백 주기
const FLASH_MS = 1800
const WS_RECONNECT_BASE_MS = 1000
const WS_RECONNECT_MAX_MS = 8000

const VIEW_IDS = new Set(VIEWS.map((v) => v.id))
const DEFAULT_VIEW = 'overview'

// 개요는 배경 지도를 가득 쓰는 화면이라 우측 상세를 띄우지 않는다.
const VIEWS_WITHOUT_INSPECTOR = new Set(['overview'])

// 이 화면들은 지도가 목록과 나란히 화면을 가득 채우므로 뷰 여백을 없앤다(여백은
// split-list/map-view 쪽에서 각자 처리).
const FLUSH_VIEWS = new Set(['overview', 'map', 'fleet', 'route'])

function readHashView() {
  const id = window.location.hash.replace(/^#\/?/, '')
  return VIEW_IDS.has(id) ? id : DEFAULT_VIEW
}

const THEME_STORAGE_KEY = 'dvp-theme'

// 관제 콘솔이라 기본은 다크 — 시스템 설정을 따라가지 않고, 사용자가 명시적으로
// 고른 값만 저장/복원한다(껐다 켜도 매번 시스템 설정으로 되돌아가지 않도록).
function readStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'light' ? 'light' : 'dark'
}

export default function App() {
  const [drains, setDrains] = useState(null)
  const [error, setError] = useState(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [history, setHistory] = useState([])
  const [systemEvents, setSystemEvents] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(null)
  const [flashIds, setFlashIds] = useState(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [routePlan, setRoutePlan] = useState(null)
  const [weatherAlert, setWeatherAlert] = useState(null)
  const [modeChanging, setModeChanging] = useState(false)
  const [vehicleMapSelection, setVehicleMapSelection] = useState(null)
  const [selectedVehicleId, setSelectedVehicleId] = useState(null)
  const [selectedTeamId, setSelectedTeamId] = useState(null)
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

  // 뷰는 해시에 담는다 — 데모 중 새로고침해도 보던 화면이 유지되고, 뒤로가기도 동작한다.
  useEffect(() => {
    const onHashChange = () => setView(readHashView())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((id) => {
    window.location.hash = `#/${id}`
    setView(id)
  }, [])

  // data-theme 속성 하나로 App.css 전체 토큰이 갈아끼워진다(라이트 오버라이드는
  // :root[data-theme='light'] 블록 하나뿐 — 개요 배경 지도만 예외로 항상 다크 고정).
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

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
    if (selectedId == null) {
      setHistory([])
      setSystemEvents([])
      setHistoryError(null)
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(null)
    Promise.all([fetchHistory(selectedId), fetchSystemEvents(selectedId)])
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
  }, [selectedId])

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
  const handleResetMapView = useCallback(() => {
    setSelectedVehicleId(null)
    setSelectedTeamId(null)
    setRoutePlan(null)
  }, [])

  // 개요에서 급한 지점을 누르면 위치와 상세를 같이 볼 수 있는 지도 화면으로 넘긴다.
  const handleInspectFromOverview = useCallback((id) => {
    setSelectedId(id)
    navigate('map')
  }, [navigate])

  const cardPagination = usePagination(drains || [], 12, {
    selectedKey: selectedId,
    getKey: (drain) => drain.id,
  })

  const mapFilterLabel = vehicleMapSelection
    ? `${vehicleMapSelection.vehicleCode} 판정 지점`
    : selectedTeam
      ? `팀 ${selectedTeam.team_id} 동선`
      : routePlan
        ? '동선 추천 표시 중'
        : null

  const showInspector = !VIEWS_WITHOUT_INSPECTOR.has(view)
  const loading = drains === null && !error

  const TITLES = {
    overview: ['개요', '현재 상황 요약'],
    status: ['현황', `전체 ${drains?.length ?? 0}개 지점`],
    map: ['지도', mapFilterLabel || '전체 지점'],
    priority: ['우선순위', `조치 대상 ${actionDrains.length}곳`],
    route: ['동선', '조치 대상을 팀별로 묶어 방문 순서 추천'],
    fleet: ['차량', '차량이 판정한 지점 조회'],
  }
  const [title, subtitle] = TITLES[view] || TITLES[DEFAULT_VIEW]

  return (
    <div className="shell">
      <NavRail
        current={view}
        onNavigate={navigate}
        counts={{ status: drains?.length, priority: actionDrains.length || undefined }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <div className="shell-main">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <span className="topbar-sub">{subtitle}</span>

          <span className="topbar-spacer" />

          <div className="topbar-right">
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

        {/* 폭우 예보에서만 뜨는 경보. NORMAL/RAIN은 상단바 모드 칩만으로 충분하고,
            매번 배너를 띄우면 정작 폭우일 때 눈에 안 들어온다. */}
        {weatherAlert?.active && (
          <div className="alert-strip" role="status">
            <Warning size={16} weight="fill" />
            <span>{weatherAlert.message}</span>
          </div>
        )}

        {error && (
          <div className="topbar-error">
            <div className="error-banner">서버 연결 오류: {error}</div>
          </div>
        )}

        <div className={`workspace ${showInspector ? 'with-inspector' : ''}`}>
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
                onInspect={handleInspectFromOverview}
              />
            )}

            {drains && view === 'status' && (
              <>
                <div className="card-grid">
                  {cardPagination.pageItems.map((d) => (
                    <StatusCard
                      key={d.id}
                      drain={d}
                      flashing={flashIds.has(d.id)}
                      selected={d.id === selectedId}
                      onClick={() => setSelectedId(d.id)}
                      staleThresholdDays={weatherAlert?.staleness_threshold_days}
                    />
                  ))}
                </div>
                <Pagination
                  page={cardPagination.page}
                  totalPages={cardPagination.totalPages}
                  onPageChange={cardPagination.setPage}
                  label="빗물받이 상태 카드"
                />
              </>
            )}

            {drains && view === 'map' && (
              <div className="map-view">
                <PriorityMap
                  drains={drains}
                  flashIds={flashIds}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  teams={effectiveTeams}
                  visibleDrainIds={effectiveVisibleDrainIds}
                  vehicleTrail={vehicleMapSelection?.trail}
                />
                <MapLegend />
                {mapFilterLabel && (
                  <button
                    type="button"
                    className="btn btn-sm split-map-reset"
                    onClick={handleResetMapView}
                  >
                    <ArrowCounterClockwise size={13} weight="bold" />
                    전체 보기
                  </button>
                )}
              </div>
            )}

            {drains && view === 'priority' && (
              <PriorityList drains={actionDrains} selectedId={selectedId} onSelect={setSelectedId} />
            )}

            {/* 동선 추천은 목록만으로는 "어느 구역을 도는지"가 안 보여서, 팀별 경로를
                같은 화면의 지도에 바로 그린다 — 지도 탭으로 옮겨야만 보이던 것을 없앤다. */}
            {drains && view === 'route' && (
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

          {showInspector && (
            <Inspector
              drain={selectedDrain}
              history={history}
              systemEvents={systemEvents}
              loading={historyLoading}
              error={historyError}
              weightProfile={weatherAlert?.weight_profile}
              onResolved={ingest}
              onClose={() => setSelectedId(null)}
              forced={selectedId != null}
            />
          )}
        </div>
      </div>
    </div>
  )
}
