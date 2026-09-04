import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, ZoomControl, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { statusColor, statusLabel, STATUS_COLORS } from '../format'

export const DEFAULT_CENTER = [36.8151, 127.1139]

// 어두운 관제 UI 위에 밝은 기본 OSM 타일을 깔면 지도만 하얗게 떠서 상태색 마커가
// 묻힌다. CARTO의 무인증 다크 베이스맵(dark_all)이 API 키 필수 정책으로 바뀌어 깨졌기
// 때문에(워터마크 타일 반환), 키가 필요 없는 표준 OSM 타일 위에 CSS로 다크 변환을 건다
// (.leaflet-tile-pane invert+hue-rotate, App.css) — 마커는 별도 레이어라 색이 그대로 유지된다.
// 기획안 7장의 "외부 네트워크 없이도 동작" 전제는 그대로 — 타일 로드가 실패해도
// 마커/클릭/데이터는 정상 동작한다.
export const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// 팀 색은 상태 4색과 충돌하면 안 되므로(같은 지도 위에 동시에 그려짐) 채도를 낮춘
// 별도 계열을 쓴다.
export const TEAM_COLORS = ['#5ea9d6', '#c9a227', '#6fb98f', '#c77b7b', '#9481c4', '#4fa8a0']
const VEHICLE_TRAIL_COLOR = '#c9a227'

const LEGEND = [
  ['CLEAR', '정상'],
  ['OCCLUDED', '부분 차폐'],
  ['BLOCKED', '막힘'],
  ['UNASSESSABLE', '판정 불가'],
]

function firstReason(reasons) {
  return reasons && reasons.length > 0 ? reasons[0] : null
}

function MapViewport({ points }) {
  const map = useMap()
  // points는 1초 폴링/WS로 매번 새 배열이 되므로, 배열 참조가 아니라 "어떤 지점들이
  // 보이는가"라는 의미적 정체성(id 목록)이 바뀔 때만 카메라를 움직인다 — 그렇지 않으면
  // 값만 갱신돼도 fitBounds/setView가 매초 재실행돼 사용자가 수동으로 옮겨둔 지도 위치를
  // 계속 되돌려버린다(차량 선택 해제 후 지도가 "제자리로" 안 돌아오는 것처럼 느껴지는 원인).
  const key = points.map((p) => p.id).sort((a, b) => a - b).join(',')
  useEffect(() => {
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 17)
    } else if (points.length > 1) {
      map.fitBounds(points.map((point) => [point.lat, point.lng]), { padding: [28, 28] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key])
  return null
}

// 실제 지도(OSM 타일) 기반. 타일 로드가 실패해도(오프라인) 컨테이너/마커/클릭은 정상 동작함 — Leaflet 기본 동작.
export default function PriorityMap({ drains, flashIds, selectedId, onSelect, teams, visibleDrainIds, vehicleTrail }) {
  const points = useMemo(
    () => drains.filter(
      (d) => d.lat != null && d.lng != null && (!visibleDrainIds || visibleDrainIds.has(d.id)),
    ),
    [drains, visibleDrainIds],
  )

  const center = useMemo(() => {
    if (points.length === 0) return DEFAULT_CENTER
    const avgLat = points.reduce((s, d) => s + d.lat, 0) / points.length
    const avgLng = points.reduce((s, d) => s + d.lng, 0) / points.length
    return [avgLat, avgLng]
  }, [points])

  if (points.length === 0) {
    return <div className="empty">표시할 위치 데이터가 없습니다.</div>
  }

  return (
    <MapContainer center={center} zoom={16} className="priority-map" scrollWheelZoom zoomControl={false}>
      <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
      <ZoomControl position="bottomleft" />
      <MapViewport points={points} />

      {teams && teams.map((team, i) => {
        // route_geometry가 있으면(OSRM 실도로망 조회 성공) 실제 도로를 따라가는 선을 그리고,
        // 없으면(OSRM 실패 폴백) 정거장을 직선으로 잇되 점선으로 표시해 "실제 도로 경로가
        // 아니라 근사"임을 시각적으로도 정직하게 드러낸다.
        const hasRoadGeometry = team.route_geometry && team.route_geometry.length >= 2
        const coords = hasRoadGeometry
          ? team.route_geometry
          : team.stops.filter((s) => s.lat != null && s.lng != null).map((s) => [s.lat, s.lng])
        if (coords.length < 2) return null
        return (
          <Polyline
            key={`team-${team.team_id}`}
            positions={coords}
            pathOptions={{
              color: TEAM_COLORS[i % TEAM_COLORS.length],
              weight: 3,
              opacity: 0.8,
              dashArray: hasRoadGeometry ? null : '6 6',
            }}
          />
        )
      })}

      {vehicleTrail && vehicleTrail.length >= 2 && (
        // 차량이 실제로 점검한 순서(마지막 방문 시각 오름차순)를 그대로 이은 선 — 추천 경로가
        // 아니라 과거 이력이라 도로망 스냅 없이 점만 정직하게 잇는다.
        <Polyline
          positions={vehicleTrail}
          pathOptions={{ color: VEHICLE_TRAIL_COLOR, weight: 3, opacity: 0.9, dashArray: '10 6' }}
        />
      )}

      {points.map((d) => {
        const score = Math.max(0, Math.min(1, d.priority_score ?? 0))
        const radius = 8 + score * 12
        const color = statusColor(d.last_status)
        const flashing = flashIds.has(d.id)
        const selected = selectedId === d.id
        const reason = firstReason(d.priority_reasons)

        return (
          // key changes with flashing so the CSS pulse keyframe replays each time it flashes
          <CircleMarker
            key={`${d.id}-${flashing}`}
            center={[d.lat, d.lng]}
            radius={radius}
            eventHandlers={{ click: () => onSelect(d.id) }}
            pathOptions={{
              color: selected ? '#ffffff' : 'rgba(255,255,255,0.35)',
              weight: selected ? 2 : 1,
              fillColor: color,
              fillOpacity: 0.85,
              className: flashing ? 'leaflet-flash-dot' : '',
            }}
          >
            <Popup>
              <div className="map-popup">
                <strong>{d.name}</strong>
                <div className="map-popup-line">
                  {statusLabel(d.last_status)} / 우선순위 {score.toFixed(3)}
                </div>
                {reason && <div className="map-popup-reason">{reason}</div>}
              </div>
            </Popup>
          </CircleMarker>
        )
      })}
    </MapContainer>
  )
}

// 상태 4색이 지도에서 유일한 유채색이므로 범례가 없으면 색을 읽을 수 없다.
export function MapLegend() {
  return (
    <div className="map-legend">
      {LEGEND.map(([key, label]) => (
        <span className="map-legend-item" key={key}>
          <span className="map-legend-swatch" style={{ backgroundColor: STATUS_COLORS[key] }} />
          {label}
        </span>
      ))}
      <span className="map-legend-item">원의 크기는 우선순위 점수</span>
    </div>
  )
}
