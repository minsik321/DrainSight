import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  ChatCircleDots,
  EnvelopeSimple,
  FacebookLogo,
  LinkSimple,
  LinkedinLogo,
  X,
  XLogo,
} from '@phosphor-icons/react'

function ModalSurface({ children, labelledBy, onClose, className = '' }) {
  const overlayRef = useRef(null)
  const closeButtonRef = useRef(null)

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
      className="qr-modal-overlay"
      ref={overlayRef}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className={`qr-modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children(closeButtonRef)}
      </section>
    </div>,
    document.body,
  )
}

export function QrPreviewModal({ imageSrc, route, onClose }) {
  return (
    <ModalSurface labelledBy="qr-preview-modal-title" onClose={onClose} className="qr-preview-modal">
      {(closeButtonRef) => (
        <>
          <header className="qr-modal-header">
            <div>
              <h2 id="qr-preview-modal-title">{route.name} QR 코드</h2>
              <p>현장에서 스캔할 수 있도록 크게 표시했습니다.</p>
            </div>
            <button
              type="button"
              className="qr-modal-close"
              ref={closeButtonRef}
              onClick={onClose}
              aria-label="QR 코드 크게 보기 닫기"
            >
              <X size={20} weight="bold" />
            </button>
          </header>
          <div className="qr-preview-modal-body">
            <img src={imageSrc} alt={`${route.name} 확대 QR 코드`} />
            <strong>{route.name}</strong>
            <span>{route.team} · 빗물받이 {route.stops.length}곳</span>
          </div>
        </>
      )}
    </ModalSurface>
  )
}

async function copyShareLink(url) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url)
    return
  }

  const input = document.createElement('textarea')
  input.value = url
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  input.remove()
}

export function QrShareModal({ target, onClose, onToast }) {
  const isBulk = target.type === 'bulk'
  const title = isBulk ? '동선 QR 일괄 공유' : `${target.route.name} QR 공유`
  const text = isBulk
    ? `DrainSight 동선 QR 코드 ${target.count}개`
    : `DrainSight ${target.route.name} QR 코드`
  const url = target.url

  const openShareWindow = (shareUrl) => {
    window.open(shareUrl, '_blank', 'noopener,noreferrer,width=720,height=720')
    onClose()
  }

  const handleKakaoShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url })
        onClose()
        return
      }
      await copyShareLink(url)
      onToast('링크가 복사되었습니다. 카카오톡에 붙여넣어 공유해 주세요.')
      onClose()
    } catch (error) {
      if (error?.name !== 'AbortError') onToast('공유를 완료하지 못했습니다.')
    }
  }

  const handleCopyLink = async () => {
    try {
      await copyShareLink(url)
      onToast('링크가 복사되었습니다.')
      onClose()
    } catch {
      onToast('링크를 복사하지 못했습니다.')
    }
  }

  const encodedUrl = encodeURIComponent(url)
  const encodedText = encodeURIComponent(text)
  const encodedTitle = encodeURIComponent(title)
  const items = [
    {
      id: 'kakao',
      label: '카카오톡',
      icon: ChatCircleDots,
      className: 'is-kakao',
      onClick: handleKakaoShare,
    },
    {
      id: 'facebook',
      label: '페이스북',
      icon: FacebookLogo,
      className: 'is-facebook',
      onClick: () => openShareWindow(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`),
    },
    {
      id: 'x',
      label: 'X',
      icon: XLogo,
      className: 'is-x',
      onClick: () => openShareWindow(`https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`),
    },
    {
      id: 'linkedin',
      label: '링크드인',
      icon: LinkedinLogo,
      className: 'is-linkedin',
      onClick: () => openShareWindow(`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`),
    },
    {
      id: 'mail',
      label: '메일',
      icon: EnvelopeSimple,
      className: 'is-mail',
      onClick: () => {
        window.location.href = `mailto:?subject=${encodedTitle}&body=${encodedText}%0A${encodedUrl}`
        onClose()
      },
    },
    {
      id: 'copy',
      label: '링크 복사',
      icon: LinkSimple,
      className: 'is-copy',
      onClick: handleCopyLink,
    },
  ]

  return (
    <ModalSurface labelledBy="qr-share-modal-title" onClose={onClose} className="qr-share-modal">
      {(closeButtonRef) => (
        <>
          <header className="qr-modal-header">
            <div>
              <h2 id="qr-share-modal-title">{title}</h2>
              <p>공유할 방법을 선택해 주세요.</p>
            </div>
            <button
              type="button"
              className="qr-modal-close"
              ref={closeButtonRef}
              onClick={onClose}
              aria-label="공유 창 닫기"
            >
              <X size={20} weight="bold" />
            </button>
          </header>
          <div className="qr-share-grid">
            {items.map(({ id, label, icon: Icon, className, onClick }) => (
              <button type="button" className={`qr-share-option ${className}`} onClick={onClick} key={id}>
                <span className="qr-share-option-icon" aria-hidden="true">
                  <Icon size={25} weight={id === 'facebook' || id === 'linkedin' ? 'fill' : 'bold'} />
                </span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </ModalSurface>
  )
}
