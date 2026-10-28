// Renders build/icon.svg to build/icon.png (1024×1024, transparent) with an offscreen Electron
// window, so no image tooling is needed on any OS. electron-builder derives .icns/.ico from it.
//
//   npx electron build/generate-icon.mjs            (or: npm run icon)
//   npx electron build/generate-icon.mjs in.svg out.png 1024
import { app, BrowserWindow, nativeImage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2).filter((a) => !a.startsWith('-') && resolve(a) !== fileURLToPath(import.meta.url))
const input = resolve(args[0] ?? join(here, 'icon.svg'))
const output = resolve(args[1] ?? join(here, 'icon.png'))
const size = Number(args[2] ?? 1024)

app.disableHardwareAcceleration()
app.dock?.hide()

app.whenReady().then(async () => {
  const svg = readFileSync(input, 'utf8')
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    img{display:block;width:${size}px;height:${size}px}
  </style></head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`

  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })
  let latest = null
  win.webContents.on('paint', (_event, _dirty, image) => {
    latest = image
  })
  win.webContents.setFrameRate(30)
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  await win.webContents.executeJavaScript('document.querySelector("img").decode().then(() => true)')
  win.webContents.invalidate()
  await new Promise((r) => setTimeout(r, 800))

  let image = latest ?? (await win.webContents.capturePage())
  const { width, height } = image.getSize()
  if (width !== size || height !== size) {
    image = nativeImage.createFromBuffer(image.resize({ width: size, height: size, quality: 'best' }).toPNG())
  }
  writeFileSync(output, image.toPNG())
  console.log(`wrote ${output} (${size}×${size}, rendered at ${width}×${height})`)
  app.quit()
})
