import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MapPin, X } from '@phosphor-icons/react'
import PriorityMap, { MapLegend } from './PriorityMap.jsx'
import { statusLabel } from '../format'

const EMPTY_FLASH_IDS = new Set()

export default function RouteMapModal({ route, onClose }) {
  const overlayRef = useRef(null)
  const closeButtonRef = useRef(null)
  const [selectedId, setSelectedId] = useState(route.stops[0]?.id ?? null)

  const mapTeam = useMemo(() => ({
    team_id: route.id,
    route_geometry: route.route_geometry,
    stops: route.stops.map((stop, index) => ({
      drain_id: stop.id,
      lat: stop.lat,
      lng: stop.lng,
      order: index + 1,
    })),
  }), [route])

  useEffect(() => {
    const previouslyFocused = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab') return
      const focusable = overlayRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus?.()
    }
  }, [onClose])

  return createPortal(
    <div
      className="route-map-modal-overlay"
      ref={overlayRef}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="route-map-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="route-map-modal-title"
      >
        <header className="route-map-modal-header">
          <div>
            <h2 id="route-map-modal-title">{route.name} 지도</h2>
            <p>{route.team} · 빗물받이 {route.stops.length}개 · {route.distance} · {route.duration}</p>
          </div>
          <button
            type="button"
            className="route-map-modal-close"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label={`${route.name} 지도 닫기`}
          >
            <X size={19} weight="bold" />
          </button>
        </header>

        <div className="route-map-modal-content">
          <aside className="route-map-stop-panel" aria-label={`${route.name} 빗물받이 목록`}>
            <div className="route-map-stop-heading">
              <strong>방문 빗물받이</strong>
              <span>방문 순서대로 표시</span>
            </div>
            {route.stops.length > 0 ? (
              <ol className="route-map-stop-list">
                {route.stops.map((stop, index) => (
                  <li key={stop.id}>
                    <button
                      type="button"
                      className={selectedId === stop.id ? 'selected' : ''}
                      onClick={() => setSelectedId(stop.id)}
                      aria-pressed={selectedId === stop.id}
                    >
                      <span className="route-map-stop-order">{index + 1}</span>
                      <span className="route-map-stop-copy">
                        <strong>{stop.name}</strong>
                        <small>{statusLabel(stop.last_status)}</small>
                      </span>
                      <MapPin size={17} weight={selectedId === stop.id ? 'fill' : 'regular'} />
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="route-map-stop-empty">이 동선에 배정된 빗물받이가 없습니다.</div>
            )}
          </aside>

          <div className="route-map-modal-map">
            <PriorityMap
              drains={route.stops}
              flashIds={EMPTY_FLASH_IDS}
              selectedId={selectedId}
              onSelect={setSelectedId}
              teams={[mapTeam]}
            />
            {route.stops.length > 0 && <MapLegend />}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
