/** Regression tests for review findings on form fields. */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldObject, FormFieldInfo } from '@core'
import { namesClash, validateFieldName } from '@renderer/editing'
import { activateTool } from '@renderer/editing/tools'
import { click, doc, drag, loadDoc, makeDoc, makePage, makeSource, mockLayout, objects, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const w = (x: number, y: number, width = 200, height = 22, onValue?: string) => ({ pageIndex: 0, box: { x, y, width, height }, ...(onValue ? { onValue } : {}) })
const FIELDS: FormFieldInfo[] = [
  { name: 'name', type: 'text', value: '', readOnly: false, widgets: [w(150, 80)] },
  { name: 'fixed', type: 'text', value: 'fixed', readOnly: true, widgets: [w(150, 120)] },
  { name: 'color', type: 'radio', value: '', options: ['red', 'green', 'blue'], readOnly: false, widgets: [w(150, 240, 18, 18, 'red'), w(210, 240, 18, 18, 'green'), w(270, 240, 18, 18, 'blue')] },
  { name: 'Check1.box', type: 'checkbox', value: false, readOnly: false, widgets: [w(150, 300, 18, 18, 'Yes')] },
  { name: 'address.street', type: 'text', value: '', readOnly: false, widgets: [w(150, 340)] }
]
const SRC = 's'

const input = (name: string, i = 0) => screen.getAllByTestId('form-field').filter((e) => e.dataset.fieldName === name)[i] as HTMLInputElement
const fieldBox = (name: string, i = 0) => screen.getAllByTestId('field-box').filter((el) => el.dataset.originalName === name)[i]
const fedit = (name: string) => doc().fieldEdits?.[SRC]?.[name]

function setup(extra: FieldObject[] = []) {
  loadDoc(
    makeDoc({ sources: [makeSource(SRC, FIELDS)], pages: [makePage('p1', { source: { kind: 'source', sourceId: SRC, pageIndex: 0 } })], objects: extra })
  )
  return renderPage({ panel: true })
}

beforeEach(() => mockLayout())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('read-only fields and the canvas (#4)', () => {
  it('follows the SOURCE read-only flag that pdf.js paints by', async () => {
    const user = userEvent.setup()
    setup()
    expect(input('fixed')).toHaveClass('ed-field-painted') // pdf.js shows the value
    expect(input('name')).not.toHaveClass('ed-field-painted')
    setTool('form-design')
    click(fieldBox('name'), { x: 200, y: 90 })
    await user.click(screen.getByTestId('prop-field-readOnly'))
    click(fieldBox('fixed'), { x: 200, y: 130 })
    await user.click(screen.getByTestId('prop-field-readOnly'))
    expect(fedit('name')?.readOnly).toBe(true)
    expect(fedit('fixed')?.readOnly).toBe(false)
    setTool('select')
    // Made read-only: pdf.js still does not paint it, so our (disabled) input shows the value.
    expect(input('name')).toBeDisabled()
    expect(input('name')).not.toHaveClass('ed-field-painted')
    // Made editable: the painted copy is covered by an opaque, editable input.
    expect(input('fixed')).toBeEnabled()
    expect(input('fixed')).toHaveClass('ed-field-cover')
    expect(input('fixed')).not.toHaveClass('ed-field-painted')
  })
})

describe('renaming export values keeps the selection (#5)', () => {
  it('existing radio: the stored value follows the renamed export value', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(input('color', 1))
    expect(doc().formValues[SRC]?.color).toBe('green')
    setTool('form-design')
    click(fieldBox('color', 1), { x: 215, y: 245 })
    const ev = screen.getByTestId('prop-field-exportValue')
    await user.clear(ev)
    await user.type(ev, 'verde{Enter}')
    expect(fedit('color')?.options).toEqual(['red', 'verde', 'blue'])
    expect(doc().formValues[SRC]?.color).toBe('verde')
    setTool('select')
    expect(input('color', 1)).toBeChecked()
    // One undo step for the rename and the value.
    act(() => store().undo())
    expect(doc().formValues[SRC]?.color).toBe('green')
    expect(fedit('color')).toBeUndefined()
  })

  it('new radio group: members holding the old export value are updated', async () => {
    const user = userEvent.setup()
    const r = (id: string, exportValue: string): FieldObject => ({
      id, pageId: 'p1', type: 'field', fieldType: 'radio', name: 'G', exportValue, value: 'A', x: 300, y: 500, width: 14, height: 14
    })
    setup([r('r1', 'A'), r('r2', 'B')])
    setTool('form-design')
    act(() => store().selectObject('r1'))
    const ev = screen.getByTestId('prop-field-exportValue')
    await user.clear(ev)
    await user.type(ev, 'Alpha{Enter}')
    expect(objects().map((o) => [(o as FieldObject).exportValue, (o as FieldObject).value])).toEqual([
      ['Alpha', 'Alpha'],
      ['B', 'Alpha']
    ])
  })
})

