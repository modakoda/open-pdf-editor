/**
 * Application menu (macOS app menu; File/Edit/View/Page/Document/Window/Help elsewhere).
 * Items that act on the document are sent to the renderer as MenuActions (ids "menu:<action>");
 * cut/copy/paste/select-all use native roles. Rebuilt when the active window, its document
 * state or the recent-files list changes.
 */
import { app, dialog, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { basename, dirname } from 'node:path'
import { IPC, type MenuAction } from '@shared/ipc'
import { openPath } from './open'
import { isDev, PRODUCT_NAME } from './paths'
import { recentFiles } from './recent'
import { checkForUpdatesFromMenu, updater } from './updates'
import { windows } from './windows'

export const PROJECT_URL = 'https://github.com/modakoda/open-pdf-editor'

export function menuId(action: MenuAction): string {
  return `menu:${action}`
}

/** Actions that need an open document (disabled otherwise). */
const DOCUMENT_ACTIONS: ReadonlySet<MenuAction> = new Set<MenuAction>([
  'save',
  'save-as',
  'insert-pages',
  'extract-pages',
  'split',
  'print',
  'undo',
  'redo',
  'delete-selection',
  'select-all-pages',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'fit-width',
  'fit-page',
  'toggle-sidebar',
  'rotate-cw',
  'rotate-ccw',
  'insert-blank-page',
  'delete-pages',
  'document-properties',
  'watermark',
  'page-numbers',
  'security',
  'recognize-text',
  'sign',
  'find'
])

export async function showAbout(win?: BrowserWindow): Promise<void> {
  if (process.platform === 'darwin') {
    app.showAboutPanel()
    return
  }
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    buttons: ['OK'],
    noLink: true,
    title: `About ${PRODUCT_NAME}`,
    message: `${PRODUCT_NAME} ${app.getVersion()}`,
    detail:
      'A free, open-source PDF editor for Windows, macOS and Linux.\n\n' +
      `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\n` +
      `Node.js ${process.versions.node}\n\nReleased under the MIT License.`
  }
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, options)
  else await dialog.showMessageBox(options)
}

/** Routes a menu command to the right window (creating one when needed). */
export function dispatchMenuAction(action: MenuAction, win?: BrowserWindow | null): void {
  const ctx = windows.get(win ?? undefined) ?? windows.active()
  switch (action) {
    case 'about':
      void showAbout(ctx?.win)
      return
    case 'new': {
      // One document per window: a window that already shows a document gets a sibling.
      const target = ctx && !windows.isOccupied(ctx) ? ctx : windows.create()
      // The window is about to show the new document: OS opens meanwhile go elsewhere.
      windows.markPendingOpen(target)
      windows.send(target, IPC.menuAction, action)
      windows.focus(target)
      return
    }
    case 'open': {
      const target = ctx ?? windows.create()
      windows.send(target, IPC.menuAction, action)
      return
    }
    case 'close-document':
      if (!ctx) return
      if (ctx.state.hasDocument) windows.send(ctx, IPC.menuAction, action)
      else ctx.win.close()
      return
    default:
      if (ctx) windows.send(ctx, IPC.menuAction, action)
  }
}

function escapeLabel(label: string): string {
  // "&" marks mnemonics on Windows/Linux.
  return process.platform === 'darwin' ? label : label.replace(/&/g, '&&')
}

function recentSubmenu(): MenuItemConstructorOptions[] {
  const files = recentFiles.list()
  const names = files.map((p) => basename(p))
  const items: MenuItemConstructorOptions[] = files.map((path, i) => {
    const duplicate = names.filter((n) => n === names[i]).length > 1
    const label = duplicate ? `${names[i]} — ${basename(dirname(path))}` : names[i]
    return {
      label: escapeLabel(label),
      toolTip: path,
      click: () => void openPath(path)
    }
  })
  if (items.length === 0) items.push({ label: 'No Recent Files', enabled: false })
  items.push(
    { type: 'separator' },
    { id: 'menu:clear-recent', label: 'Clear Menu', enabled: files.length > 0, click: () => recentFiles.clear() }
  )
  return items
}

