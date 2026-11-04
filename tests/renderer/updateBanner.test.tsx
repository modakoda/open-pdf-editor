/** Update banner (src/renderer/src/components/update/UpdateBanner.tsx). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UpdateState, UpdateStatus } from '@shared/ipc'

const updates = vi.hoisted(() => {
  const listeners = new Set<(state: unknown) => void>()
  return {
    listeners,
    current: null as unknown,
    getUpdateState: vi.fn(async () => updates.current),
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    openUpdateDownload: vi.fn(),
    onUpdateState: vi.fn((cb: (state: unknown) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    })
  }
})

vi.mock('@renderer/platform', () => ({
  platform: {
    getUpdateState: updates.getUpdateState,
    checkForUpdates: updates.checkForUpdates,
    installUpdate: updates.installUpdate,
    openUpdateDownload: updates.openUpdateDownload,
    onUpdateState: updates.onUpdateState
  },
  isDesktop: true
}))

import { isUpdateBannerVisible, UpdateBanner } from '@renderer/components/update/UpdateBanner'

let nextId = 1
const make = (status: UpdateStatus, manual = false, id = nextId++): UpdateState => ({ ...status, id, manual })

function emit(state: UpdateState): void {
  act(() => {
    for (const l of updates.listeners) l(state)
  })
}

const banner = () => screen.queryByTestId('update-banner')

beforeEach(() => {
  updates.current = make({ status: 'idle' })
  updates.listeners.clear()
  for (const fn of [updates.getUpdateState, updates.checkForUpdates, updates.installUpdate, updates.openUpdateDownload, updates.onUpdateState]) {
    fn.mockClear()
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('update banner', () => {
  it('shows nothing while idle, and the current state once loaded', async () => {
    render(<UpdateBanner />)
    await act(async () => undefined)
    expect(banner()).toBeNull()
    cleanup()

    updates.current = make({ status: 'ready', version: '2.0.0' })
    render(<UpdateBanner />)
    expect(await screen.findByTestId('update-banner')).toHaveAttribute('data-status', 'ready')
  })

  it('shows download progress, then "Restart to Update"', async () => {
    const user = userEvent.setup()
    render(<UpdateBanner />)
    const id = nextId++
    emit(make({ status: 'downloading', version: '2.0.0', percent: 42.4 }, false, id))
    expect(banner()).toHaveAttribute('data-status', 'downloading')
    expect(banner()).toHaveTextContent('Downloading version 2.0.0… 42%')
    expect(screen.getByTestId('update-progress')).toHaveAttribute('aria-valuenow', '42')

    emit(make({ status: 'downloading', version: '2.0.0', percent: 90 }, false, id))
    expect(screen.getByTestId('update-progress')).toHaveAttribute('aria-valuenow', '90')

    emit(make({ status: 'ready', version: '2.0.0' }))
    expect(banner()).toHaveTextContent('Version 2.0.0 is ready')
    await user.click(screen.getByTestId('update-restart'))
    expect(updates.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('links builds that cannot update themselves to the download', async () => {
    const user = userEvent.setup()
    render(<UpdateBanner />)
    emit(make({ status: 'available', version: '2.0.0', downloadUrl: 'https://example.com/v2.0.0' }))
    expect(banner()).toHaveTextContent('A new version (2.0.0) is available — download it')
    await user.click(screen.getByTestId('update-download'))
    expect(updates.openUpdateDownload).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('update-restart')).toBeNull()
  })

  it('shows checking, "up to date" and errors only for checks the user asked for', () => {
    render(<UpdateBanner />)
    emit(make({ status: 'checking' }, false))
    expect(banner()).toBeNull()
    emit(make({ status: 'error', message: 'Could not check for updates: offline' }, false))
    expect(banner()).toBeNull()
    emit(make({ status: 'up-to-date', currentVersion: '1.0.0' }, false))
    expect(banner()).toBeNull()

    emit(make({ status: 'checking' }, true))
    expect(banner()).toHaveTextContent('Checking for updates…')
    emit(make({ status: 'error', message: 'Could not check for updates: offline' }, true))
    expect(banner()).toHaveAttribute('role', 'alert')
    expect(banner()).toHaveTextContent('Could not check for updates: offline')
  })

  it('hides "up to date" after a few seconds', () => {
    vi.useFakeTimers()
    render(<UpdateBanner />)
    emit(make({ status: 'up-to-date', currentVersion: '1.0.0' }, true))
    expect(banner()).toHaveTextContent('You’re up to date (version 1.0.0).')
    act(() => vi.advanceTimersByTime(5000))
    expect(banner()).toBeNull()
  })

  it('stays dismissed during the same download, and comes back for something new', async () => {
    const user = userEvent.setup()
    render(<UpdateBanner />)
    const id = nextId++
    emit(make({ status: 'downloading', version: '2.0.0', percent: 10 }, false, id))
    await user.click(screen.getByTestId('update-dismiss'))
    expect(banner()).toBeNull()
    emit(make({ status: 'downloading', version: '2.0.0', percent: 50 }, false, id))
    expect(banner()).toBeNull()
    emit(make({ status: 'ready', version: '2.0.0' }))
    expect(banner()).toHaveAttribute('data-status', 'ready')
  })

  it('prefers an event over an older initial state', async () => {
    let resolve!: (s: UpdateState) => void
    updates.getUpdateState.mockImplementationOnce(() => new Promise<UpdateState>((r) => (resolve = r)) as Promise<never>)
    render(<UpdateBanner />)
    emit(make({ status: 'ready', version: '2.0.0' }))
    await act(async () => resolve(make({ status: 'idle' })))
    expect(banner()).toHaveAttribute('data-status', 'ready')
  })

  it('visibility rules', () => {
    expect(isUpdateBannerVisible(make({ status: 'idle' }, true))).toBe(false)
    expect(isUpdateBannerVisible(make({ status: 'downloading', version: '2', percent: 0 }))).toBe(true)
    expect(isUpdateBannerVisible(make({ status: 'error', message: 'x' }))).toBe(false)
  })
})
