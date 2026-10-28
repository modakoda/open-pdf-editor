/**
 * Electron main process entry: app lifecycle, single-instance handling, files opened from the
 * OS, and wiring of the protocol, IPC, menu and window modules.
 */
import { app } from 'electron'
import { resolve } from 'node:path'
import { pdfPathsFromArgv } from './files'
import { registerIpcHandlers } from './ipc'
import { installMenu, PROJECT_URL, refreshMenu } from './menu'
import { openPath, openPaths } from './open'
import { iconPath, PRODUCT_NAME, rendererRoot } from './paths'
import { handleAppScheme, registerAppScheme } from './protocol'
import { recentFiles } from './recent'
import { hardenSessions, hardenWebContents } from './security'
import { windows } from './windows'

// Isolated profile (used by the e2e tests; also handy for running a second, clean profile).
if (process.env.OPE_USER_DATA) app.setPath('userData', resolve(process.env.OPE_USER_DATA))

// E2E runs start several app instances in parallel/sequence and must not hand off to each other.
const singleInstance = process.env.OPE_E2E !== '1'

if (singleInstance && !app.requestSingleInstanceLock()) {
  // Another instance is running: it receives our argv via 'second-instance'.
  app.quit()
} else {
  start()
}

function start(): void {
  registerAppScheme()
  app.enableSandbox()
  if (process.platform === 'win32') app.setAppUserModelId('com.openpdfeditor.app')
  hardenWebContents()

  let ready = false
  const startupPaths = pdfPathsFromArgv(process.argv, process.cwd())

  // macOS: Finder / Dock / "Open With" (may fire before 'ready').
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (ready) void openPath(path)
    else startupPaths.push(path)
  })

  // Windows/Linux: the user opened a file while the app was already running.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!ready) return
    const paths = pdfPathsFromArgv(argv, workingDirectory)
    if (paths.length > 0) void openPaths(paths)
    else windows.focus(windows.active() ?? windows.create())
  })

  app.on('before-quit', (event) => windows.handleBeforeQuit(event))

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (ready && windows.all().length === 0) windows.create()
  })

  void app.whenReady().then(async () => {
    app.setAboutPanelOptions({
      applicationName: PRODUCT_NAME,
      applicationVersion: app.getVersion(),
      version: `Electron ${process.versions.electron}`,
      copyright: `© ${new Date().getFullYear()} Modestas Kažinauskas. MIT License.`,
      website: PROJECT_URL,
      iconPath
    })
    hardenSessions()
    handleAppScheme(rendererRoot)
    registerIpcHandlers()
    windows.onChange(refreshMenu)
    recentFiles.onChange(refreshMenu)
    installMenu()

    ready = true
    windows.create()
    await openPaths(startupPaths.splice(0))
  })
}
