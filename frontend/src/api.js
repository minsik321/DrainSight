const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

export function wsUrl() {
  const url = new URL(API_BASE)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/dashboard'
  return url.toString()
}

export async function fetchDrains() {
  const res = await fetch(`${API_BASE}/api/drains`)
  if (!res.ok) throw new Error(`GET /api/drains ${res.status}`)
  return res.json()
}

export async function fetchHistory(drainId) {
  const res = await fetch(`${API_BASE}/api/drains/${drainId}/history`)
  if (!res.ok) throw new Error(`GET /api/drains/${drainId}/history ${res.status}`)
  return res.json()
}

export async function fetchSystemEvents(drainId) {
  const res = await fetch(`${API_BASE}/api/system-events?drain_id=${drainId}`)
  if (!res.ok) throw new Error(`GET /api/system-events ${res.status}`)
  return res.json()
}

// drain_id를 생략하면 전체 시스템 이벤트를 반환한다 — 분석 페이지의 차량별
// RESULT_MISSING 집계처럼 특정 drain에 매이지 않는 화면에서 쓴다.
export async function fetchAllSystemEvents(limit = 500) {
  const res = await fetch(`${API_BASE}/api/system-events?limit=${limit}`)
  if (!res.ok) throw new Error(`GET /api/system-events ${res.status}`)
  return res.json()
}

export async function refreshPriority() {
  const res = await fetch(`${API_BASE}/api/priority/refresh`, { method: 'POST' })
  if (!res.ok) throw new Error(`POST /api/priority/refresh ${res.status}`)
  return res.json()
}

export async function fetchWeatherAlert() {
  const res = await fetch(`${API_BASE}/api/weather/alert`)
  if (!res.ok) throw new Error(`GET /api/weather/alert ${res.status}`)
  return res.json()
}

// mode: 'NORMAL' | 'RAIN' | 'HEAVY_RAIN' | 'AUTO'(수동 고정 해제, 실제 예보로 복귀)
export async function setWeatherMode(mode) {
  const res = await fetch(`${API_BASE}/api/weather/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  if (!res.ok) throw new Error(`POST /api/weather/mode ${res.status}`)
  return res.json()
}

export async function planRoute(teamCount, opts = {}) {
  const body = { team_count: teamCount, ...opts }
  const res = await fetch(`${API_BASE}/api/route/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST /api/route/plan ${res.status}`)
  return res.json()
}

export async function fetchVehicles() {
  const res = await fetch(`${API_BASE}/api/vehicles`)
  if (!res.ok) throw new Error(`GET /api/vehicles ${res.status}`)
  return res.json()
}

export async function fetchVehicleDrains(vehicleId) {
  const res = await fetch(`${API_BASE}/api/vehicles/${vehicleId}/drains`)
  if (!res.ok) throw new Error(`GET /api/vehicles/${vehicleId}/drains ${res.status}`)
  return res.json()
}

export async function fetchAnalyticsTrend(period) {
  const res = await fetch(`${API_BASE}/api/analytics/trend?period=${period}`)
  if (!res.ok) throw new Error(`GET /api/analytics/trend ${res.status}`)
  return res.json()
}

// drain_id를 생략하면 전체 시스템 이벤트를 반환한다 — 분석 페이지의 차량별
// RESULT_MISSING 집계처럼 특정 drain에 매이지 않는 화면에서 쓴다.
export async function fetchAllSystemEvents(limit = 500) {
  const res = await fetch(`${API_BASE}/api/system-events?limit=${limit}`)
  if (!res.ok) throw new Error(`GET /api/system-events ${res.status}`)
  return res.json()
}

export async function refreshPriority() {
  const res = await fetch(`${API_BASE}/api/priority/refresh`, { method: 'POST' })
  if (!res.ok) throw new Error(`POST /api/priority/refresh ${res.status}`)
  return res.json()
}

export async function fetchWeatherAlert() {
  const res = await fetch(`${API_BASE}/api/weather/alert`)
  if (!res.ok) throw new Error(`GET /api/weather/alert ${res.status}`)
  return res.json()
}

// mode: 'NORMAL' | 'RAIN' | 'HEAVY_RAIN' | 'AUTO'(수동 고정 해제, 실제 예보로 복귀)
export async function setWeatherMode(mode) {
  const res = await fetch(`${API_BASE}/api/weather/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  if (!res.ok) throw new Error(`POST /api/weather/mode ${res.status}`)
  return res.json()
}

export async function planRoute(teamCount, opts = {}) {
  const body = { team_count: teamCount, ...opts }
  const res = await fetch(`${API_BASE}/api/route/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST /api/route/plan ${res.status}`)
  return res.json()
}

export async function fetchVehicles() {
  const res = await fetch(`${API_BASE}/api/vehicles`)
  if (!res.ok) throw new Error(`GET /api/vehicles ${res.status}`)
  return res.json()
}

export async function fetchVehicleDrains(vehicleId) {
  const res = await fetch(`${API_BASE}/api/vehicles/${vehicleId}/drains`)
  if (!res.ok) throw new Error(`GET /api/vehicles/${vehicleId}/drains ${res.status}`)
  return res.json()
}

// period: 'today' | '7d' | '30d' — 분석 페이지 기간 탭('오늘'/'7일'/'30일')이 이 값으로 매핑된다.
export async function fetchAnalyticsTrend(period) {
  const res = await fetch(`${API_BASE}/api/analytics/trend?period=${period}`)
  if (!res.ok) throw new Error(`GET /api/analytics/trend ${res.status}`)
  return res.json()
}

export async function resolveDrain(drainId, note) {
  const res = await fetch(`${API_BASE}/api/drains/${drainId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note || null }),
  })
  if (!res.ok) throw new Error(`POST /api/drains/${drainId}/resolve ${res.status}`)
  return res.json()
}
}
