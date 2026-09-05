import { useEffect, useMemo, useRef, useState } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { statusLabel } from '../format'

const MAX_RESULTS = 6

function searchableText(drain) {
  return [
    drain.id,
    drain.name,
    drain.external_code,
    drain.last_status,
    statusLabel(drain.last_status),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export default function TopbarSearch({ drains = [], onSelect }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return drains
      .filter((drain) => searchableText(drain).includes(needle))
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
      .slice(0, MAX_RESULTS)
  }, [drains, query])

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

  function choose(drain) {
    onSelect(drain.id)
    setQuery(drain.name)
    setOpen(false)
  }

  function submit(e) {
    e.preventDefault()
    if (results[0]) choose(results[0])
  }

  return (
    <form className="topbar-search" ref={rootRef} onSubmit={submit} role="search">
      <MagnifyingGlass className="topbar-search-icon" size={16} weight="bold" />
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder="배수구 검색"
        aria-label="배수구 검색"
      />
      {query && (
        <button
          type="button"
          className="topbar-search-clear"
          onClick={() => {
            setQuery('')
            setOpen(false)
          }}
          aria-label="검색어 지우기"
        >
          <X size={13} weight="bold" />
        </button>
      )}

      {open && query.trim() && (
        <div className="topbar-search-popover">
          {results.length > 0 ? (
            results.map((drain) => (
              <button
                key={drain.id}
                type="button"
                className="topbar-search-result"
                onClick={() => choose(drain)}
              >
                <span className="topbar-search-result-main">
                  <span>{drain.name}</span>
                  <span>{drain.external_code || `ID ${drain.id}`}</span>
                </span>
                <span className="topbar-search-result-meta">
                  {statusLabel(drain.last_status)}
                </span>
              </button>
            ))
          ) : (
            <div className="topbar-search-empty">검색 결과가 없습니다.</div>
          )}
        </div>
      )}
    </form>
  )
}
