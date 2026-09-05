import { useEffect, useMemo, useState } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { fetchVehicles, fetchVehicleDrains } from '../api'
import { statusColor, statusLabel, reasonLabel, formatTime } from '../format'
import Pagination, { usePagination } from './Pagination.jsx'

export default function VehiclePanel({
  selectedVehicleId,
  onSelectVehicle,
  onSelectDrain,
  onVehicleMapChange,
  localRoutes = [],
}) {
  const [vehicles, setVehicles] = useState(null)
  const [error, setError] = useState(null)
  const [vehicleDrains, setVehicleDrains] = useState([])
  const [drainsLoading, setDrainsLoading] = useState(false)
  const [drainsError, setDrainsError] = useState(null)
  const displayedVehicles = useMemo(
    () => [...localRoutes, ...(vehicles || [])],
    [localRoutes, vehicles],
  )
  const vehiclePagination = usePagination(displayedVehicles, 6, { resetKey: displayedVehicles.length })
  const drainPagination = usePagination(vehicleDrains, 8, { resetKey: selectedVehicleId })

  useEffect(() => {
    fetchVehicles()
      .then(setVehicles)
      .catch((fetchError) => setError(fetchError.message))
  }, [])

  useEffect(() => {
    if (selectedVehicleId == null) {
      setVehicleDrains([])
      setDrainsError(null)
      onVehicleMapChange?.(null)
      return
    }

    const localRoute = localRoutes.find((vehicle) => vehicle.id === selectedVehicleId)
    if (localRoute) {
      const data = localRoute.stops.map((drain) => ({
        ...drain,
        drain_id: drain.id,
        detection_count: 0,
        last_status_by_vehicle: drain.last_status,
        last_occlusion_pct_by_vehicle: drain.last_occlusion_pct,
        last_seen_by_vehicle: drain.last_updated,
        reason_code_by_vehicle: drain.reason_code,
      }))
      setVehicleDrains(data)
      setDrainsError(null)
      setDrainsLoading(false)
      onVehicleMapChange?.({
        vehicleId: localRoute.id,
        vehicleCode: localRoute.route_name,
        drainIds: localRoute.stops.map((drain) => drain.id),
        trail: localRoute.stops.map((drain) => [drain.lat, drain.lng]),
      })
      return
    }

    let cancelled = false
    setDrainsLoading(true)
    setDrainsError(null)
    fetchVehicleDrains(selectedVehicleId)
      .then((data) => {
        if (cancelled) return
        setVehicleDrains(data)
        const selectedVehicle = vehicles?.find((vehicle) => vehicle.id === selectedVehicleId)
        const trail = [...data]
          .filter((drain) => drain.lat != null && drain.lng != null && drain.last_seen_by_vehicle)
          .sort((a, b) => new Date(a.last_seen_by_vehicle) - new Date(b.last_seen_by_vehicle))
          .map((drain) => [drain.lat, drain.lng])
        onVehicleMapChange?.({
          vehicleId: selectedVehicleId,
          vehicleCode: selectedVehicle?.vehicle_code || String(selectedVehicleId),
          drainIds: data.map((drain) => drain.drain_id),
          trail,
        })
        setDrainsLoading(false)
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setDrainsError(fetchError.message)
          setDrainsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedVehicleId, vehicles, localRoutes, onVehicleMapChange])

  if (error && localRoutes.length === 0) {
    return <div className="error-banner">기존 차량 목록 조회 실패: {error}</div>
  }
  if (vehicles === null && localRoutes.length === 0) {
    return (
      <div className="skeleton-grid">
        <div className="skeleton-block" style={{ height: 48 }} />
        <div className="skeleton-block" style={{ height: 48 }} />
      </div>
    )
  }
  if (displayedVehicles.length === 0) return <div className="empty">등록된 노선이 없습니다.</div>

  return (
    <div>
      {error && <div className="error-banner">기존 차량 목록 조회 실패: {error}</div>}
      <ul className="vehicle-list">
        {vehiclePagination.pageItems.map((vehicle) => (
          <li key={vehicle.id}>
            <button
              type="button"
              className={`vehicle-item ${selectedVehicleId === vehicle.id ? 'selected' : ''}`}
              onClick={() => onSelectVehicle(vehicle.id === selectedVehicleId ? null : vehicle.id)}
              aria-expanded={selectedVehicleId === vehicle.id}
            >
              <span className="vehicle-code">{vehicle.route_name || `노선 ${vehicle.route_id ?? '-'}`}</span>
              <span className="vehicle-meta">
                {vehicle.vehicle_code} / {vehicle.vehicle_type || '분류 미상'}
              </span>
              <CaretRight className="vehicle-chevron" size={14} weight="bold" />
            </button>

            {selectedVehicleId === vehicle.id && (
              <div className="vehicle-drains">
                {drainsLoading && <p className="muted">불러오는 중...</p>}
                {drainsError && <div className="error-banner">조회 실패: {drainsError}</div>}
                {!drainsLoading && !drainsError && vehicleDrains.length === 0 && (
                  <p className="muted">이 노선의 관측 기록이 없습니다.</p>
                )}
                {!drainsLoading && vehicleDrains.length > 0 && (
                  <>
                    <ul className="vehicle-drain-list">
                      {drainPagination.pageItems.map((drain) => (
                        <li key={drain.drain_id}>
                          <button
                            type="button"
                            className="vehicle-drain-item"
                            onClick={() => onSelectDrain?.(drain.drain_id)}
                          >
                            <span className="vehicle-drain-name">
                              {drain.name} <span className="vehicle-drain-code">{drain.external_code}</span>
                            </span>
                            <span
                              className="chip chip-sm"
                              style={{ '--chip-color': statusColor(drain.last_status_by_vehicle) }}
                            >
                              {statusLabel(drain.last_status_by_vehicle)}
                            </span>
                            <span className="vehicle-drain-meta">
                              차폐율 {drain.last_occlusion_pct_by_vehicle != null
                                ? `${drain.last_occlusion_pct_by_vehicle.toFixed(1)}%`
                                : '-'} / {drain.detection_count}회 / {formatTime(drain.last_seen_by_vehicle)}
                              {drain.reason_code_by_vehicle && ` / ${reasonLabel(drain.reason_code_by_vehicle)}`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <Pagination
                      page={drainPagination.page}
                      totalPages={drainPagination.totalPages}
                      onPageChange={drainPagination.setPage}
                      label={`${vehicle.route_name || vehicle.vehicle_code} 빗물받이 목록`}
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
        label="노선 목록"
      />
    </div>
  )
}
