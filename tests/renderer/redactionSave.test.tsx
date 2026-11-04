import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)

import { addRedactions, makeRedaction, type EditorDocument } from '@core'
import { save, saveAs } from '@renderer/actions/fileActions'
import { DialogHost } from '@renderer/dialogs/DialogHost'
import { coreOverrides as core, makeDoc, resetFakeCore } from './support/fakeCore'
import { fake, resetFakePlatform } from './support/fakePlatform'
import { editor, loadDoc, resetStores } from './support/editor'

function redactedDoc(pages = 2): EditorDocument {
  const doc = makeDoc(pages)
  return addRedactions(doc, [
    makeRedaction('p1', { x: 10, y: 10, width: 50, height: 20 }),
    makeRedaction('p2', { x: 10, y: 40, width: 50, height: 20 })
  ])
}

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
})
afterEach(() => cleanup())

describe('saving with redaction areas', () => {
  it('asks to apply them; cancelling does not save', async () => {
    render(<DialogHost />)
    loadDoc(redactedDoc(), { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    editor().apply((d) => ({ ...d }))
    const saving = save()
    const dialog = await screen.findByTestId('dialog')
    expect(dialog).toHaveAttribute('data-dialog', 'redact')
    expect(dialog).toHaveTextContent('2 marked areas on 2 pages')
    await userEvent.click(screen.getByTestId('dialog-cancel'))
    expect(await saving).toBe(false)
    expect(core.exportDocument).not.toHaveBeenCalled()
    expect(fake.writeFile).not.toHaveBeenCalled()
    expect(editor().dirty).toBe(true)
  })

  it('applies them (optionally sanitizing), writes the file and opens the saved file', async () => {
    render(<DialogHost />)
    const doc = redactedDoc()
    loadDoc(doc, { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    const saving = save()
    await userEvent.click(await screen.findByTestId('redact-sanitize'))
    await userEvent.click(screen.getByTestId('dialog-confirm'))
    expect(await saving).toBe(true)
    expect(core.exportDocument).toHaveBeenCalledWith(doc, expect.objectContaining({ sanitize: true }))
    expect(fake.writeFile).toHaveBeenCalledWith('/docs/a.pdf', new Uint8Array([1, 2, 3]))
    // The redacted file replaces the document (undo history starts over).
    expect(core.openDocument).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'a.pdf', undefined)
    expect(editor().doc).not.toBe(doc)
    expect(editor().doc?.redactions).toBeUndefined()
    expect(editor().filePath).toBe('/docs/a.pdf')
    expect(editor().dirty).toBe(false)
    expect(editor().past).toHaveLength(0)
    expect(editor().notice?.text).toMatch(/Saved a\.pdf/)
  })

  it('reopens encrypted output with its password and asks again for Save As', async () => {
    render(<DialogHost />)
    const doc = redactedDoc()
    loadDoc({ ...doc, settings: { ...doc.settings, encryption: { userPassword: 'pw' } } }, { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    const saving = saveAs()
    await userEvent.click(await screen.findByTestId('dialog-confirm'))
    expect(await saving).toBe(true)
    expect(core.exportDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sanitize: false }))
    expect(core.openDocument).toHaveBeenCalledWith(expect.any(Uint8Array), 'a.pdf', { password: 'pw' })
  })

  it('keeps the document when the saved file cannot be opened again', async () => {
    render(<DialogHost />)
    const doc = redactedDoc()
    loadDoc(doc, { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    core.openDocument.mockRejectedValueOnce(new Error('nope'))
    const saving = save()
    await userEvent.click(await screen.findByTestId('dialog-confirm'))
    expect(await saving).toBe(true)
    expect(editor().doc).toBe(doc)
    expect(editor().dirty).toBe(false)
  })

  it('saves without asking when nothing is marked (or only on deleted pages)', async () => {
    render(<DialogHost />)
    const doc = redactedDoc(3)
    loadDoc({ ...doc, pages: doc.pages.slice(2) }, { filePath: '/docs/a.pdf', fileName: 'a.pdf' })
    expect(await save()).toBe(true)
    expect(screen.queryByTestId('dialog')).toBeNull()
    expect(core.openDocument).not.toHaveBeenCalled()
  })
})
