/**
 * Popup menu used for context menus and dropdowns. Positioned in viewport coordinates, kept on
 * screen, closes on outside click, Escape, blur or scroll; arrow keys move between items.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import './common.css'

export interface MenuItem {
  id: string
  label: string
  icon?: LucideIcon
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'separator'

export interface MenuProps {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
  label?: string
  testId?: string
  /** Optional element the menu belongs to; clicks on it don't count as "outside". */
  anchor?: HTMLElement | null
  footer?: ReactNode
}

export function Menu({ x, y, items, onClose, label, testId, anchor, footer }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 6
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))
    const top = y + rect.height > window.innerHeight - margin ? Math.max(margin, y - rect.height) : y
    setPos({ left, top })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    const onBlur = () => onClose()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [onClose, anchor])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!buttons.length) return
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next = 0
    if (e.key === 'ArrowDown') next = (i + 1) % buttons.length
    else if (e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length
    else if (e.key === 'End') next = buttons.length - 1
    buttons[next].focus()
  }

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      data-testid={testId}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`sep-${i}`} className="menu-separator" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            className={`menu-item${item.danger ? ' danger' : ''}${item.checked ? ' checked' : ''}`}
            disabled={item.disabled}
            data-testid={`menu-${item.id}`}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            <span className="menu-item-icon">{item.icon && <item.icon size={15} aria-hidden="true" />}</span>
            <span className="menu-item-label">{item.label}</span>
            {item.shortcut && <span className="menu-item-shortcut">{item.shortcut}</span>}
          </button>
        )
      )}
      {footer}
    </div>,
    document.body
  )
}