export function buildMenuTemplate(): MenuItemConstructorOptions[] {
  const mac = process.platform === 'darwin'
  const win32 = process.platform === 'win32'
  const active = windows.active()
  const hasDocument = !!active?.state.hasDocument

  const item = (
    action: MenuAction,
    label: string,
    accelerator?: string,
    extra: Partial<MenuItemConstructorOptions> = {}
  ): MenuItemConstructorOptions => ({
    id: menuId(action),
    label,
    accelerator,
    enabled: !DOCUMENT_ACTIONS.has(action) || hasDocument,
    click: (_item, browserWindow) =>
      dispatchMenuAction(action, (browserWindow as BrowserWindow | undefined) ?? undefined),
    ...extra
  })
  /** Extra accelerator for an action, not shown in the menu. */
  const alias = (action: MenuAction, accelerator: string): MenuItemConstructorOptions => ({
    ...item(action, `${action} (${accelerator})`, accelerator),
    id: `${menuId(action)}:alt:${accelerator}`,
    visible: false,
    acceleratorWorksWhenHidden: true
  })
  const sep: MenuItemConstructorOptions = { type: 'separator' }

  const appMenu: MenuItemConstructorOptions = {
    label: PRODUCT_NAME,
    submenu: [
      { id: menuId('about'), role: 'about', label: `About ${PRODUCT_NAME}` },
      sep,
      { role: 'services' },
      sep,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      { role: 'quit' }
    ]
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: mac ? 'File' : '&File',
    submenu: [
      item('new', 'New', 'CmdOrCtrl+N'),
      item('open', 'Open…', 'CmdOrCtrl+O'),
      { id: 'menu:open-recent', label: 'Open Recent', submenu: recentSubmenu() },
      sep,
      item('close-document', 'Close', 'CmdOrCtrl+W', { enabled: !!active }),
      item('save', 'Save', 'CmdOrCtrl+S'),
      item('save-as', 'Save As…', 'Shift+CmdOrCtrl+S'),
      sep,
      item('print', 'Print…', 'CmdOrCtrl+P'),
      ...(mac ? [] : [sep, { role: 'quit', label: 'E&xit' } as MenuItemConstructorOptions])
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: mac ? 'Edit' : '&Edit',
    submenu: [
      item('undo', 'Undo', 'CmdOrCtrl+Z'),
      item('redo', 'Redo', win32 ? 'Ctrl+Y' : 'Shift+CmdOrCtrl+Z'),
      ...(mac ? [] : [alias('redo', win32 ? 'Ctrl+Shift+Z' : 'Ctrl+Y')]),
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      // The renderer handles the Delete key itself (it must keep working in text fields).
      item('delete-selection', 'Delete', mac ? undefined : 'Delete', mac ? {} : { registerAccelerator: false }),
      { role: 'selectAll' },
      item('select-all-pages', 'Select All Pages', 'Shift+CmdOrCtrl+A'),
      sep,
      item('find', 'Find…', 'CmdOrCtrl+F')
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: mac ? 'View' : '&View',
    submenu: [
      item('toggle-sidebar', 'Toggle Sidebar', mac ? 'Ctrl+Cmd+S' : 'F4'),
      sep,
      item('zoom-in', 'Zoom In', 'CmdOrCtrl+='),
      alias('zoom-in', 'CmdOrCtrl+Plus'),
      alias('zoom-in', 'CmdOrCtrl+numadd'),
      item('zoom-out', 'Zoom Out', 'CmdOrCtrl+-'),
      alias('zoom-out', 'CmdOrCtrl+numsub'),
      item('zoom-reset', 'Actual Size', 'CmdOrCtrl+0'),
      alias('zoom-reset', 'CmdOrCtrl+num0'),
      item('fit-width', 'Fit Width', 'CmdOrCtrl+2'),
      item('fit-page', 'Fit Page', 'CmdOrCtrl+1'),
      sep,
      ...(isDev
        ? ([
            { role: 'reload', accelerator: 'F5' },
            { role: 'forceReload', accelerator: 'Shift+F5' },
            { role: 'toggleDevTools' },
            sep
          ] as MenuItemConstructorOptions[])
        : []),
      { role: 'togglefullscreen' }
    ]
  }

  const pageMenu: MenuItemConstructorOptions = {
    label: mac ? 'Page' : '&Page',
    submenu: [
      item('rotate-cw', 'Rotate Clockwise', 'CmdOrCtrl+R'),
      item('rotate-ccw', 'Rotate Counterclockwise', 'Shift+CmdOrCtrl+R'),
      sep,
      item('insert-blank-page', 'Insert Blank Page', 'Shift+CmdOrCtrl+N'),
      item('insert-pages', 'Insert Pages from File…', 'Shift+CmdOrCtrl+I'),
      sep,
      item('extract-pages', 'Extract Pages…', 'Shift+CmdOrCtrl+E'),
      item('split', 'Split Document…'),
      sep,
      item('delete-pages', 'Delete Pages', 'Shift+CmdOrCtrl+D')
    ]
  }

  const documentMenu: MenuItemConstructorOptions = {
    label: mac ? 'Document' : '&Document',
    submenu: [
      item('document-properties', 'Properties…', 'CmdOrCtrl+D'),
      sep,
      item('watermark', 'Watermark…'),
      item('page-numbers', 'Page Numbers…'),
      sep,
      item('recognize-text', 'Recognize Text…'),
      sep,
      item('security', 'Security…'),
      item('sign', 'Sign Digitally…')
    ]
  }

  const closeWindow: MenuItemConstructorOptions = {
    id: 'menu:close-window',
    label: 'Close Window',
    accelerator: 'Shift+CmdOrCtrl+W',
    enabled: !!active,
    click: (_item, browserWindow) => (windows.get(browserWindow as BrowserWindow | undefined) ?? windows.active())?.win.close()
  }

  const windowMenu: MenuItemConstructorOptions = mac
    ? {
        label: 'Window',
        role: 'window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, sep, closeWindow, sep, { role: 'front' }]
      }
    : { label: '&Window', submenu: [{ role: 'minimize' }, closeWindow] }

  const helpMenu: MenuItemConstructorOptions = {
    label: mac ? 'Help' : '&Help',
    role: 'help',
    submenu: [
      { id: 'menu:website', label: `${PRODUCT_NAME} Website`, click: () => void shell.openExternal(PROJECT_URL) },
      sep,
      ...updateMenuItems(),
      ...(mac ? [] : [sep, item('about', `About ${PRODUCT_NAME}`)])
    ]
  }

  return [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, pageMenu, documentMenu, windowMenu, helpMenu]
}

/** Help menu: check for updates, the automatic-check setting, and restart when one is ready. */
function updateMenuItems(): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { id: 'menu:check-for-updates', label: 'Check for Updates…', click: () => checkForUpdatesFromMenu() },
    {
      id: 'menu:auto-check-updates',
      label: 'Check for Updates Automatically',
      type: 'checkbox',
      checked: updater.autoCheck,
      click: (menuItem) => updater.setAutoCheck(menuItem.checked)
    }
  ]
  if (updater.getState().status === 'ready') {
    items.push({ id: 'menu:install-update', label: 'Restart to Update', click: () => updater.install() })
  }
  return items
}

let scheduled = false

/** Rebuilds the application menu (coalesced to once per tick). */
export function refreshMenu(): void {
  if (scheduled) return
  scheduled = true
  setImmediate(() => {
    scheduled = false
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()))
  })
}

/** Builds the menu synchronously (startup). */
export function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()))
  if (process.platform === 'darwin') {
    app.dock?.setMenu(
      Menu.buildFromTemplate([{ label: 'New Window', click: () => windows.focus(windows.create()) }])
    )
  }
}
