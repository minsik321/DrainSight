import { useState } from 'react'
import { planRoute } from '../api'
import { TEAM_COLORS } from './PriorityMap.jsx'
import { weatherModeLabel, formatDuration } from '../format'

export default function RoutePlanner({ onResult, selectedTeamId, onSelectTeam }) {
  const [teamCount, setTeamCount] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [plan, setPlan] = useState(null)

  async function handlePlan() {
    setLoading(true)
    setError(null)
    try {
      const result = await planRoute(teamCount)
      setPlan(result)
      onResult?.(result)
    } catch (e) {
      setError(e.message)
      setPlan(null)
      onResult?.(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="route-controls">
        <div className="field">
          <label htmlFor="team-count">투입 팀 수</label>
          <input
            id="team-count"
            type="number"
            min="1"
            value={teamCount}
            onChange={(e) => setTeamCount(Math.max(1, Number(e.target.value) || 1))}
          />
          <span className="field-help">지리적으로 묶어 팀마다 한 덩어리씩 배정합니다.</span>
        </div>
        <button className="btn btn-primary" onClick={handlePlan} disabled={loading}>
          {loading ? '생성 중...' : '동선 추천 생성'}
        </button>
      </div>

      {error && <div className="error-banner">동선 추천 실패: {error}</div>}

      {!plan && !error && !loading && (
        <div className="empty">
          팀 수를 정하고 동선 추천을 생성하면
          <br />
          각 팀의 방문 순서와 경로가 지도에 함께 표시됩니다.
        </div>
      )}

      {plan && (
        <>
          <div className="route-teams">
            {plan.teams.map((team, i) => (
              <div
                key={team.team_id}
                className={`route-team ${selectedTeamId === team.team_id ? 'selected' : ''}`}
              >
                <button
                  type="button"
                  className="route-team-header"
                  onClick={() => onSelectTeam?.(team.team_id)}
                  aria-pressed={selectedTeamId === team.team_id}
                  title="이 팀의 지점과 경로만 지도에 표시"
                >
                  <span
                    className="route-team-swatch"
                    style={{ backgroundColor: TEAM_COLORS[i % TEAM_COLORS.length] }}
                  />
                  <span className="route-team-name">팀 {team.team_id}</span>
                  <span className="route-team-stat">
                    {(team.total_distance_m / 1000).toFixed(2)}km
                    {team.total_duration_s != null && ` · ${formatDuration(team.total_duration_s)}`}
                  </span>
                </button>
                <ol className="route-stop-list">
                  {team.stops.map((s) => (
                    <li key={s.drain_id}>
                      <span className="route-stop-order">{s.order}</span>
                      <span className="route-stop-name">{s.name}</span>
                      <span className="route-stop-meta">
                        {s.priority_score != null ? s.priority_score.toFixed(3) : '-'}
                        {s.leg_distance_m != null ? ` / ${s.leg_distance_m.toFixed(0)}m` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>

          <p className="route-note">
            적용 기준: {weatherModeLabel(plan.weather_mode)} 모드, 차폐율 {plan.occlusion_threshold}%
            이상.
            <br />
            {plan.algorithm_note}
          </p>
        </>
      )}
    </div>
  )
}
