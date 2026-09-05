import { useEffect, useState } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { fetchVehicles, fetchVehicleDrains } from '../api'
import { statusColor, statusLabel, reasonLabel, formatTime } from '../format'
import Pagination, { usePagination } from './Pagination.jsx'

export default function VehiclePanel({ selectedVehicleId, onSelectVehicle, onSelectDrain, onVehicleMapChange }) {
  const [vehicles, setVehicles] = useState(null)
  const [error, setError] = useState(null)
  const [vehicleDrains, setVehicleDrains] = useState([])
  const [drainsLoading, setDrainsLoading] = useState(false)
  const [drainsError, setDrainsError] = useState(null)
  const vehiclePagination = usePagination(vehicles || [], 6, { resetKey: vehicles?.length })
  const drainPagination = usePagination(vehicleDrains, 8, { resetKey: selectedVehicleId })

  useEffect(() => {
    fetchVehicles()
      .then(setVehicles)
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    if (selectedVehicleId == null) {
      setVehicleDrains([])
      setDrainsError(null)
      onVehicleMapChange?.(null)
      return
    }
    let cancelled = false
    setDrainsLoading(true)
    setDrainsError(null)
    fetchVehicleDrains(selectedVehicleId)
      .then((data) => {
        if (!cancelled) {
          setVehicleDrains(data)
          const selectedVehicle = vehicles?.find((vehicle) => vehicle.id === selectedVehicleId)
          // 지도에 이 차량이 실제로 점검한 순서(마지막 방문 시각 오름차순)대로 선을 이어
          // 보여주기 위한 좌표 목록 — 목록 표시 순서(최근 방문 drain 우선)와는 별개다.
          const trail = [...data]
            .filter((d) => d.lat != null && d.lng != null && d.last_seen_by_vehicle)
            .sort((a, b) => new Date(a.last_seen_by_vehicle) - new Date(b.last_seen_by_vehicle))
            .map((d) => [d.lat, d.lng])
          onVehicleMapChange?.({
            vehicleId: selectedVehicleId,
            vehicleCode: selectedVehicle?.vehicle_code || String(selectedVehicleId),
            drainIds: data.map((drain) => drain.drain_id),
            trail,
          })
          setDrainsLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setDrainsError(e.message)
          setDrainsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedVehicleId, vehicles, onVehicleMapChange])

  if (error) return <div className="error-banner">차량 목록 조회 실패: {error}</div>
  if (vehicles === null) {
    return (
      <div className="skeleton-grid">
        <div className="skeleton-block" style={{ height: 48 }} />
        <div className="skeleton-block" style={{ height: 48 }} />
      </div>
    )
  }
  if (vehicles.length === 0) return <div className="empty">등록된 차량이 없습니다.</div>

  return (
    <div>
      <ul className="vehicle-list">
        {vehiclePagination.pageItems.map((v) => (
          <li key={v.id}>
            <button
              className={`vehicle-item ${selectedVehicleId === v.id ? 'selected' : ''}`}
              onClick={() => onSelectVehicle(v.id === selectedVehicleId ? null : v.id)}
              aria-expanded={selectedVehicleId === v.id}
            >
              <span className="vehicle-code">{v.vehicle_code}</span>
              <span className="vehicle-meta">
                {v.vehicle_type || '차종 미상'} / 노선 {v.route_id ?? '-'}
              </span>
              <CaretRight className="vehicle-chevron" size={14} weight="bold" />
            </button>

            {selectedVehicleId === v.id && (
              <div className="vehicle-drains">
                {drainsLoading && <p className="muted">불러오는 중...</p>}
                {drainsError && <div className="error-banner">조회 실패: {drainsError}</div>}
                {!drainsLoading && !drainsError && vehicleDrains.length === 0 && (
                  <p className="muted">이 차량이 보낸 판정 기록이 없습니다.</p>
                )}
                {!drainsLoading && vehicleDrains.length > 0 && (
                  <>
                    <ul className="vehicle-drain-list">
                      {drainPagination.pageItems.map((d) => (
                        <li key={d.drain_id}>
                          <button
                            className="vehicle-drain-item"
                            onClick={() => onSelectDrain?.(d.drain_id)}
                          >
                            <span className="vehicle-drain-name">
                              {d.name} <span className="vehicle-drain-code">{d.external_code}</span>
                            </span>
                            <span
                              className="chip chip-sm"
                              style={{ '--chip-color': statusColor(d.last_status_by_vehicle) }}
                            >
                              {statusLabel(d.last_status_by_vehicle)}
                            </span>
                            <span className="vehicle-drain-meta">
                              차폐{' '}
                              {d.last_occlusion_pct_by_vehicle != null
                                ? `${d.last_occlusion_pct_by_vehicle.toFixed(1)}%`
                                : '-'}{' '}
                              / {d.detection_count}건 / {formatTime(d.last_seen_by_vehicle)}
                              {d.reason_code_by_vehicle &&
                                ` / ${reasonLabel(d.reason_code_by_vehicle)}`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <Pagination
                      page={drainPagination.page}
                      totalPages={drainPagination.totalPages}
                      onPageChange={drainPagination.setPage}
                      label={`${v.vehicle_code} 빗물받이 목록`}
                    />
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <Pagination
        page={vehiclePagination.page}
        totalPages={vehiclePagination.totalPages}
        onPageChange={vehiclePagination.setPage}
        label="차량 목록"
      />
    </div>
  )
}
