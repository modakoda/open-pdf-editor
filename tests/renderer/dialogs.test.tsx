import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)

import { PRODUCER } from '@core'
import { DialogHost } from '@renderer/dialogs/DialogHost'
import { computeSplitGroups, splitFileNames } from '@renderer/dialogs/SplitDialog'
import { parseRangesSafe } from '@renderer/dialogs/ExtractDialog'
import { insertionIndex } from '@renderer/dialogs/InsertPagesDialog'
import { validateWatermark, DEFAULT_WATERMARK } from '@renderer/dialogs/WatermarkDialog'
import { validateSecurity } from '@renderer/dialogs/SecurityDialog'
import { openDialog, type DialogRequest } from '@renderer/state/dialogs'
import { coreOverrides as core, makeDoc, makeSource, resetFakeCore } from './support/fakeCore'
import { fake, resetFakePlatform } from './support/fakePlatform'
import { editor, loadDoc, resetStores } from './support/editor'

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
  loadDoc(makeDoc(5), { filePath: '/docs/report.pdf', fileName: 'report.pdf' })
})
afterEach(() => cleanup())

function show(request: DialogRequest) {
  render(<DialogHost />)
  let result!: Promise<unknown>
  act(() => {
    result = openDialog(request)
  })
  return { result, dialog: () => screen.getByTestId('dialog') }
}

describe('range helpers', () => {
  it('parses ranges and reports errors', () => {
    expect(parseRangesSafe('1-3, 5', 5)).toEqual({ indices: [0, 1, 2, 4] })
    expect(parseRangesSafe('', 5)).toHaveProperty('error')
    expect(parseRangesSafe('7', 5)).toHaveProperty('error')
    expect(parseRangesSafe('abc', 5)).toHaveProperty('error')
  })

  it('computes split groups', () => {
    expect(computeSplitGroups('every', 5, 2, '')).toEqual({ groups: [[0, 1], [2, 3], [4]] })
    expect(computeSplitGroups('every', 5, 0, '')).toHaveProperty('error')
    expect(computeSplitGroups('every', 5, 5, '')).toHaveProperty('error')
    expect(computeSplitGroups('ranges', 5, 1, '1-2; 3-\n')).toEqual({ groups: [[0, 1], [2, 3, 4]] })
    expect(computeSplitGroups('ranges', 5, 1, '1-2; 9')).toHaveProperty('error')
    expect(splitFileNames('report', 2)).toEqual(['report-part1.pdf', 'report-part2.pdf'])
  })

  it('computes insertion indices', () => {
    expect(insertionIndex('before', 1, 5)).toBe(0)
    expect(insertionIndex('after', 5, 5)).toBe(5)
    expect(insertionIndex('after', 2, 5)).toBe(2)
    expect(insertionIndex('after', 1, 0)).toBe(0)
  })

  it('validates watermark and security settings', () => {
    expect(validateWatermark(DEFAULT_WATERMARK)).toBeNull()
    expect(validateWatermark({ ...DEFAULT_WATERMARK, text: '  ' })).not.toBeNull()
    expect(validateWatermark({ ...DEFAULT_WATERMARK, fontSize: Number.NaN })).not.toBeNull()
    expect(validateSecurity({ enabled: false, password: '', confirm: '', ownerPassword: '' })).toBeNull()
    expect(validateSecurity({ enabled: true, password: '', confirm: '', ownerPassword: '' })).not.toBeNull()
    expect(validateSecurity({ enabled: true, password: 'a', confirm: 'b', ownerPassword: '' })).toMatch(/match/)
    expect(validateSecurity({ enabled: true, password: 'a', confirm: 'a', ownerPassword: '' })).toBeNull()
  })
})

