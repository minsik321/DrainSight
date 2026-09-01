import { useMemo } from 'react'
import { MapContainer, TileLayer, CircleMarker } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { statusColor } from '../format'
import { DEFAULT_CENTER, TILE_URL, TILE_ATTRIBUTION } from './PriorityMap.jsx'

// 개요 화면의 배경. div로 가짜 지도 그림을 그리는 대신 실제 Leaflet 지도를 그대로 깔고
// CSS로 어둡게 낮춘다 — 실제 지점 좌표와 실제 상태색이 배경에 그대로 살아있다.
// 상호작용은 전부 꺼져 있고(pointer-events는 CSS에서 차단) 카메라도 고정이라,
// 위에 올라가는 요약 텍스트를 방해하지 않는다. 타일 자체의 명암 반전 필터는
// .leaflet-tile-pane 전역 규칙(App.css)이 테마에 맞춰 알아서 처리한다 — 라이트
// 테마에서는 밝은 지도, 다크 테마에서는 어두운 지도로 배경도 함께 바뀐다.
export default function AmbientMap({ drains }) {
  const points = useMemo(
    () => (drains || []).filter((d) => d.lat != null && d.lng != null),
    [drains],
  )

  const center = useMemo(() => {
    if (points.length === 0) return DEFAULT_CENTER
    return [
      points.reduce((s, d) => s + d.lat, 0) / points.length,
      points.reduce((s, d) => s + d.lng, 0) / points.length,
    ]
  }, [points])

  return (
    <div className="overview-map" aria-hidden="true">
      <MapContainer
        center={center}
        zoom={16}
        zoomControl={false}
        attributionControl={false}
        scrollWheelZoom={false}
        dragging={false}
        doubleClickZoom={false}
        touchZoom={false}
        keyboard={false}
        boxZoom={false}
      >
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
        {points.map((d) => (
          <CircleMarker
            key={d.id}
            center={[d.lat, d.lng]}
            radius={6 + Math.max(0, Math.min(1, d.priority_score ?? 0)) * 10}
            interactive={false}
            pathOptions={{
              color: 'rgba(255,255,255,0.28)',
              weight: 1,
              fillColor: statusColor(d.last_status),
              fillOpacity: 0.7,
            }}
          />
        ))}
      </MapContainer>
    </div>
  )
}
