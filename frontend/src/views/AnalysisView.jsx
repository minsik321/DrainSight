import { useEffect, useMemo, useState } from 'react'
import { ArrowsLeftRight, DownloadSimple } from '@phosphor-icons/react'
import { fetchAllSystemEvents, fetchVehicleDrains, fetchVehicles } from '../api'
import { daysSince, formatTime, statusColor, statusLabel, weatherModeLabel } from '../format'
import { TREND_FIXTURE } from '../analyticsTrendFixture'

const STATUS_ORDER = ['CLEAR', 'OCCLUDED', 'BLOCKED', 'UNASSESSABLE']
const CAUSE_LABELS = { occlusion: '차폐율', staleness: '미점검 경과', flood_history: '침수 이력', elevation: '고도 위험도' }
const CAUSE_COLORS = {
  occlusion: 'var(--st-blocked)',
  staleness: 'var(--st-occluded)',
  flood_history: 'var(--accent)',
  elevation: 'var(--st-unassessable)',
}

function median(nums) {
  const s = nums.filter((n) => n != null).sort((a, b) => a - b)
  if (s.length === 0) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function SegmentedTabs({ options, value, onChange, label }) {
  return (
    <div className="segmented-tabs" role="tablist" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="tab"
          aria-selected={value === opt}
          className={`segmented-tab ${value === opt ? 'active' : ''}`}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label className="select-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </label>
  )
}

function KpiCard({ label, value, sublabel }) {
  return (
    <div className="kpi-card">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sublabel && <span className="kpi-sublabel">{sublabel}</span>}
    </div>
  )
}

function RankBar({ rank, label, meta, value, valueLabel, color = 'var(--accent)', onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`rank-bar ${rank != null ? 'rank-bar-ranked' : ''} ${onClick ? 'rank-bar-clickable' : ''}`}
      onClick={onClick}
    >
      {rank != null && <span className="rank-bar-rank">{rank}</span>}
      <span className="rank-bar-label-group">
        <span className="rank-bar-label">{label}</span>
        {meta && <span className="rank-bar-meta">{meta}</span>}
      </span>
      <span className="score-bar">
        <span className="score-bar-fill" style={{ '--fill': value || 0, '--row-color': color }} />
      </span>
      <span className="rank-bar-value">{valueLabel}</span>
    </Tag>
  )
}

