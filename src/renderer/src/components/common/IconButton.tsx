import { forwardRef, type ButtonHTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { shortcutLabel } from '@renderer/actions/util'
import './common.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon
  /** Accessible name and tooltip. */
  label: string
  /** Shortcut spec like "mod+shift+s" shown in the tooltip. */
  shortcut?: string
  /** Show the label next to the icon. */
  showLabel?: boolean
  /** Visible text when it differs from the accessible label. */
  text?: string
  active?: boolean
  testId?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, shortcut, showLabel, text, active, testId, className, ...rest },
  ref
) {
  const tooltip = shortcut ? `${label} (${shortcutLabel(shortcut)})` : label
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn${showLabel ? ' with-label' : ''}${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      title={tooltip}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-testid={testId}
      {...rest}
    >
      <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
      {showLabel && <span className="icon-btn-label">{text ?? label}</span>}
    </button>
  )
})
