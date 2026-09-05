import { useEffect, useMemo, useState } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'

export function usePagination(items, pageSize, options = {}) {
  const { selectedKey = null, getKey = null, resetKey } = options
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const selectedIndex = selectedKey == null || !getKey
    ? -1
    : items.findIndex((item) => getKey(item) === selectedKey)
  const selectedPage = selectedIndex < 0 ? null : Math.floor(selectedIndex / pageSize) + 1

  useEffect(() => {
    setPage((current) => Math.min(Math.max(current, 1), totalPages))
  }, [totalPages])

  useEffect(() => {
    if (selectedPage != null) setPage(selectedPage)
  }, [selectedKey, selectedPage])

  useEffect(() => {
    setPage(1)
  }, [resetKey])

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return items.slice(start, start + pageSize)
  }, [items, pageSize, safePage])

  return { page: safePage, setPage, totalPages, pageItems }
}

export default function Pagination({ page, totalPages, onPageChange, label = '목록' }) {
  if (totalPages <= 1) return null

  return (
    <nav className="pagination" aria-label={`${label} 페이지 이동`}>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label={`${label} 이전 페이지`}
      >
        <CaretLeft size={13} weight="bold" />
      </button>
      <span className="pagination-status" aria-live="polite">
        <strong>{page}</strong> / {totalPages}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label={`${label} 다음 페이지`}
      >
        <CaretRight size={13} weight="bold" />
      </button>
    </nav>
  )
}
