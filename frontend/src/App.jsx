import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowsClockwise,
  ArrowCounterClockwise,
  CheckCircle,
  DownloadSimple,
  MapTrifold,
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
import RouteMapModal from './components/RouteMapModal.jsx'
import { QrPreviewModal, QrShareModal } from './components/QrModals.jsx'
import Pagination, { usePagination } from './components/Pagination.jsx'
import HistoryPanel from './components/HistoryPanel.jsx'
import OverviewView from './views/OverviewView.jsx'
import VehicleManagementView from './views/VehicleManagementView.jsx'
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

const DRAFT_ROUTE_MIN_STOPS = 6
const DRAFT_ROUTE_MAX_STOPS = 10

function haversineKm(a, b) {
  const toRadians = (degrees) => degrees * Math.PI / 180
  const earthRadiusKm = 6371
  const latDelta = toRadians(b.lat - a.lat)
  const lngDelta = toRadians(b.lng - a.lng)
  const latA = toRadians(a.lat)
  const latB = toRadians(b.lat)
  const value = Math.sin(latDelta / 2) ** 2
    + Math.cos(latA) * Math.cos(latB) * Math.sin(lngDelta / 2) ** 2
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

function routeDistanceKm(stops) {
  return stops.slice(1).reduce(
    (total, stop, index) => total + haversineKm(stops[index], stop),
    0,
  )
}

// 최근접 순회로 만든 경로에서 교차하거나 불필요하게 꺾이는 구간을 2-opt로 정리한다.
// 첫 지점은 해당 팀에서 우선순위가 가장 높은 지점으로 고정한다.
function optimizeStopOrder(stops) {
  const route = [...stops]
  let improved = true
  let pass = 0

  while (improved && pass < 20) {
    improved = false
    pass += 1

    for (let start = 1; start < route.length - 1; start += 1) {
      for (let end = start + 1; end < route.length; end += 1) {
        const before = haversineKm(route[start - 1], route[start])
          + (end + 1 < route.length ? haversineKm(route[end], route[end + 1]) : 0)
        const after = haversineKm(route[start - 1], route[end])
          + (end + 1 < route.length ? haversineKm(route[start], route[end + 1]) : 0)

        if (after + 0.000001 < before) {
          route.splice(start, end - start + 1, ...route.slice(start, end + 1).reverse())
          improved = true
        }
      }
    }
  }

  return route
}

function takeNearbyStops(unassigned, targetSize) {
  if (unassigned.length === 0) return []

  const stops = [unassigned.shift()]
  while (stops.length < targetSize && unassigned.length > 0) {
    const current = stops[stops.length - 1]
    let nearestIndex = 0
    let nearestDistance = haversineKm(current, unassigned[0])

    for (let index = 1; index < unassigned.length; index += 1) {
      const distance = haversineKm(current, unassigned[index])
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    }

    stops.push(unassigned.splice(nearestIndex, 1)[0])
  }

  return optimizeStopOrder(stops)
}

function buildDraftRoutes(count, drains = []) {
  const routeCount = Math.max(1, Math.min(12, Number(count) || 1))
  const unassigned = drains
    .filter((drain) => Number.isFinite(drain.lat) && Number.isFinite(drain.lng))
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
    .slice(0, routeCount * DRAFT_ROUTE_MAX_STOPS)

  return Array.from({ length: routeCount }, (_, index) => {
    const remainingRoutes = routeCount - index
    const enoughForMinimum = unassigned.length >= remainingRoutes * DRAFT_ROUTE_MIN_STOPS
    const targetSize = enoughForMinimum
      ? Math.min(
        DRAFT_ROUTE_MAX_STOPS,
        unassigned.length - DRAFT_ROUTE_MIN_STOPS * (remainingRoutes - 1),
      )
      : Math.ceil(unassigned.length / remainingRoutes)
    const stops = takeNearbyStops(unassigned, targetSize)
    const priority = stops.reduce((sum, drain) => sum + (drain.priority_score ?? 0), 0)
    const distanceKm = routeDistanceKm(stops)
    const firstStop = stops[0]
    const lastStop = stops[stops.length - 1]
    const path = stops.length > 1
      ? `${firstStop.name} ··· ${lastStop.name}`
      : firstStop?.name || '배정 대기'

    return {
      id: index + 1,
      name: `동선 ${index + 1}`,
      team: `${index + 1}팀`,
      path,
      distance: `${distanceKm.toFixed(1)}km`,
      duration: `${Math.round(distanceKm * 3 + stops.length * 4)}분`,
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
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  const [routeTeamCount, setRouteTeamCount] = useState(2)
  const [draftRoutes, setDraftRoutes] = useState([])
  const [bulkQrGenerated, setBulkQrGenerated] = useState(false)
  const [selectedQrRouteId, setSelectedQrRouteId] = useState(null)
  const [routeMapRoute, setRouteMapRoute] = useState(null)
  const [qrPreviewRoute, setQrPreviewRoute] = useState(null)
  const [qrShareTarget, setQrShareTarget] = useState(null)
  const [qrToastMessage, setQrToastMessage] = useState('')
  const [view, setView] = useState(readHashView)
  const [theme, setTheme] = useState(readStoredTheme)
  const sortedDraftRoutes = useMemo(
    () => [...draftRoutes].sort((a, b) => b.priority - a.priority),
    [draftRoutes],
  )
  const routeResultPagination = usePagination(draftRoutes, 5, { resetKey: draftRoutes })
  const routeQrPagination = usePagination(draftRoutes, 6, { resetKey: draftRoutes })
  const routePriorityPagination = usePagination(sortedDraftRoutes, 6, { resetKey: draftRoutes })
  const selectedQrRoute = useMemo(
    () => draftRoutes.find((route) => route.id === selectedQrRouteId) || null,
    [draftRoutes, selectedQrRouteId],
  )

  // holds the latest scores/list so WS/poll callbacks can merge without stale closures
  const prevScoresRef = useRef(new Map())
  const drainsRef = useRef(null)
  const pollIntervalRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const reconnectDelayRef = useRef(WS_RECONNECT_BASE_MS)
  const wsRef = useRef(null)
  const mountedRef = useRef(true)
  const weatherToastShownRef = useRef(false)
  const qrToastTimerRef = useRef(null)

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

  useEffect(() => () => clearTimeout(qrToastTimerRef.current), [])

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
  const selectedTeam = useMemo(
    () => (selectedTeamId != null ? routePlan?.teams?.find((t) => t.team_id === selectedTeamId) : null),
    [selectedTeamId, routePlan],
  )
  const teamDrainIds = useMemo(
    () => (selectedTeam ? new Set(selectedTeam.stops.map((s) => s.drain_id)) : null),
    [selectedTeam],
  )
  const handleSelectTeam = useCallback((teamId) => {
    setSelectedTeamId((prev) => (prev === teamId ? null : teamId))
  }, [])
  const handleRoutePlanResult = useCallback((result) => {
    setRoutePlan(result)
    setSelectedTeamId(null)
  }, [])
  const handleGenerateDraftRoutes = useCallback(() => {
    setDraftRoutes(buildDraftRoutes(routeTeamCount, drains || []))
    setBulkQrGenerated(false)
    setSelectedQrRouteId(null)
    setRouteMapRoute(null)
    setQrPreviewRoute(null)
    setQrShareTarget(null)
  }, [drains, routeTeamCount])
  const handleBulkQrGenerate = useCallback(() => {
    if (draftRoutes.length === 0) return
    setBulkQrGenerated(true)
    setSelectedQrRouteId(draftRoutes[0].id)
    routeQrPagination.setPage(1)
  }, [draftRoutes, routeQrPagination.setPage])
  const showQrToast = useCallback((message) => {
    clearTimeout(qrToastTimerRef.current)
    setQrToastMessage(message)
    qrToastTimerRef.current = setTimeout(() => setQrToastMessage(''), 2600)
  }, [])
  const handleBulkQrShare = useCallback(() => {
    setQrShareTarget({
      type: 'bulk',
      count: draftRoutes.length,
      url: window.location.href,
    })
  }, [draftRoutes.length])
  const handleRouteQrShare = useCallback((route) => {
    setQrShareTarget({
      type: 'route',
      route,
      url: window.location.href,
    })
  }, [])
  const handleQrDownload = useCallback(async (route) => {
    const safeName = route.name.replace(/[^a-zA-Z0-9가-힣_-]+/g, '-')
    let downloadUrl = qrSampleImage

    try {
      const response = await fetch(qrSampleImage)
      if (!response.ok) throw new Error('QR 이미지 불러오기 실패')
      downloadUrl = URL.createObjectURL(await response.blob())
    } catch {
      // 번들 이미지 URL을 직접 내려받는 방식으로 계속 진행한다.
    }

    const anchor = document.createElement('a')
    anchor.href = downloadUrl
    anchor.download = `${safeName}-QR.png`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    if (downloadUrl !== qrSampleImage) URL.revokeObjectURL(downloadUrl)
    showQrToast('이미지가 저장되었습니다.')
  }, [showQrToast])
  const handleCloseRouteMap = useCallback(() => setRouteMapRoute(null), [])

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

  const handleViewDrainDetails = useCallback((id) => {
    setSelectedId(null)
    setListDetailId(id)
    navigate('list', { preserveSelection: true })
  }, [navigate])

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
              <div className="analysis-grid" aria-label="분석 카드 레이아웃">
                {Array.from({ length: 8 }, (_, index) => (
                  <section
                    className="analysis-card"
                    key={index}
                    aria-label={`분석 카드 ${index + 1}`}
                  />
                ))}
              </div>
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
                          <div className="route-result-page">
                            <div className="route-result-list">
                              {routeResultPagination.pageItems.map((route) => (
                                <div className="route-result-row" key={route.id}>
                                  <span>{route.id}</span>
                                  <span>{route.team}</span>
                                  <span>{route.path}</span>
                                  <span>{route.distance}</span>
                                  <span>{route.duration}</span>
                                  <span className="route-result-map-cell">
                                    <button
                                      type="button"
                                      className="route-result-map-button"
                                      onClick={() => setRouteMapRoute(route)}
                                      aria-label={`${route.name} 지도 보기`}
                                      title={`${route.name} 지도 보기`}
                                    >
                                      <MapTrifold size={18} weight="bold" />
                                    </button>
                                  </span>
                                </div>
                              ))}
                            </div>
                            <Pagination
                              page={routeResultPagination.page}
                              totalPages={routeResultPagination.totalPages}
                              onPageChange={routeResultPagination.setPage}
                              label="동선 결과"
                            />
                          </div>
                        ) : (
                          <div className="route-result-empty">생성된 동선이 없습니다.</div>
                        )}
                      </div>
                    </section>

                    <section className="route-qr-card">
                      <div className="route-qr-head">
                        <h3>QR 생성</h3>
                        <div className="route-qr-head-actions" aria-live="polite">
                          <button
                            type="button"
                            className="btn btn-primary route-qr-bulk"
                            onClick={handleBulkQrGenerate}
                            disabled={draftRoutes.length === 0 || bulkQrGenerated}
                          >
                            QR 일괄 생성
                          </button>
                          {bulkQrGenerated && (
                            <button
                              type="button"
                              className="btn route-qr-share"
                              onClick={handleBulkQrShare}
                            >
                              <ShareNetwork size={16} weight="bold" />
                              공유
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="route-qr-content">
                        <div className={`route-qr-preview${bulkQrGenerated && selectedQrRoute ? ' is-generated' : ''}`}>
                          {bulkQrGenerated && selectedQrRoute ? (
                            <button
                              type="button"
                              className="route-qr-generated"
                              key={selectedQrRoute.id}
                              onClick={() => setQrPreviewRoute(selectedQrRoute)}
                              aria-label={`${selectedQrRoute.name} QR 코드 크게 보기`}
                            >
                              <img src={qrSampleImage} alt={`${selectedQrRoute.name} QR 코드`} />
                              <span title={selectedQrRoute.name}>{selectedQrRoute.name}</span>
                            </button>
                          ) : (
                            <p>QR 일괄 생성 후<br />미리보기가 표시됩니다.</p>
                          )}
                        </div>
                        <div className="route-qr-list">
                          {draftRoutes.length > 0 ? (
                            <>
                              <div className="route-qr-items">
                                {routeQrPagination.pageItems.map((route) => (
                                  <div
                                    className={`route-qr-row${bulkQrGenerated ? ' selectable' : ''}${selectedQrRouteId === route.id ? ' selected' : ''}`}
                                    key={route.id}
                                  >
                                    <button
                                      type="button"
                                      className="route-qr-select"
                                      disabled={!bulkQrGenerated}
                                      aria-pressed={bulkQrGenerated ? selectedQrRouteId === route.id : undefined}
                                      onClick={() => setSelectedQrRouteId(route.id)}
                                    >
                                      {route.name}
                                    </button>
                                    {bulkQrGenerated && (
                                      <div className="route-qr-actions" aria-label={`${route.name} QR 작업`}>
                                        <button
                                          type="button"
                                          onClick={() => handleQrDownload(route)}
                                          aria-label={`${route.name} QR 이미지 저장`}
                                          title="이미지 저장"
                                        >
                                          <DownloadSimple size={16} weight="bold" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleRouteQrShare(route)}
                                          aria-label={`${route.name} QR 공유`}
                                          title="공유"
                                        >
                                          <ShareNetwork size={16} weight="bold" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                              <Pagination
                                page={routeQrPagination.page}
                                totalPages={routeQrPagination.totalPages}
                                onPageChange={routeQrPagination.setPage}
                                label="QR 생성 목록"
                              />
                            </>
                          ) : (
                            <div className="route-qr-empty">생성된 동선명이 없습니다.</div>
                          )}
                        </div>
                      </div>
                    </section>
                  </div>

                  <aside className="route-priority-card">
                    <div className="route-priority-head">
                      <h3>우선순위</h3>
                      <span>동선 생성 후 자동 정렬</span>
                    </div>
                    {draftRoutes.length > 0 ? (
                      <div className="route-priority-page">
                        <div className="route-priority-list">
                          {routePriorityPagination.pageItems.map((route, index) => (
                            <div className="route-priority-row" key={route.id}>
                              <span>{(routePriorityPagination.page - 1) * 6 + index + 1}</span>
                              <strong>{route.name}</strong>
                              <small>{route.team} · {route.stops.length}개 지점</small>
                            </div>
                          ))}
                        </div>
                        <Pagination
                          page={routePriorityPagination.page}
                          totalPages={routePriorityPagination.totalPages}
                          onPageChange={routePriorityPagination.setPage}
                          label="우선순위 목록"
                        />
                      </div>
                    ) : (
                      <div className="route-priority-empty">우선순위 대상이 없습니다.</div>
                    )}
                  </aside>
                </div>
              )
            )}

            {/* 차량 등록 목록 아래에서 노선별 관측 지점과 이동 경로를 함께 확인한다. */}
            {drains && view === 'fleet' && (
              <VehicleManagementView
                drains={drains}
                flashIds={flashIds}
                selectedId={selectedId}
                onSelectDrain={setSelectedId}
              />
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
            onViewDetails={view === 'overview' ? handleViewDrainDetails : null}
            open={selectedId != null}
          />
          {routeMapRoute && (
            <RouteMapModal route={routeMapRoute} onClose={handleCloseRouteMap} />
          )}
          {qrPreviewRoute && (
            <QrPreviewModal
              imageSrc={qrSampleImage}
              route={qrPreviewRoute}
              onClose={() => setQrPreviewRoute(null)}
            />
          )}
          {qrShareTarget && (
            <QrShareModal
              target={qrShareTarget}
              onClose={() => setQrShareTarget(null)}
              onToast={showQrToast}
            />
          )}
          {qrToastMessage && (
            <div className="qr-action-toast" role="status" aria-live="polite">
              <CheckCircle size={19} weight="fill" />
              <span>{qrToastMessage}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
