/**
 * Print: export the document (so edits, watermark and page numbers are included), render each
 * page to an image at ~150 dpi into a hidden print container, then call window.print().
 * styles/print.css shows only that container when printing.
 */
import { exportDocument } from '@core'
import { openPdfBytes, pdfjs } from '@renderer/pdf/pdfjs'
import { editor, notifyError } from './util'

const PRINT_DPI = 150
let printing = false

function printRoot(): HTMLElement {
  let root = document.getElementById('print-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'print-root'
    root.setAttribute('aria-hidden', 'true')
    document.body.appendChild(root)
  }
  return root
}

function canvasToBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('Rendering failed'))), 'image/png')
  })
}

export async function printDocument(): Promise<void> {
  const { doc } = editor()
  if (!doc || printing) return
  if (doc.pages.length === 0) {
    editor().showNotice('info', 'The document has no pages to print.')
    return
  }
  printing = true
  editor().setBusy('Preparing to print…')
  const urls: string[] = []
  const root = printRoot()
  let task: ReturnType<typeof openPdfBytes> | null = null
  try {
    const bytes = await exportDocument(doc)
    task = openPdfBytes(bytes, doc.settings.encryption?.userPassword)
    const pdf = await task.promise
    root.replaceChildren()
    for (let i = 1; i <= pdf.numPages; i++) {
      editor().setBusy(`Preparing to print… (${i}/${pdf.numPages})`)
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: PRINT_DPI / 72 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      await page.render({ canvas, viewport, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
      const url = await canvasToBlobUrl(canvas)
      canvas.width = canvas.height = 0
      urls.push(url)
      const sheet = document.createElement('div')
      sheet.className = 'print-page'
      const img = document.createElement('img')
      img.src = url
      img.alt = ''
      sheet.appendChild(img)
      root.appendChild(sheet)
    }
    await Promise.all(Array.from(root.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)))
    editor().setBusy(null)
    await new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener('afterprint', done)
        resolve()
      }
      window.addEventListener('afterprint', done)
      window.print()
      // Some platforms do not fire afterprint (or print() returns immediately).
      setTimeout(done, 1000)
    })
  } catch (err) {
    notifyError('Could not print', err)
  } finally {
    printing = false
    editor().setBusy(null)
    // Keep images until the print job has captured them.
    setTimeout(() => {
      root.replaceChildren()
      urls.forEach((u) => URL.revokeObjectURL(u))
    }, 2000)
    task?.destroy().catch(() => undefined)
  }
}