describe('deleting one widget of a field (#6)', () => {
  it('Delete removes the selected radio button only; the last one deletes the field', () => {
    setup()
    setTool('form-design')
    click(fieldBox('color', 1), { x: 215, y: 245 })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(fedit('color')).toEqual({ deletedWidgets: [1] })
    expect(screen.getAllByTestId('field-box').filter((b) => b.dataset.originalName === 'color').map((b) => b.dataset.widgetIndex)).toEqual(['0', '2'])
    // Moving a remaining widget keeps widgetBoxes aligned with the source widgets.
    drag(fieldBox('color', 1), { x: 275, y: 245 }, { x: 285, y: 255 })
    expect(fedit('color')?.widgetBoxes).toEqual([
      { x: 150, y: 240, width: 18, height: 18 },
      { x: 210, y: 240, width: 18, height: 18 },
      { x: 280, y: 250, width: 18, height: 18 }
    ])
    setTool('select')
    expect(screen.getAllByTestId('form-field').filter((e) => e.dataset.fieldName === 'color')).toHaveLength(2)
    setTool('form-design')
    click(fieldBox('color', 0), { x: 155, y: 245 })
    fireEvent.keyDown(window, { key: 'Delete' })
    click(fieldBox('color', 0), { x: 285, y: 255 })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(fedit('color')?.deleted).toBe(true)
  })

  it('"Delete field" removes all widgets at once', async () => {
    const user = userEvent.setup()
    setup()
    setTool('form-design')
    click(fieldBox('color', 0), { x: 155, y: 245 })
    expect(screen.getByTestId('prop-delete')).toHaveAttribute('title', expect.stringMatching(/widget/))
    await user.click(screen.getByTestId('prop-delete-field'))
    expect(fedit('color')?.deleted).toBe(true)
    expect(store().selectedElement).toBeNull()
    // Single-widget fields have no separate action.
    click(fieldBox('name'), { x: 200, y: 90 })
    expect(screen.queryByTestId('prop-delete-field')).toBeNull()
  })
})

describe('hierarchical field names (#7)', () => {
  it('namesClash: equal names and dotted prefixes', () => {
    expect(namesClash('a', 'a')).toBe(true)
    expect(namesClash('a', 'a.b')).toBe(true)
    expect(namesClash('a.b.c', 'a.b')).toBe(true)
    expect(namesClash('a', 'ab')).toBe(false)
    expect(namesClash('a.b', 'a.c')).toBe(false)
  })

  it('validateFieldName rejects prefix clashes with existing fields and new fields', () => {
    const f: FieldObject = { id: 'f1', pageId: 'p1', type: 'field', fieldType: 'text', name: 'notes.extra', x: 0, y: 0, width: 10, height: 10 }
    setup([f])
    const d = doc()
    expect(validateFieldName(d, SRC, 'address', 'name')).toMatch(/conflicts/)
    expect(validateFieldName(d, SRC, 'name.first', 'name')).toBeNull() // only itself is "name"
    expect(validateFieldName(d, SRC, 'color.x', 'name')).toMatch(/conflicts/)
    expect(validateFieldName(d, SRC, 'notes', 'name')).toMatch(/conflicts/)
    expect(validateFieldName(d, SRC, 'fixed', 'name')).toMatch(/already exists/)
    expect(validateFieldName(d, null, 'address.street.no', 'f1')).toMatch(/conflicts/)
    expect(validateFieldName(d, null, 'notes.extra', 'f1')).toBeNull()
    expect(validateFieldName(d, null, 'brandNew', null)).toBeNull()
    expect(validateFieldName(d, null, ' ', null)).toMatch(/empty/)
  })

  it('panel rename and default names avoid prefix clashes', async () => {
    const user = userEvent.setup()
    setup()
    setTool('form-design')
    click(fieldBox('name'), { x: 200, y: 90 })
    const nameInput = screen.getByTestId('prop-field-name')
    await user.clear(nameInput)
    await user.type(nameInput, 'address{Enter}')
    expect(screen.getByTestId('prop-field-name-error')).toHaveTextContent(/conflicts/)
    expect(fedit('name')).toBeUndefined()
    // "Check1.box" exists, so "Check1" is taken.
    act(() => activateTool('field-checkbox'))
    click(screen.getByTestId('page-overlay'), { x: 400, y: 600 })
    expect((objects()[0] as FieldObject).name).toBe('Check2')
  })
})