describe('extract dialog', () => {
  it('validates the range and exports the chosen pages', async () => {
    const user = userEvent.setup()
    const { result, dialog } = show({ kind: 'extract', initialRange: '2' })
    expect(dialog()).toHaveAttribute('data-dialog', 'extract')
    const input = screen.getByTestId('range-input')
    expect(input).toHaveValue('2')

    await user.clear(input)
    await user.type(input, '4-9')
    expect(screen.getByTestId('field-error')).toBeInTheDocument()
    expect(screen.getByTestId('dialog-confirm')).toBeDisabled()

    await user.clear(input)
    await user.type(input, '2-3, 5')
    expect(screen.queryByTestId('field-error')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('dialog-confirm'))
    expect(await result).toBe(true)
    expect(core.exportDocument).toHaveBeenCalledWith(editor().doc, expect.objectContaining({ pageIds: ['p2', 'p3', 'p5'] }))
    expect(fake.saveFileDialog).toHaveBeenCalledWith({ defaultPath: 'report-pages-2-3_5.pdf', bytes: expect.any(Uint8Array) })
    expect(editor().doc?.pages).toHaveLength(5)
  })

  it('optionally deletes the extracted pages', async () => {
    const user = userEvent.setup()
    const { result } = show({ kind: 'extract', initialRange: '1-2' })
    await user.click(screen.getByTestId('extract-remove'))
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(editor().doc?.pages.map((p) => p.id)).toEqual(['p3', 'p4', 'p5'])
  })
})

describe('split dialog', () => {
  it('splits every N pages into name-partN.pdf files', async () => {
    const user = userEvent.setup()
    const { result } = show({ kind: 'split' })
    const every = screen.getByTestId('split-every')
    await user.clear(every)
    await user.type(every, '2')
    expect(screen.getByTestId('split-preview')).toHaveTextContent('report-part3.pdf')
    await user.click(screen.getByTestId('dialog-confirm'))
    expect(await result).toBe(true)
    expect(core.splitDocument).toHaveBeenCalledWith(editor().doc, [['p1', 'p2'], ['p3', 'p4'], ['p5']])
    expect(fake.saveFilesToFolder).toHaveBeenCalledWith([
      { name: 'report-part1.pdf', bytes: expect.any(Uint8Array) },
      { name: 'report-part2.pdf', bytes: expect.any(Uint8Array) },
      { name: 'report-part3.pdf', bytes: expect.any(Uint8Array) }
    ])
  })

  it('splits by ranges and rejects invalid ones', async () => {
    const user = userEvent.setup()
    const { result } = show({ kind: 'split' })
    await user.click(screen.getByTestId('split-mode-ranges'))
    const ranges = screen.getByTestId('range-input')
    await user.type(ranges, '1-2; 8')
    expect(screen.getByTestId('dialog-confirm')).toBeDisabled()
    await user.clear(ranges)
    await user.type(ranges, '1{Enter}2-5')
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.splitDocument).toHaveBeenCalledWith(editor().doc, [['p1'], ['p2', 'p3', 'p4', 'p5']])
  })
})

