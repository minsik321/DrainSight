import { useEffect, useMemo, useState } from 'react'
import { ArrowCounterClockwise, Plus } from '@phosphor-icons/react'
import PriorityMap, { MapLegend } from '../components/PriorityMap.jsx'
import VehiclePanel from '../components/VehiclePanel.jsx'
import Pagination, { usePagination } from '../components/Pagination.jsx'

const VEHICLE_COLUMNS = ['번호', '노선명', '분류', '노선', '운행시간', '부착부위', '순환 횟수']
const VEHICLE_CATEGORIES = ['버스', '가스차', '쓰레기차', '택시']
const HOUR_OPTIONS = Array.from(
  { length: 24 },
  (_, hour) => `${String(hour).padStart(2, '0')}:00`,
)
const ROUTE_STOP_COUNT = 8
const VEHICLE_STORAGE_KEY = 'drainsight-registered-vehicles'
const DEMO_VEHICLE_PRESETS = [
  { id: 'demo-buldang-01', route_name: '불당01', vehicle_type: '버스', operation_time: '06:00 ~ 22:00', mounting_position: '전면 범퍼 우측', circulation_count: 6 },
  { id: 'demo-dujeong-01', route_name: '두정01', vehicle_type: '택시', operation_time: '07:00 ~ 19:00', mounting_position: '조수석 하단', circulation_count: 8 },
  { id: 'demo-ssangyong-01', route_name: '쌍용01', vehicle_type: '가스차', operation_time: '05:00 ~ 14:00', mounting_position: '차량 전면 중앙', circulation_count: 4 },
  { id: 'demo-cheongsu-01', route_name: '청수01', vehicle_type: '쓰레기차', operation_time: '04:00 ~ 12:00', mounting_position: '전면 범퍼 좌측', circulation_count: 3 },
  { id: 'demo-sinbang-01', route_name: '신방01', vehicle_type: '버스', operation_time: '08:00 ~ 20:00', mounting_position: '조수석 하단', circulation_count: 5 },
  { id: 'demo-baekseok-01', route_name: '백석01', vehicle_type: '택시', operation_time: '09:00 ~ 23:00', mounting_position: '차량 전면 중앙', circulation_count: 7 },
  { id: 'demo-jiksan-01', route_name: '직산01', vehicle_type: '가스차', operation_time: '06:00 ~ 17:00', mounting_position: '전면 범퍼 우측', circulation_count: 4 },
]

function readStoredVehicles() {
  try {
    const stored = JSON.parse(localStorage.getItem(VEHICLE_STORAGE_KEY) || '[]')
    return Array.isArray(stored) ? stored : []
  } catch {
    return []
  }
}

