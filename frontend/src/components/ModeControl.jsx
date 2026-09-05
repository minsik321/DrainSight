import { useEffect, useRef, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { weatherModeLabel, MODE_RULE_PREVIEW } from '../format'

const MODES = ['NORMAL', 'RAIN', 'HEAVY_RAIN']

// 날씨 모드는 가중치 프로파일과 조치 기준을 동시에 바꾸는 시스템 전역 상태라, 뷰를 옮겨도
// 항상 보이도록 상단바에 둔다. 데모 중 발표자가 세 모드를 즉시 강제할 수 있어야 하므로
// 수동 전환도 같은 컨트롤 안에서 처리한다(별도 패널로 분리하면 화면을 옮겨야 함).
export default function ModeControl({ alert, busy, onSetMode }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDocPointerDown(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!alert) return null

  const mode = alert.mode || 'NORMAL'
  const manual = Boolean(alert.manual_override)

  function pick(next) {
    onSetMode(next)
    setOpen(false)
  }

  return (
    <div className="mode-control" ref={rootRef}>
      <button
        type="button"
        className={`mode-chip mode-${mode.toLowerCase()}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="mode-chip-name">{weatherModeLabel(mode)}</span>
        <span className="mode-chip-rule">
          차폐 {alert.occlusion_threshold ?? 70}% / {alert.staleness_threshold_days ?? 14}일
        </span>
        {manual && <span className="mode-chip-manual">수동</span>}
        <CaretDown size={12} weight="bold" />
      </button>

      {open && (
        <div className="mode-popover" role="dialog" aria-label="날씨 모드 전환">
          <p className="mode-popover-head">
            {manual ? '수동으로 고정된 모드입니다.' : '기상청 단기예보로 자동 판정 중입니다.'}
          </p>

          <div className="mode-options">
            {MODES.map((m) => {
              const rule = MODE_RULE_PREVIEW[m]
              return (
                <button
                  key={m}
                  type="button"
                  className={`mode-option ${manual && mode === m ? 'selected' : ''}`}
                  onClick={() => pick(m)}
                  disabled={busy}
                >
                  {weatherModeLabel(m)}
                  <span className="mode-option-rule">
                    차폐 {rule.occlusion}% / {rule.staleness}일
                  </span>
                </button>
              )
            })}
          </div>

          <p className="mode-popover-note">
            수동으로 고정하면 우선순위 재계산을 눌러도 실제 예보로 되돌아가지 않습니다.
          </p>

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => pick('AUTO')}
            disabled={busy || !manual}
          >
            실제 예보로 되돌리기
          </button>
        </div>
      )}
    </div>
  )
}
