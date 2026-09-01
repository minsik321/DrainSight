// 리터럴 hex 대신 App.css의 --st-* 커스텀 프로퍼티를 참조한다 — 값 자체는
// 다크/라이트 테마별로 :root에서 따로 정의되어 있어(WCAG AA 4.5:1 기준을 각각
// 맞춤), 이 함수는 테마를 몰라도 항상 현재 테마에 맞는 색을 돌려준다. 상태 칩이
// solid fill이 아니라 tint + 테두리 + 상태색 글자 조합이라 이 대비가 전제 조건이다.
export const STATUS_COLORS = {
  CLEAR: 'var(--st-clear)',
  BLOCKED: 'var(--st-blocked)',
  OCCLUDED: 'var(--st-occluded)',
  UNASSESSABLE: 'var(--st-unassessable)',
}
export const NEUTRAL_COLOR = 'var(--st-neutral)'

export function statusColor(status) {
  return STATUS_COLORS[status] || NEUTRAL_COLOR
}

export function statusLabel(status) {
  if (status === 'UNASSESSABLE') return '판정 불가'
  if (status === 'CLEAR') return '정상'
  if (status === 'BLOCKED') return '막힘'
  if (status === 'OCCLUDED') return '부분 차폐'
  return status || '미점검'
}

// 카드/인스펙터에서 "왜 판정 불가인지"를 한 줄 더 붙일 때만 쓴다.
export function statusDetail(status) {
  if (status === 'UNASSESSABLE') return '대상 인식 실패'
  return null
}

export function reasonLabel(reasonCode) {
  if (reasonCode === 'DRAIN_NOT_DETECTED') return '빗물받이 대상 인식 실패'
  return reasonCode || null
}

export const WEATHER_MODE_LABELS = {
  NORMAL: '평소',
  RAIN: '비 예보',
  HEAVY_RAIN: '폭우 예보',
}

// 백엔드 forecast.OCCLUSION_ACTION_THRESHOLD / STALENESS_THRESHOLD_DAYS와 같은 값.
// 모드를 고르기 *전에* 기준을 미리 보여주려는 용도라 여기 둔다 — 실제 적용 값은
// 항상 /api/weather/alert 응답(weatherAlert)을 쓰고 이 표는 미리보기 전용이다.
export const MODE_RULE_PREVIEW = {
  NORMAL: { occlusion: 70, staleness: 14 },
  RAIN: { occlusion: 50, staleness: 7 },
  HEAVY_RAIN: { occlusion: 40, staleness: 1 },
}

export function weatherModeLabel(mode) {
  return WEATHER_MODE_LABELS[mode] || mode || '평소'
}

// backend serializes naive UTC datetimes without a timezone suffix;
// without forcing "Z" the browser would parse them as local time and skew the display.
export function formatTime(iso) {
  if (!iso) return '-'
  const hasTz = /Z$|[+-]\d\d:\d\d$/.test(iso)
  const date = new Date(hasTz ? iso : `${iso}Z`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('ko-KR', { hour12: false })
}

export function formatDuration(seconds) {
  if (seconds == null) return '-'
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}분`
  if (minutes === 0) return `${hours}시간`
  return `${hours}시간 ${minutes}분`
}

// 백엔드 priority_score는 refresh 시점 기준 캐시값이라, 화면의 "며칠째 미점검"은
// last_updated로부터 매 렌더마다 직접 계산 — 백엔드 재조회 없이도 항상 최신으로 보인다.
export function daysSince(iso) {
  if (!iso) return null
  const hasTz = /Z$|[+-]\d\d:\d\d$/.test(iso)
  const date = new Date(hasTz ? iso : `${iso}Z`)
  if (Number.isNaN(date.getTime())) return null
  return (Date.now() - date.getTime()) / 86400000
}