function distanceSquared(a, b) {
  return (a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2
}

function createAutomaticRoute(drains, routeIndex) {
  const candidates = drains.filter(
    (drain) => Number.isFinite(drain.lat) && Number.isFinite(drain.lng),
  )
  if (candidates.length === 0) return []

  const remaining = [...candidates]
  const seedIndex = (routeIndex * ROUTE_STOP_COUNT) % remaining.length
  const route = [remaining.splice(seedIndex, 1)[0]]

  while (route.length < Math.min(ROUTE_STOP_COUNT, candidates.length)) {
    const current = route[route.length - 1]
    let nearestIndex = 0
    for (let index = 1; index < remaining.length; index += 1) {
      if (distanceSquared(current, remaining[index]) < distanceSquared(current, remaining[nearestIndex])) {
        nearestIndex = index
      }
    }
    route.push(remaining.splice(nearestIndex, 1)[0])
  }

  return route
}

function createDemoVehicle(preset, drains, routeIndex, number) {
  const stops = createAutomaticRoute(drains, routeIndex)
  return {
    ...preset,
    number,
    vehicle_code: `데모 차량 ${number}`,
    notes: '노선 관측 시연용 차량',
    stops,
    route_summary: stops.length > 1
      ? `${stops[0].name} ··· ${stops[stops.length - 1].name}`
      : stops[0]?.name || '-',
  }
}

export default function VehicleManagementView({ drains, flashIds, selectedId, onSelectDrain }) {
  const [vehicles, setVehicles] = useState(readStoredVehicles)
  const [selectedVehicleId, setSelectedVehicleId] = useState(null)
  const [vehicleMapSelection, setVehicleMapSelection] = useState(null)
  const [formMessage, setFormMessage] = useState('')
  const vehiclePagination = usePagination(vehicles, 5, { resetKey: vehicles.length })
  const visibleDrainIds = useMemo(
    () => vehicleMapSelection ? new Set(vehicleMapSelection.drainIds) : null,
    [vehicleMapSelection],
  )

  useEffect(() => {
    localStorage.setItem(VEHICLE_STORAGE_KEY, JSON.stringify(vehicles))
  }, [vehicles])

  useEffect(() => {
    if (!drains.length) return

    setVehicles((current) => {
      const registeredIds = new Set(current.map((vehicle) => vehicle.id))
      const missingPresets = DEMO_VEHICLE_PRESETS.filter((preset) => !registeredIds.has(preset.id))
      if (missingPresets.length === 0) return current

      const nextNumber = current.reduce(
        (highest, vehicle) => Math.max(highest, Number(vehicle.number) || 0),
        0,
      ) + 1
      const demoVehicles = missingPresets.map((preset, index) => (
        createDemoVehicle(preset, drains, index + 1, nextNumber + index)
      ))
      return [...current, ...demoVehicles]
    })
  }, [drains])

  function handleSubmit(event) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const routeName = String(formData.get('routeName') || '').trim()
    const stops = createAutomaticRoute(drains, vehicles.length)

    if (!routeName) {
      setFormMessage('노선명을 입력해 주세요.')
      form.elements.routeName.focus()
      return
    }
    if (stops.length === 0) {
      setFormMessage('노선에 배정할 빗물받이 위치가 없습니다.')
      return
    }

    const number = vehicles.length + 1
    const vehicle = {
      id: `local-${Date.now()}-${number}`,
      number,
      vehicle_code: `등록 차량 ${number}`,
      route_name: routeName,
      vehicle_type: String(formData.get('category')),
      operation_time: `${formData.get('operationStart')} ~ ${formData.get('operationEnd')}`,
      mounting_position: String(formData.get('mountingPosition') || '').trim() || '-',
      circulation_count: Number(formData.get('circulationCount')) || 0,
      notes: String(formData.get('notes') || '').trim(),
      stops,
      route_summary: stops.length > 1
        ? `${stops[0].name} ··· ${stops[stops.length - 1].name}`
        : stops[0].name,
    }

    setVehicles((current) => [...current, vehicle])
    setSelectedVehicleId(vehicle.id)
    setFormMessage(`${routeName} 차량을 추가했습니다.`)
    form.reset()
  }

  return (
    <div className="fleet-management-view">
      <section className="fleet-registry-card" aria-label="차량 목록">
        <div className="fleet-table-scroll">
          <table className="fleet-table">
            <thead>
              <tr>
                {VEHICLE_COLUMNS.map((column) => <th key={column} scope="col">{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {vehicles.length > 0 ? vehiclePagination.pageItems.map((vehicle) => (
                <tr key={vehicle.id}>
                  <td>{vehicle.number}</td>
                  <td title={vehicle.route_name}>{vehicle.route_name}</td>
                  <td>{vehicle.vehicle_type}</td>
                  <td title={vehicle.route_summary}>{vehicle.route_summary}</td>
                  <td>{vehicle.operation_time}</td>
                  <td title={vehicle.mounting_position}>{vehicle.mounting_position}</td>
                  <td>{vehicle.circulation_count}</td>
                </tr>
              )) : (
                <tr>
                  <td className="fleet-table-empty" colSpan={VEHICLE_COLUMNS.length}>
                    차량 추가 폼을 작성하면 이곳에 등록됩니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={vehiclePagination.page}
          totalPages={vehiclePagination.totalPages}
          onPageChange={vehiclePagination.setPage}
          label="등록 차량 목록"
        />
      </section>

      <aside className="fleet-add-card">
        <h2>차량 추가</h2>
        <form className="fleet-add-form" onSubmit={handleSubmit}>
          <label className="fleet-form-field">
            <span>노선명</span>
            <input type="text" name="routeName" maxLength="40" required />
          </label>

          <label className="fleet-form-field">
            <span>분류</span>
            <select name="category" defaultValue="버스">
              {VEHICLE_CATEGORIES.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>

          <div className="fleet-form-field">
            <span>운행시간</span>
            <div className="fleet-time-range">
              <select name="operationStart" aria-label="운행 시작 시간" defaultValue="09:00">
                {HOUR_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
              </select>
              <span className="fleet-time-separator" aria-hidden="true">~</span>
              <select name="operationEnd" aria-label="운행 종료 시간" defaultValue="18:00">
                {HOUR_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
              </select>
            </div>
          </div>

          <label className="fleet-form-field">
            <span>부착부위</span>
            <input type="text" name="mountingPosition" maxLength="40" />
          </label>

          <label className="fleet-form-field fleet-form-field-compact">
            <span>순환 횟수</span>
            <input type="number" name="circulationCount" min="0" step="1" defaultValue="0" />
          </label>

          <label className="fleet-form-field fleet-form-notes">
            <span>비고</span>
            <textarea name="notes" rows="4" maxLength="200" />
          </label>

          <div className="fleet-form-footer">
            <span className="fleet-form-message" role="status" aria-live="polite">{formMessage}</span>
            <button type="submit" className="btn btn-primary fleet-add-button">
              <Plus size={14} weight="bold" />
              추가
            </button>
          </div>
        </form>
      </aside>

      <section className="fleet-route-card" aria-labelledby="fleet-route-title">
        <div className="fleet-route-head">
          <div>
            <h2 id="fleet-route-title">노선별 관측 현황</h2>
            <p>노선명을 선택하면 관측 빗물받이와 이동 경로를 함께 확인할 수 있습니다.</p>
          </div>
        </div>
        <div className="split-view fleet-route-split">
          <div className="split-list">
            <VehiclePanel
              localRoutes={vehicles}
              selectedVehicleId={selectedVehicleId}
              onSelectVehicle={setSelectedVehicleId}
              onSelectDrain={onSelectDrain}
              onVehicleMapChange={setVehicleMapSelection}
            />
          </div>
          <div className="split-map">
            <PriorityMap
              drains={drains}
              flashIds={flashIds}
              selectedId={selectedId}
              onSelect={onSelectDrain}
              visibleDrainIds={visibleDrainIds}
              vehicleTrail={vehicleMapSelection?.trail}
            />
            <MapLegend />
            {!vehicleMapSelection && (
              <div className="split-map-hint">
                노선명을 선택하면 관측한 빗물받이와
                <br />
                이동 경로가 지도에 표시됩니다.
              </div>
            )}
            {selectedVehicleId != null && (
              <button
                type="button"
                className="btn btn-sm split-map-reset"
                onClick={() => setSelectedVehicleId(null)}
              >
                <ArrowCounterClockwise size={13} weight="bold" />
                전체 지점 보기
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
