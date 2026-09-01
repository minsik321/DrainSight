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

export async function resolveDrain(drainId, note) {
  const res = await fetch(`${API_BASE}/api/drains/${drainId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note || null }),
  })
  if (!res.ok) throw new Error(`POST /api/drains/${drainId}/resolve ${res.status}`)
  return res.json()
}
