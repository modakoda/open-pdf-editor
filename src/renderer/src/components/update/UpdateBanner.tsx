/**
 * In-app update banner (data-testid="update-banner", data-status=UpdateState.status): download
 * progress, "Restart to Update" once an update is ready, or a download link for builds that
 * cannot update themselves. Checking, "up to date" and errors show only for checks the user
 * asked for. Dismissing hides the banner until the shell reports something new.
 */
import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Download, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { UpdateState } from '@shared/ipc'
import { platform } from '@renderer/platform'
import './update.css'

const UP_TO_DATE_MS = 5000

/** The shell's update state (null outside the desktop app). */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    let active = true
    let received = false
    const off = platform.onUpdateState?.((next) => {
      received = true
      if (active) setState(next)
    })
    platform.getUpdateState?.().then(
      (current) => {
        // An event that arrived meanwhile is newer.
        if (active && !received) setState(current)
      },
      (err) => console.error('getUpdateState failed', err)
    )
    return () => {
      active = false
      off?.()
    }
  }, [])
  return state
}

export function isUpdateBannerVisible(state: UpdateState): boolean {
  switch (state.status) {
    case 'idle':
      return false
    case 'checking':
    case 'up-to-date':
    case 'error':
      return state.manual
    default:
      return true
  }
}

export function UpdateBanner() {
  const state = useUpdateState()
  const [dismissedId, setDismissedId] = useState<number | null>(null)

  const upToDateId = state?.status === 'up-to-date' ? state.id : null
  useEffect(() => {
    if (upToDateId === null) return
    const t = setTimeout(() => setDismissedId(upToDateId), UP_TO_DATE_MS)
    return () => clearTimeout(t)
  }, [upToDateId])

  if (!state || !isUpdateBannerVisible(state) || state.id === dismissedId) return null

  const dismiss = (
    <button
      type="button"
      className="update-banner-close"
      data-testid="update-dismiss"
      aria-label={state.status === 'ready' ? 'Later' : 'Dismiss'}
      title={state.status === 'ready' ? 'Later (installs when you quit)' : 'Dismiss'}
      onClick={() => setDismissedId(state.id)}
    >
      <X size={14} aria-hidden="true" />
    </button>
  )

  let icon = <RefreshCw size={16} aria-hidden="true" />
  let body: React.ReactNode
  switch (state.status) {
    case 'checking':
      icon = <LoaderCircle size={16} aria-hidden="true" className="update-spin" />
      body = <span>Checking for updates…</span>
      break
    case 'up-to-date':
      icon = <CircleCheck size={16} aria-hidden="true" className="update-ok" />
      body = <span>You’re up to date (version {state.currentVersion}).</span>
      break
    case 'available':
      icon = <Download size={16} aria-hidden="true" />
      body = (
        <span>
          A new version ({state.version}) is available —{' '}
          <button type="button" className="update-link" data-testid="update-download" onClick={() => platform.openUpdateDownload?.()}>
            download it
          </button>
        </span>
      )
      break
    case 'downloading': {
      const percent = Math.round(state.percent)
      icon = <Download size={16} aria-hidden="true" />
      body = (
        <>
          <span>
            Downloading version {state.version}… {percent}%
          </span>
          <div
            className="update-progress"
            data-testid="update-progress"
            role="progressbar"
            aria-label="Update download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="update-progress-bar" style={{ width: `${percent}%` }} />
          </div>
        </>
      )
      break
    }
    case 'ready':
      body = (
        <>
          <span>Version {state.version} is ready. It installs when you quit.</span>
          <div className="update-actions">
            <button type="button" className="btn btn-primary btn-small" data-testid="update-restart" onClick={() => platform.installUpdate?.()}>
              Restart to Update
            </button>
          </div>
        </>
      )
      break
    case 'error':
      icon = <CircleAlert size={16} aria-hidden="true" className="update-error" />
      body = <span>{state.message}</span>
      break
  }

  return (
    <div className="update-banner-host">
      <div
        key={state.id}
        className="update-banner"
        data-testid="update-banner"
        data-status={state.status}
        role={state.status === 'error' ? 'alert' : 'status'}
      >
        <span className="update-banner-icon">{icon}</span>
        <div className="update-banner-body">{body}</div>
        {dismiss}
      </div>
    </div>
  )
}
