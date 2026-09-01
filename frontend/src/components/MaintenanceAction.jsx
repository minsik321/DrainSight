import { useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { resolveDrain } from '../api'
import { formatTime } from '../format'

// 백엔드 main.py::is_resolved와 동일한 판단 기준을 프론트에서도 재현 — 사람이 조치/점검
// 완료로 표시한 뒤로 AI가 그보다 최신의 실제 판정을 보고한 적이 없으면 "아직 유효한 처리".
function isResolved(drain) {
  if (!drain.maintenance_resolved_at) return false
  if (!drain.last_updated) return true
  return new Date(drain.maintenance_resolved_at) >= new Date(drain.last_updated)
}

export default function MaintenanceAction({ drain, onResolved }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  if (!drain) return null

  const resolved = isResolved(drain)
  const isProblem = drain.last_status === 'BLOCKED' || drain.last_status === 'OCCLUDED'
  const needsInspection = drain.last_status == null || drain.last_status === 'UNASSESSABLE'

  if (!resolved && !isProblem && !needsInspection) return null // CLEAR면 조치할 게 없음

  async function handleResolve() {
    setLoading(true)
    setError(null)
    try {
      const updated = await resolveDrain(drain.id)
      onResolved?.(updated)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="inspector-section">
      {resolved ? (
        <div className="maintenance-badge">
          <CheckCircle size={16} weight="fill" />
          <span>
            {drain.maintenance_note || '처리 완료'}
            <span className="maintenance-time">{formatTime(drain.maintenance_resolved_at)}</span>
          </span>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={handleResolve} disabled={loading}>
          {loading ? '기록하는 중...' : isProblem ? '조치 완료로 기록' : '점검 완료로 기록'}
        </button>
      )}
      {error && <div className="error-banner" style={{ marginTop: 10 }}>처리 실패: {error}</div>}
    </section>
  )
}