describe('document settings dialogs', () => {
  it('applies watermark settings (undoable) and removes them', async () => {
    const user = userEvent.setup()
    const { result } = show({ kind: 'watermark' })
    const text = screen.getByTestId('watermark-text')
    await user.clear(text)
    await user.type(text, 'DRAFT')
    const size = screen.getByTestId('watermark-size')
    await user.clear(size)
    await user.type(size, '48')
    fireEvent.change(screen.getByTestId('watermark-opacity'), { target: { value: '50' } })
    fireEvent.change(screen.getByTestId('watermark-angle'), { target: { value: '30' } })
    fireEvent.input(screen.getByTestId('watermark-color'), { target: { value: '#ff0000' } })
    await user.click(screen.getByTestId('dialog-confirm'))
    expect(await result).toBe(true)
    expect(core.updateSettings).toHaveBeenLastCalledWith(expect.anything(), {
      watermark: { text: 'DRAFT', fontSize: 48, color: '#ff0000', opacity: 0.5, angle: 30 }
    })
    expect(editor().doc?.settings.watermark?.text).toBe('DRAFT')
    editor().undo()
    expect(editor().doc?.settings.watermark).toBeNull()
    editor().redo()

    cleanup()
    const again = show({ kind: 'watermark' })
    expect(screen.getByTestId('watermark-text')).toHaveValue('DRAFT')
    await user.click(screen.getByTestId('watermark-remove'))
    await again.result
    expect(editor().doc?.settings.watermark).toBeNull()
  })

  it('rejects an empty watermark text', async () => {
    const user = userEvent.setup()
    show({ kind: 'watermark' })
    await user.clear(screen.getByTestId('watermark-text'))
    expect(screen.getByTestId('dialog-confirm')).toBeDisabled()
  })

  it('applies page numbers', async () => {
    const user = userEvent.setup()
    const { result } = show({ kind: 'page-numbers' })
    expect(screen.getByTestId('dialog')).toHaveAttribute('data-dialog', 'page-numbers')
    await user.selectOptions(screen.getByTestId('page-numbers-format'), 'Page {n} of {total}')
    await user.selectOptions(screen.getByTestId('page-numbers-position'), 'top-right')
    const start = screen.getByTestId('page-numbers-start')
    await user.clear(start)
    await user.type(start, '3')
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(editor().doc?.settings.pageNumbers).toMatchObject({ format: 'Page {n} of {total}', position: 'top-right', startAt: 3 })
  })

  it('updates metadata and flatten setting in properties', async () => {
    const user = userEvent.setup()
    const { result } = show({ kind: 'properties' })
    const title = screen.getByTestId('prop-title')
    expect(title).toHaveValue('Fixture title')
    expect(screen.getByTestId('prop-author')).toHaveValue('Fixture Author')
    await user.clear(title)
    await user.type(title, 'Quarterly report')
    await user.type(screen.getByTestId('prop-keywords'), 'q3, finance')
    await user.click(screen.getByTestId('prop-flatten'))
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.updateSettings).toHaveBeenLastCalledWith(expect.anything(), {
      metadata: { title: 'Quarterly report', keywords: 'q3, finance' },
      flattenForms: true
    })
    expect(editor().past).toHaveLength(1)
  })

  it('edits creator, producer, dates and custom properties', async () => {
    const user = userEvent.setup()
    const doc = makeDoc(2)
    doc.sources.src1.metadata = {
      ...doc.sources.src1.metadata,
      creator: 'Word',
      producer: 'Acrobat Distiller',
      creationDate: new Date(2024, 0, 3, 10, 20, 30).toISOString(),
      modificationDate: new Date(2024, 5, 1).toISOString(),
      custom: { Company: 'ACME', Department: 'Legal' }
    }
    loadDoc(doc, { filePath: '/docs/report.pdf', fileName: 'report.pdf' })
    const { result } = show({ kind: 'properties' })
    // The file's own values: saving keeps them.
    expect(screen.getByTestId('prop-creator')).toHaveValue('Word')
    expect(screen.getByTestId('prop-producer')).toHaveValue('Acrobat Distiller')
    expect(screen.getByTestId('prop-created')).toHaveValue('2024-01-03T10:20:30')
    expect(screen.getByTestId('prop-modified')).toHaveValue('2024-06-01T00:00')
    expect(screen.getAllByTestId('prop-custom-name').map((i) => (i as HTMLInputElement).value)).toEqual(['Company', 'Department'])

    await user.clear(screen.getByTestId('prop-creator'))
    await user.type(screen.getByTestId('prop-creator'), 'Pages')
    await user.clear(screen.getByTestId('prop-producer'))
    expect(screen.getByText('Originally “Acrobat Distiller”')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('prop-created'), { target: { value: '2023-12-24T18:00' } })
    fireEvent.change(screen.getByTestId('prop-modified'), { target: { value: '2025-02-01T08:30:15' } })
    await user.click(screen.getAllByTestId('prop-custom-remove')[1])
    await user.click(screen.getByTestId('prop-custom-add'))
    await user.type(screen.getAllByTestId('prop-custom-value')[1], 'Draft')
    expect(screen.getByTestId('field-error')).toHaveTextContent('Enter a name')
    expect(screen.getByTestId('dialog-confirm')).toBeDisabled()
    await user.type(screen.getAllByTestId('prop-custom-name')[1], 'Title')
    expect(screen.getByTestId('field-error')).toHaveTextContent('standard property name')
    await user.clear(screen.getAllByTestId('prop-custom-name')[1])
    await user.type(screen.getAllByTestId('prop-custom-name')[1], 'Company')
    expect(screen.getByTestId('field-error')).toHaveTextContent('already a property named “Company”')
    await user.clear(screen.getAllByTestId('prop-custom-name')[1])
    await user.type(screen.getAllByTestId('prop-custom-name')[1], 'Status')
    expect(screen.queryByTestId('field-error')).toBeNull()
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.updateSettings).toHaveBeenLastCalledWith(expect.anything(), {
      metadata: {
        creator: 'Pages',
        producer: '',
        creationDate: new Date(2023, 11, 24, 18, 0).toISOString(),
        modificationDate: new Date(2025, 1, 1, 8, 30, 15).toISOString(),
        custom: { Company: 'ACME', Status: 'Draft' }
      }
    })
  })

  it('saves nothing when the properties are left as they are', async () => {
    const user = userEvent.setup()
    const doc = makeDoc(2)
    doc.sources.src1.metadata = { ...doc.sources.src1.metadata, creationDate: new Date(2024, 0, 3).toISOString(), custom: { A: '1' } }
    loadDoc(doc, { filePath: '/docs/report.pdf', fileName: 'report.pdf' })
    const { result } = show({ kind: 'properties' })
    await user.click(screen.getByTestId('prop-custom-add'))
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.updateSettings).not.toHaveBeenCalled()
    expect(editor().past).toHaveLength(0)
  })

  it('clearing the modification date removes it', async () => {
    const user = userEvent.setup()
    const doc = makeDoc(2)
    doc.sources.src1.metadata = { ...doc.sources.src1.metadata, modificationDate: new Date(2024, 5, 1).toISOString() }
    loadDoc(doc, { filePath: '/docs/report.pdf', fileName: 'report.pdf' })
    const { result } = show({ kind: 'properties' })
    expect(screen.getByTestId('prop-modified')).toHaveValue('2024-06-01T00:00')
    expect(screen.queryByText('Leave empty to use the time of saving.')).toBeNull()
    fireEvent.change(screen.getByTestId('prop-modified'), { target: { value: '' } })
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.updateSettings).toHaveBeenLastCalledWith(expect.anything(), { metadata: { modificationDate: '' } })
  })

  it('in a new document, clearing the modification date goes back to the time of saving', async () => {
    const user = userEvent.setup()
    const doc = core.createBlankDocument()
    doc.settings.metadata = { modificationDate: new Date(2025, 1, 1).toISOString() }
    loadDoc(doc, { filePath: null, fileName: 'Untitled.pdf' })
    const { result } = show({ kind: 'properties' })
    expect(screen.getByTestId('prop-producer')).toHaveValue(PRODUCER)
    expect(screen.getByTestId('prop-modified')).toHaveValue('2025-02-01T00:00')
    fireEvent.change(screen.getByTestId('prop-modified'), { target: { value: '' } })
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.updateSettings).toHaveBeenLastCalledWith(expect.anything(), { metadata: { modificationDate: undefined } })
    expect(editor().doc?.settings.metadata.modificationDate).toBeUndefined()
  })

  it('sets, validates and removes a password', async () => {
    const user = userEvent.setup()
    const first = show({ kind: 'security' })
    await user.click(screen.getByTestId('security-enabled'))
    await user.type(screen.getByTestId('security-password'), 'pw1')
    await user.type(screen.getByTestId('security-confirm'), 'pw2')
    expect(screen.getAllByText(/do not match/).length).toBeGreaterThan(0)
    await user.click(screen.getByTestId('dialog-confirm'))
    expect(screen.getByTestId('dialog')).toBeInTheDocument()
    await user.clear(screen.getByTestId('security-confirm'))
    await user.type(screen.getByTestId('security-confirm'), 'pw1')
    await user.click(screen.getByTestId('dialog-confirm'))
    await first.result
    expect(editor().doc?.settings.encryption).toEqual({ userPassword: 'pw1' })

    cleanup()
    const second = show({ kind: 'security' })
    expect(screen.getByTestId('security-enabled')).toBeChecked()
    await user.click(screen.getByTestId('security-enabled'))
    await user.click(screen.getByTestId('dialog-confirm'))
    await second.result
    expect(editor().doc?.settings.encryption).toBeNull()
  })

  const permissions = {
    printing: 'none' as const,
    modifying: false,
    copying: false,
    annotating: true,
    fillingForms: true,
    contentAccessibility: true,
    documentAssembly: false
  }

  function loadEncrypted(encryption: { userPassword: string; ownerPassword?: string; permissions?: typeof permissions }) {
    const doc = makeDoc(2)
    loadDoc({ ...doc, settings: { ...doc.settings, encryption } }, { filePath: '/docs/locked.pdf', fileName: 'locked.pdf' })
  }

  it('keeps the original protection of a file opened with its owner password when Apply is untouched', async () => {
    const user = userEvent.setup()
    const original = { userPassword: '', ownerPassword: 'owner', permissions }
    loadEncrypted(original)
    const { result } = show({ kind: 'security' })
    expect(screen.getByTestId('security-owner-only')).toBeInTheDocument()
    expect(screen.getByTestId('security-enabled')).not.toBeChecked()
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(editor().doc?.settings.encryption).toBe(original)
    expect(editor().past).toHaveLength(0)
  })

  it('keeps the original permissions when only the password changes', async () => {
    const user = userEvent.setup()
    loadEncrypted({ userPassword: 'old', permissions })
    const { result } = show({ kind: 'security' })
    await user.clear(screen.getByTestId('security-password'))
    await user.type(screen.getByTestId('security-password'), 'new')
    await user.clear(screen.getByTestId('security-confirm'))
    await user.type(screen.getByTestId('security-confirm'), 'new')
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(editor().doc?.settings.encryption).toEqual({ userPassword: 'new', permissions })
  })
})