function StatRow({ label, value }) {
  return (
    <div className="quality-stat-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

// 세 가지 모드를 전환하는 하나의 차트. 차폐율/상태 건수/점검 범위 모두 현재는
// analyticsTrendFixture.js의 예시 데이터로 그린다(파일 상단 주석 참고).
function TrendChart({ points, mode, compareOn, threshold }) {
  const W = 640
  const H = 220
  const P = 32
  const IW = W - P * 2
  const IH = H - P * 2
  const step = points.length > 1 ? IW / (points.length - 1) : 0
  const x = (i) => P + i * step

  if (mode === '차폐율') {
    const y = (v) => P + IH - (Math.max(0, Math.min(100, v)) / 100) * IH
    const line = points.map((p, i) => `${x(i)},${y(p.occ)}`).join(' ')
    const prevLine = points.map((p, i) => `${x(i)},${y(p.prevOcc)}`).join(' ')
    const ty = y(threshold)
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart-svg" role="img" aria-label="차폐율 추이">
        {[0, 25, 50, 75, 100].map((t) => (
          <g key={t}>
            <line className="chart-grid-line" x1={P} x2={W - P} y1={y(t)} y2={y(t)} />
            <text className="chart-tick" x={4} y={y(t) + 4}>{t}</text>
          </g>
        ))}
        <line x1={P} x2={W - P} y1={ty} y2={ty} className="trend-threshold-line" />
        <text x={W - P} y={ty - 6} className="trend-threshold-label" textAnchor="end">조치 기준 {threshold}%</text>
        {compareOn && <polyline points={prevLine} className="trend-prev-line" />}
        <polyline points={line} className="chart-line" />
        {points.map((p, i) => <circle className="chart-dot" key={i} cx={x(i)} cy={y(p.occ)} r="3.5" />)}
        {points.map((p, i) => <text key={`l${i}`} x={x(i)} y={H - 6} className="chart-tick" textAnchor="middle">{p.date}</text>)}
      </svg>
    )
  }

  if (mode === '상태 건수') {
    const maxTotal = Math.max(1, ...points.map((p) => p.clear + p.occluded + p.blocked + p.unassessable))
    const bw = Math.min(28, step * 0.55)
    const segs = [
      ['clear', 'var(--st-clear)'],
      ['occluded', 'var(--st-occluded)'],
      ['blocked', 'var(--st-blocked)'],
      ['unassessable', 'var(--st-unassessable)'],
    ]
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart-svg" role="img" aria-label="상태 건수 추이">
        {points.map((p, i) => {
          let cursor = P + IH
          return (
            <g key={i}>
              {segs.map(([key, color]) => {
                const h = (p[key] / maxTotal) * IH
                cursor -= h
                return <rect key={key} x={x(i) - bw / 2} y={cursor} width={bw} height={h} style={{ fill: color }} />
              })}
              <text x={x(i)} y={H - 6} className="chart-tick" textAnchor="middle">{p.date}</text>
            </g>
          )
        })}
        <line x1={P} x2={W - P} y1={P + IH} y2={P + IH} className="trend-axis-line" />
      </svg>
    )
  }

  const maxInspected = Math.max(1, ...points.map((p) => p.inspected))
  const bw = Math.min(28, step * 0.5)
  const cy = (v) => P + IH - (Math.max(0, Math.min(100, v)) / 100) * IH
  const covLine = points.map((p, i) => `${x(i)},${cy(p.coverage)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart-svg" role="img" aria-label="점검 범위 추이">
      {points.map((p, i) => (
        <rect
          key={i}
          x={x(i) - bw / 2}
          y={P + IH - (p.inspected / maxInspected) * IH}
          width={bw}
          height={(p.inspected / maxInspected) * IH}
          className="trend-coverage-bar"
        />
      ))}
      <polyline points={covLine} className="chart-line" />
      {points.map((p, i) => <circle className="chart-dot" key={i} cx={x(i)} cy={cy(p.coverage)} r="3.5" />)}
      {points.map((p, i) => <text key={`l${i}`} x={x(i)} y={H - 6} className="chart-tick" textAnchor="middle">{p.date}</text>)}
      <line x1={P} x2={W - P} y1={P + IH} y2={P + IH} className="trend-axis-line" />
    </svg>
  )
}

const TOP10_COLS = ['순위', '지점', '상태', '차폐율', '우선순위', '미점검', '주요 원인', '최근 판정', '조치 상태']

function Top10Table({ rows, onOpen }) {
  if (rows.length === 0) {
    return <div className="top10-empty">현재 필터에 해당하는 지점이 없습니다.</div>
  }
  return (
    <div className="top10-table">
      <div className="top10-row top10-head">
        {TOP10_COLS.map((c) => <span key={c}>{c}</span>)}
      </div>
      {rows.map((d, i) => {
        const elapsed = daysSince(d.last_updated)
        return (
          <button key={d.id} type="button" className="top10-row" onClick={() => onOpen(d.id)}>
            <span className="top10-rank">{i + 1}</span>
            <span className="top10-name-cell">
              <span className="top10-name">{d.name}</span>
              <span className="top10-code">
                {d.external_code || `ID ${d.id}`}
                {d.route_ids?.length > 0 && ` · 노선 ${d.route_ids.join(', ')}`}
              </span>
            </span>
            <span className="chip chip-sm" style={{ '--chip-color': statusColor(d.last_status) }}>
              {statusLabel(d.last_status)}
            </span>
            <span className="top10-mono">{d.last_occlusion_pct != null ? `${d.last_occlusion_pct.toFixed(1)}%` : '-'}</span>
            <span className="top10-mono">{d.priority_score != null ? d.priority_score.toFixed(3) : '-'}</span>
            <span className="top10-mono top10-muted">{elapsed != null ? `${Math.floor(elapsed)}일` : '-'}</span>
            <span className="top10-reason">{d.priority_reasons?.[0] || '-'}</span>
            <span className="top10-mono top10-muted">{formatTime(d.last_updated)}</span>
            <span className={`top10-action ${d.requires_action ? 'needs-action' : 'ok'}`}>
              {d.requires_action ? '조치 필요' : '정상'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// 분석 — 요약 → 변화 → 원인 → 위치·차량 → 실제 지점.
// 상태 구성, 우선순위 원인 기여도, 노선/차량별 비교, TOP 10, 조치 성과, 데이터 품질은
// 모두 현재 drains 스냅샷 + 실시간 조회한 vehicles/system-events에서 계산한다.
// "기간별 상태 변화" 추이 차트만 analyticsTrendFixture.js의 예시 데이터를 쓴다
// (그 파일 상단 주석에 이유 설명).
export default function AnalysisView({ drains, weatherAlert, onOpenDrain }) {
  const [period, setPeriod] = useState('7일')
  const [compareOn, setCompareOn] = useState(true)
  const [chartMode, setChartMode] = useState('차폐율')
  const [segmentTab, setSegmentTab] = useState('노선별')
  const [contribScope, setContribScope] = useState('전체 지점')
  const [statusFilter, setStatusFilter] = useState('전체')
  const [routeFilter, setRouteFilter] = useState('전체')
  const [vehicleFilter, setVehicleFilter] = useState('전체')

  const [vehicles, setVehicles] = useState([])
  const [vehicleDrainsByVehicle, setVehicleDrainsByVehicle] = useState({})
  const [systemEvents, setSystemEvents] = useState([])
  const [loadError, setLoadError] = useState(null)

  const alert = weatherAlert || {}
  const weightProfile = alert.weight_profile || {}

  useEffect(() => {
    let cancelled = false
    fetchVehicles()
      .then((list) => {
        if (cancelled) return
        setVehicles(list)
        return Promise.all(list.map((v) => fetchVehicleDrains(v.id).then((rows) => [v.id, rows])))
      })
      .then((pairs) => {
        if (cancelled || !pairs) return
        setVehicleDrainsByVehicle(Object.fromEntries(pairs))
      })
      .catch((e) => !cancelled && setLoadError(e.message))

    fetchAllSystemEvents()
      .then((events) => !cancelled && setSystemEvents(events))
      .catch((e) => !cancelled && setLoadError(e.message))

    return () => { cancelled = true }
  }, [])

  const total = drains.length

  const breakdown = useMemo(() => {
    const counts = { CLEAR: 0, OCCLUDED: 0, BLOCKED: 0, UNASSESSABLE: 0 }
    drains.forEach((d) => { if (d.last_status) counts[d.last_status] = (counts[d.last_status] || 0) + 1 })
    return STATUS_ORDER.map((k) => ({
      key: k, label: statusLabel(k), count: counts[k], pct: total ? counts[k] / total : 0,
    }))
  }, [drains, total])

  const contribution = useMemo(() => {
    let scoped = drains
    if (contribScope === '조치 필요 지점만') scoped = drains.filter((d) => d.requires_action)
    if (contribScope === 'TOP 20 지점') scoped = [...drains].sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0)).slice(0, 20)
    const sums = { occlusion: 0, staleness: 0, flood_history: 0, elevation: 0 }
    scoped.forEach((d) => {
      sums.occlusion += (weightProfile.occlusion || 0) * (d.occlusion_norm || 0)
      sums.staleness += (weightProfile.staleness || 0) * (d.staleness_risk || 0)
      sums.flood_history += (weightProfile.flood_history || 0) * (d.flood_history_flag || 0)
      sums.elevation += (weightProfile.elevation || 0) * (d.elevation_risk || 0)
    })
    const sumTotal = Object.values(sums).reduce((a, b) => a + b, 0) || 1
    return Object.keys(sums)
      .map((k) => ({ key: k, label: CAUSE_LABELS[k], pct: sums[k] / sumTotal, color: CAUSE_COLORS[k] }))
      .sort((a, b) => b.pct - a.pct)
  }, [drains, weightProfile, contribScope])

  // 공유 배수구는 route_ids가 여러 노선에 걸치므로, 각 노선 버킷에 중복으로 들어간다.
  const routeRows = useMemo(() => {
    const byRoute = {}
    drains.forEach((d) => {
      const routes = d.route_ids?.length ? d.route_ids : ['미배정']
      routes.forEach((r) => (byRoute[r] ||= []).push(d))
    })
    return Object.entries(byRoute).map(([route, rows]) => {
      const occs = rows.map((d) => d.last_occlusion_pct).filter((v) => v != null)
      const needsAction = rows.filter((d) => d.requires_action).length
      const unassessable = rows.filter((d) => d.last_status === 'UNASSESSABLE').length
      return {
        route, inspected: rows.length, needsAction,
        needsActionRate: rows.length ? needsAction / rows.length : 0,
        medianOcc: median(occs), unassessableRate: rows.length ? unassessable / rows.length : 0,
      }
    }).sort((a, b) => b.needsActionRate - a.needsActionRate)
  }, [drains])

  const missingByVehicle = useMemo(() => {
    const m = {}
    systemEvents
      .filter((e) => e.event_type === 'RESULT_MISSING' && e.vehicle_id != null)
      .forEach((e) => {
        const entry = m[e.vehicle_id] || { count: 0, latest: null }
        entry.count += 1
        if (!entry.latest || new Date(e.occurred_at) > new Date(entry.latest)) entry.latest = e.occurred_at
        m[e.vehicle_id] = entry
      })
    return m
  }, [systemEvents])

  const vehicleRows = useMemo(() => {
    return vehicles.map((v) => {
      const rows = vehicleDrainsByVehicle[v.id] || []
      const observations = rows.reduce((s, r) => s + (r.detection_count || 0), 0)
      const unassessable = rows.filter((r) => r.last_status_by_vehicle === 'UNASSESSABLE').length
      const lastSeen = rows.reduce((max, r) => (
        !max || (r.last_seen_by_vehicle && new Date(r.last_seen_by_vehicle) > new Date(max)) ? r.last_seen_by_vehicle : max
      ), null)
      const missing = missingByVehicle[v.id]?.count || 0
      return {
        vehicle: v.vehicle_code, vehicleId: v.id, routeId: v.route_id,
        observations, uniqueDrains: rows.length,
        unassessable, unassessableRate: rows.length ? unassessable / rows.length : 0,
        missing, lastSeen,
      }
    }).sort((a, b) => b.unassessableRate - a.unassessableRate)
  }, [vehicles, vehicleDrainsByVehicle, missingByVehicle])

  const maxUnassessableRate = Math.max(0.0001, ...routeRows.map((r) => r.unassessableRate), ...vehicleRows.map((r) => r.unassessableRate))

  const vehicleDrainIdSets = useMemo(() => {
    const m = {}
    vehicles.forEach((v) => {
      m[v.vehicle_code] = new Set((vehicleDrainsByVehicle[v.id] || []).map((r) => r.drain_id))
    })
    return m
  }, [vehicles, vehicleDrainsByVehicle])

  const routeOptions = useMemo(() => ['전체', ...Object.keys(
    drains.reduce((acc, d) => { (d.route_ids || []).forEach((r) => { acc[r] = true }); return acc }, {}),
  ).map((r) => `노선 ${r}`)], [drains])
  const vehicleOptions = ['전체', ...vehicles.map((v) => v.vehicle_code)]

  const top10 = useMemo(() => {
    return [...drains]
      .filter((d) => statusFilter === '전체' || statusLabel(d.last_status) === statusFilter)
      .filter((d) => routeFilter === '전체' || (d.route_ids || []).some((r) => `노선 ${r}` === routeFilter))
      .filter((d) => vehicleFilter === '전체' || vehicleDrainIdSets[vehicleFilter]?.has(d.id))
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
      .slice(0, 10)
  }, [drains, statusFilter, routeFilter, vehicleFilter, vehicleDrainIdSets])

  const assessedCount = drains.filter((d) => d.last_status != null).length
  const actionCount = drains.filter((d) => d.requires_action).length
  const blockedCount = drains.filter((d) => d.last_status === 'BLOCKED').length
  const occMedian = median(drains.map((d) => d.last_occlusion_pct))
  const unassessableCount = breakdown.find((b) => b.key === 'UNASSESSABLE')?.count ?? 0
  const resolvedCount = drains.filter((d) => d.maintenance_resolved_at).length

  const summary = useMemo(() => {
    const worstRoute = routeRows[0]
    const topCause = contribution[0]
    return `현재 등록된 ${total}개 지점 중 ${assessedCount}곳이 판정을 받았고, ${actionCount}곳이 조치가 필요합니다.`
      + (worstRoute ? ` 노선 ${worstRoute.route}에서 판정 불가 비율이 ${(worstRoute.unassessableRate * 100).toFixed(1)}%로 가장 높습니다.` : '')
      + (topCause ? ` 조치 필요 지점의 우선순위는 주로 ${topCause.label}(${(topCause.pct * 100).toFixed(0)}%)에서 비롯됩니다.` : '')
  }, [routeRows, contribution, total, assessedCount, actionCount])

  const modeLabel = weatherModeLabel(alert.mode)
  const trendPack = TREND_FIXTURE[period] || TREND_FIXTURE['7일']

  const totalMissing = Object.values(missingByVehicle).reduce((s, v) => s + v.count, 0)
  const worstMissingVehicleId = Object.entries(missingByVehicle).sort((a, b) => b[1].count - a[1].count)[0]?.[0]
  const worstMissingVehicle = vehicles.find((v) => String(v.id) === String(worstMissingVehicleId))
  const worstMissing = worstMissingVehicleId ? missingByVehicle[worstMissingVehicleId] : null

  function exportCsv() {
    const header = ['id', '지점명', '코드', '노선', '상태', '차폐율(%)', '우선순위', '조치필요', '최근판정', '주요원인']
    const rows = drains.map((d) => [
      d.id, d.name, d.external_code || '', (d.route_ids || []).join('/'), statusLabel(d.last_status),
      d.last_occlusion_pct ?? '', d.priority_score ?? '', d.requires_action ? 'Y' : 'N',
      d.last_updated || '', (d.priority_reasons?.[0] || '').replace(/,/g, ';'),
    ])
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `drainsight-분석-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="analysis-view">
      <div className="analysis-toolbar">
        <div className="analysis-toolbar-left">
          <SegmentedTabs options={['오늘', '7일', '30일']} value={period} onChange={setPeriod} label="추이 차트 기간" />
          <button type="button" className="btn btn-sm" disabled title="사용자 지정 기간 (데모에서는 비활성)">
            기간 설정
          </button>
          <button
            type="button"
            className={`btn btn-sm ${compareOn ? 'btn-primary' : ''}`}
            onClick={() => setCompareOn((v) => !v)}
          >
            <ArrowsLeftRight size={13} weight="bold" />
            이전 기간과 비교
          </button>
          <SelectField label="노선" value={routeFilter} onChange={setRouteFilter} options={routeOptions} />
          <SelectField label="차량" value={vehicleFilter} onChange={setVehicleFilter} options={vehicleOptions} />
          <SelectField
            label="상태"
            value={statusFilter}
            onChange={setStatusFilter}
            options={['전체', '정상', '부분 차폐', '막힘', '판정 불가']}
          />
        </div>
        <div className="analysis-toolbar-right">
          <span className="analysis-mode-note">
            현재 기준: {modeLabel} 모드<br />
            차폐율 {alert.occlusion_threshold ?? '-'}% 이상 또는 {alert.staleness_threshold_days ?? '-'}일 이상 미점검
          </span>
          <button type="button" className="btn btn-sm" onClick={exportCsv}>
            <DownloadSimple size={13} weight="bold" />
            CSV 내보내기
          </button>
        </div>
      </div>

      {loadError && <div className="error-banner">일부 분석 데이터를 불러오지 못했습니다: {loadError}</div>}

      <section className="panel analysis-summary">
        <p>{summary}</p>
        <div className="analysis-summary-meta">
          <span>분석 대상 {total}개 지점</span>
          <span>데이터 상태 양호</span>
        </div>
      </section>

      <div className="kpi-row">
        <KpiCard label="점검 지점" value={`${assessedCount}`} sublabel={`전체 ${total}개 중`} />
        <KpiCard label="현재 조치 필요" value={`${actionCount}`} sublabel={total ? `${((actionCount / total) * 100).toFixed(0)}%` : '-'} />
        <KpiCard label="막힘 지점" value={`${blockedCount}`} sublabel="현재 BLOCKED 판정" />
        <KpiCard label="차폐율 중앙값" value={occMedian != null ? `${occMedian.toFixed(1)}%` : '-'} sublabel="측정된 지점 기준" />
        <KpiCard label="판정 불가율" value={total ? `${((unassessableCount / total) * 100).toFixed(1)}%` : '-'} sublabel={`${unassessableCount}곳`} />
      </div>

      <div className="analysis-row analysis-row-6040">
        <section className="panel">
          <div className="panel-head">
            <h3>기간별 상태 변화</h3>
            <span className="panel-actions">
              <SegmentedTabs options={['차폐율', '상태 건수', '점검 범위']} value={chartMode} onChange={setChartMode} label="차트 종류" />
            </span>
          </div>
          <TrendChart points={trendPack} mode={chartMode} compareOn={compareOn} threshold={alert.occlusion_threshold ?? 70} />
          <p className="panel-note">예시 추이입니다 — 일자별 실측 이력 집계 기능이 추가되면 실데이터로 교체됩니다.</p>
        </section>
        <section className="panel">
          <div className="panel-head"><h3>현재 상태 구성</h3></div>
          <div className="rank-bar-list">
            {breakdown.map((b) => (
              <RankBar
                key={b.key}
                label={b.label}
                meta={`${b.count}곳`}
                value={b.pct}
                valueLabel={`${Math.round(b.pct * 100)}%`}
                color={statusColor(b.key)}
                onClick={() => setStatusFilter(statusFilter === b.label ? '전체' : b.label)}
              />
            ))}
          </div>
          <p className="panel-note">항목을 클릭하면 아래 취약 지점 목록이 해당 상태로 필터링됩니다.</p>
        </section>
      </div>

      <div className="analysis-row analysis-row-4555">
        <section className="panel">
          <div className="panel-head">
            <h3>우선순위 상승 원인</h3>
            <span className="panel-actions">
              <SegmentedTabs options={['전체 지점', '조치 필요 지점만', 'TOP 20 지점']} value={contribScope} onChange={setContribScope} label="분석 범위" />
            </span>
          </div>
          <div className="rank-bar-list">
            {contribution.map((c) => (
              <RankBar key={c.key} label={c.label} value={c.pct} valueLabel={`${Math.round(c.pct * 100)}%`} color={c.color} />
            ))}
          </div>
          <p className="panel-note">현재 {modeLabel} 모드 가중치를 적용한 결과입니다.</p>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>노선·차량별 비교</h3>
            <span className="panel-actions">
              <SegmentedTabs options={['노선별', '차량별']} value={segmentTab} onChange={setSegmentTab} label="비교 범위" />
            </span>
          </div>
          <div className="rank-bar-list">
            {segmentTab === '노선별'
              ? routeRows.map((r, i) => (
                <RankBar
                  key={r.route}
                  rank={i + 1}
                  label={`노선 ${r.route}`}
                  meta={`점검 ${r.inspected}곳 · 조치 ${r.needsAction}곳 · 차폐율 중앙값 ${r.medianOcc != null ? `${r.medianOcc.toFixed(1)}%` : '-'}`}
                  value={r.unassessableRate / maxUnassessableRate}
                  valueLabel={`${(r.unassessableRate * 100).toFixed(1)}%`}
                  onClick={() => setRouteFilter(`노선 ${r.route}`)}
                />
              ))
              : vehicleRows.map((v, i) => (
                <RankBar
                  key={v.vehicleId}
                  rank={i + 1}
                  label={v.vehicle}
                  meta={`관측 ${v.observations}건 · 고유 ${v.uniqueDrains}곳 · 최근 판정 ${formatTime(v.lastSeen)} · 결과 미수신 ${v.missing}건`}
                  value={v.unassessableRate / maxUnassessableRate}
                  valueLabel={`판정불가 ${v.unassessable}건`}
                  onClick={() => setVehicleFilter(v.vehicle)}
                />
              ))}
          </div>
        </section>
      </div>

      <div className="analysis-row analysis-row-5050">
        <section className="panel">
          <div className="panel-head"><h3>조치 성과</h3></div>
          <div className="rank-bar-list">
            <RankBar label="조치 완료" value={total ? resolvedCount / total : 0} valueLabel={`${resolvedCount}곳`} color="var(--success)" />
            <RankBar label="조치 필요" value={total ? actionCount / total : 0} valueLabel={`${actionCount}곳`} color="var(--st-occluded)" />
          </div>
          <p className="panel-note">재발률·평균 소요시간·AI 재확인 여부는 조치 이력이 누적되면 추가됩니다.</p>
        </section>
        <section className="panel">
          <div className="panel-head"><h3>AI·수집 데이터 품질</h3></div>
          <div className="quality-stats">
            <StatRow label="판정 불가 건수" value={`${unassessableCount}곳`} />
            <StatRow label="RESULT_MISSING 건수" value={`${totalMissing}건`} />
            {vehicleRows.map((v) => (
              <StatRow key={v.vehicleId} label={`${v.vehicle} 마지막 수신`} value={formatTime(v.lastSeen)} />
            ))}
          </div>
          {worstMissing && worstMissing.count > 0 && (
            <div className="error-banner quality-warning">
              주의 — {worstMissingVehicle?.vehicle_code || '알 수 없는 차량'}에서 RESULT_MISSING {worstMissing.count}건이 발생했습니다.
              {totalMissing > 0 && ` 전체 미수신 건수의 ${Math.round((worstMissing.count / totalMissing) * 100)}%입니다.`}
            </div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h3>취약 지점 TOP 10</h3></div>
        <Top10Table rows={top10} onOpen={onOpenDrain} />
      </section>
    </div>
  )
}