describe('insert pages dialog', () => {
  it('inserts the chosen range at the chosen position', async () => {
    const user = userEvent.setup()
    editor().setCurrentPage('p2')
    const source = makeSource('other', 4, 'other.pdf')
    const { result, dialog } = show({ kind: 'insert', source })
    expect(within(dialog()).getByText('other.pdf')).toBeInTheDocument()
    expect(screen.getByTestId('insert-page')).toHaveValue(2)
    await user.type(screen.getByTestId('range-input'), '2-3')
    await user.selectOptions(screen.getByTestId('insert-where'), 'before')
    expect(screen.getByTestId('dialog-confirm')).toHaveTextContent('Insert 2 pages')
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.insertSourcePages).toHaveBeenCalledWith(expect.anything(), source, 1, [1, 2])
    expect(editor().doc?.pages).toHaveLength(7)
  })

  it('inserts all pages at the end', async () => {
    const user = userEvent.setup()
    const source = makeSource('other', 2, 'other.pdf')
    const { result } = show({ kind: 'insert', source })
    await user.click(screen.getByText('At the end'))
    await user.click(screen.getByTestId('dialog-confirm'))
    await result
    expect(core.insertSourcePages).toHaveBeenCalledWith(expect.anything(), source, 5, undefined)
  })
})

describe('dialog frame', () => {
  it('cancels with Escape and the cancel button', async () => {
    const user = userEvent.setup()
    const a = show({ kind: 'about' })
    await user.keyboard('{Escape}')
    expect(await a.result).toBeNull()
    cleanup()
    const b = show({ kind: 'confirm', title: 'Sure?', message: 'Really?' })
    await user.click(screen.getByTestId('dialog-cancel'))
    expect(await b.result).toBeNull()
  })
})
