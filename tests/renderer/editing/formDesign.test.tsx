import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldObject, FormFieldInfo, NewFieldType } from '@core'
import { activateTool } from '@renderer/editing/tools'
import type { ToolId } from '@renderer/state/store'
import { click, doc, drag, loadDoc, makeDoc, makePage, makeSource, mockLayout, objectEl, objects, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const w = (x: number, y: number, width = 200, height = 22, onValue?: string) => ({ pageIndex: 0, box: { x, y, width, height }, ...(onValue ? { onValue } : {}) })
const FIELDS: FormFieldInfo[] = [
  { name: 'name', type: 'text', value: '', readOnly: false, widgets: [w(150, 80)] },
  { name: 'agree', type: 'checkbox', value: false, readOnly: false, widgets: [w(150, 200, 18, 18, 'Yes')] },
  { name: 'color', type: 'radio', value: '', options: ['red', 'green'], readOnly: false, widgets: [w(150, 240, 18, 18, 'red'), w(210, 240, 18, 18, 'green')] },
  { name: 'country', type: 'dropdown', value: 'LT', options: ['LT', 'DE'], optionLabels: ['Lithuania', 'Germany'], readOnly: false, widgets: [w(150, 280)] },
  { name: 'Text1', type: 'text', value: '', readOnly: false, widgets: [w(150, 400)] },
  { name: 'submit', type: 'button', value: '', readOnly: false, widgets: [w(150, 460)] }
]

const SRC = 's'
const fieldBox = (name: string, i = 0) =>
  screen.getAllByTestId('field-box').filter((el) => el.dataset.originalName === name)[i]
const fedit = (name: string) => doc().fieldEdits?.[SRC]?.[name]
const fieldObj = (id: string) => objects().find((o) => o.id === id) as FieldObject
const overlay = () => screen.getByTestId('page-overlay')

function setup(extra: FieldObject[] = []) {
  loadDoc(
    makeDoc({
      sources: [makeSource(SRC, FIELDS)],
      pages: [makePage('p1', { source: { kind: 'source', sourceId: SRC, pageIndex: 0 } })],
      objects: extra
    })
  )
  const r = renderPage({ panel: true })
  setTool('form-design')
  return r
}

const textObj: FieldObject = { id: 'f1', pageId: 'p1', type: 'field', fieldType: 'text', name: 'Comments', x: 300, y: 600, width: 150, height: 22, value: '' }

beforeEach(() => mockLayout())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Prepare form: existing fields', () => {
  it('shows every widget (incl. buttons) as a labelled box instead of an input', () => {
    setup()
    expect(screen.queryAllByTestId('form-field')).toHaveLength(0)
    const boxes = screen.getAllByTestId('field-box')
    expect(boxes.map((b) => b.dataset.originalName)).toEqual(['name', 'agree', 'color', 'color', 'country', 'Text1', 'submit'])
    expect(fieldBox('name').textContent).toBe('name')
    expect(fieldBox('name').style.left).toBe('150px')
  })

  it('click selects a widget; drag moves it and handles resize it (one undo step each)', () => {
    setup()
    click(fieldBox('color', 1), { x: 215, y: 245 })
    expect(store().selectedElement).toEqual({ kind: 'field', sourceId: SRC, fieldName: 'color', widgetIndex: 1, pageId: 'p1' })
    expect(fieldBox('color', 1)).toHaveAttribute('data-selected', 'true')
    drag(fieldBox('color', 1), { x: 215, y: 245 }, { x: 265, y: 255 })
    expect(fedit('color')?.widgetBoxes).toEqual([
      { x: 150, y: 240, width: 18, height: 18 },
      { x: 260, y: 250, width: 18, height: 18 }
    ])
    expect(store().past).toHaveLength(1)
    click(fieldBox('name'), { x: 200, y: 90 })
    drag(screen.getByTestId('handle-se'), { x: 350, y: 102 }, { x: 400, y: 112 })
    expect(fedit('name')?.widgetBoxes).toEqual([{ x: 150, y: 80, width: 250, height: 32 }])
    expect(store().past).toHaveLength(2)
  })

  it('renames with uniqueness validation (existing fields and new fields)', async () => {
    const user = userEvent.setup()
    setup([textObj])
    click(fieldBox('name'), { x: 200, y: 90 })
    const input = screen.getByTestId('prop-field-name')
    await user.clear(input)
    await user.type(input, 'country{Enter}')
    expect(screen.getByTestId('prop-field-name-error')).toHaveTextContent(/already exists/)
    expect(fedit('name')).toBeUndefined()
    await user.clear(input)
    await user.type(input, 'Comments{Enter}')
    expect(screen.getByTestId('prop-field-name-error')).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, 'fullName{Enter}')
    expect(screen.queryByTestId('prop-field-name-error')).toBeNull()
    expect(fedit('name')?.name).toBe('fullName')
    expect(fieldBox('name').textContent).toBe('fullName')
    // Fill mode shows the new name, values still keyed by the original name.
    setTool('select')
    const input2 = screen.getAllByTestId('form-field').find((e) => e.dataset.fieldName === 'fullName')!
    await user.type(input2, 'Ada')
    expect(doc().formValues[SRC]?.name).toBe('Ada')
  })

  it('edits field properties', async () => {
    const user = userEvent.setup()
    setup()
    click(fieldBox('name'), { x: 200, y: 90 })
    await user.click(screen.getByTestId('prop-field-required'))
    await user.click(screen.getByTestId('prop-field-readOnly'))
    await user.click(screen.getByTestId('prop-field-multiline'))
    await user.type(screen.getByTestId('prop-field-maxLength'), '20')
    const fs = screen.getByTestId('prop-field-fontSize')
    await user.clear(fs)
    await user.type(fs, '9')
    expect(fedit('name')).toMatchObject({ required: true, readOnly: true, multiline: true, maxLength: 20, fontSize: 9 })
    await user.clear(screen.getByTestId('prop-field-maxLength'))
    expect(fedit('name')?.maxLength).toBeNull()

    click(fieldBox('country'), { x: 200, y: 290 })
    const opts = screen.getByTestId('prop-field-options')
    expect(opts).toHaveValue('LT\nDE')
    await user.clear(opts)
    await user.type(opts, 'A{Enter}{Enter}B')
    act(() => (opts as HTMLTextAreaElement).blur())
    expect(fedit('country')).toMatchObject({ options: ['A', 'B'], optionLabels: null })

    click(fieldBox('color', 1), { x: 215, y: 245 })
    const ev = screen.getByTestId('prop-field-exportValue')
    expect(ev).toHaveValue('green')
    await user.clear(ev)
    await user.type(ev, 'blue{Enter}')
    expect(fedit('color')?.options).toEqual(['red', 'blue'])
  })

  it('Delete removes the field; Reset restores it', async () => {
    const user = userEvent.setup()
    setup()
    click(fieldBox('agree'), { x: 155, y: 205 })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(fedit('agree')).toEqual({ deleted: true })
    expect(screen.getAllByTestId('field-box').map((b) => b.dataset.originalName)).not.toContain('agree')
    expect(store().selectedElement).toBeNull()
    // The checkbox pdf.js painted at its old place is masked until the page re-renders.
    expect(screen.getByTestId('widget-mask')).toBeInTheDocument()
    act(() => {
      screen.getByTestId('page').dispatchEvent(new CustomEvent('ope:page-rendered', { bubbles: true, detail: { pageId: 'p1' } }))
    })
    expect(screen.queryByTestId('widget-mask')).toBeNull()
    act(() => store().undo())
    click(fieldBox('agree'), { x: 155, y: 205 })
    drag(fieldBox('agree'), { x: 155, y: 205 }, { x: 175, y: 205 })
    await user.click(screen.getByTestId('prop-reset'))
    expect(fedit('agree')).toBeUndefined()
  })
})

describe('Prepare form: new fields', () => {
  const cases: [ToolId, NewFieldType, Partial<FieldObject>][] = [
    ['field-text', 'text', { name: 'Text2', value: '' }], // Text1 exists in the file
    ['field-checkbox', 'checkbox', { name: 'Check1', exportValue: 'Yes', value: false }],
    ['field-radio', 'radio', { name: 'Group1', exportValue: 'Choice1' }],
    ['field-dropdown', 'dropdown', { name: 'Dropdown1', options: ['Option 1', 'Option 2'] }],
    ['field-list', 'optionlist', { name: 'List1', options: ['Option 1', 'Option 2'], value: [] }],
    ['field-signature', 'signature', { name: 'Signature1' }]
  ]
  for (const [tool, fieldType, expected] of cases) {
    it(`${tool}: drag creates a ${fieldType} field with a unique default name and selects it`, () => {
      setup()
      act(() => activateTool(tool))
      expect(screen.getByTestId('page-overlay')).toHaveAttribute('data-tool', tool)
      drag(overlay(), { x: 300, y: 500 }, { x: 420, y: 530 })
      const obj = objects()[0] as FieldObject
      expect(obj).toMatchObject({ type: 'field', fieldType, x: 300, y: 500, width: 120, height: 30, ...expected })
      expect(store().tool).toBe('form-design')
      expect(store().selectedObjectId).toBe(obj.id)
      expect(store().past).toHaveLength(1)
    })
  }

  it('a click places a default-size field; names keep increasing', () => {
    setup()
    act(() => activateTool('field-checkbox'))
    click(overlay(), { x: 300, y: 500 })
    act(() => activateTool('field-checkbox'))
    click(overlay(), { x: 300, y: 550 })
    expect(objects().map((o) => (o as FieldObject).name)).toEqual(['Check1', 'Check2'])
    expect(objects()[0]).toMatchObject({ x: 293, y: 493, width: 14, height: 14 })
  })

  it('a radio button added while one is selected joins its group', () => {
    setup()
    act(() => activateTool('field-radio'))
    click(overlay(), { x: 300, y: 500 })
    act(() => activateTool('field-radio'))
    click(overlay(), { x: 340, y: 500 })
    act(() => store().selectObject(null))
    act(() => activateTool('field-radio'))
    click(overlay(), { x: 380, y: 500 })
    expect(objects().map((o) => [(o as FieldObject).name, (o as FieldObject).exportValue])).toEqual([
      ['Group1', 'Choice1'],
      ['Group1', 'Choice2'],
      ['Group2', 'Choice1']
    ])
  })

  it('new fields are moved/resized in Prepare form mode and renamed with validation', async () => {
    const user = userEvent.setup()
    const { container } = setup([textObj])
    expect(objectEl(container, 'f1').textContent).toBe('Comments')
    drag(objectEl(container, 'f1'), { x: 350, y: 610 }, { x: 360, y: 640 })
    expect(fieldObj('f1')).toMatchObject({ x: 310, y: 630 })
    drag(screen.getByTestId('handle-e'), { x: 460, y: 641 }, { x: 500, y: 641 })
    expect(fieldObj('f1').width).toBe(190)
    expect(store().past).toHaveLength(2)
    const input = screen.getByTestId('prop-field-name')
    await user.clear(input)
    await user.type(input, 'name{Enter}')
    expect(screen.getByTestId('prop-field-name-error')).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, 'Remarks{Enter}')
    expect(fieldObj('f1').name).toBe('Remarks')
    await user.click(screen.getByTestId('prop-field-multiline'))
    expect(fieldObj('f1').multiline).toBe(true)
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(objects()).toHaveLength(0)
  })

  it('renaming a radio button renames its group', async () => {
    const user = userEvent.setup()
    const r = (id: string, exportValue: string): FieldObject => ({ id, pageId: 'p1', type: 'field', fieldType: 'radio', name: 'G', exportValue, x: 300, y: 500, width: 14, height: 14 })
    setup([r('r1', 'A'), r('r2', 'B')])
    act(() => store().selectObject('r1'))
    const input = screen.getByTestId('prop-field-name')
    await user.clear(input)
    await user.type(input, 'Answer{Enter}')
    expect(objects().map((o) => (o as FieldObject).name)).toEqual(['Answer', 'Answer'])
    const ev = screen.getByTestId('prop-field-exportValue')
    await user.clear(ev)
    await user.type(ev, 'B{Enter}')
    expect(screen.getByTestId('prop-field-exportValue-error')).toBeInTheDocument()
  })

  it('new fields are filled like existing ones in the Select tool', async () => {
    const user = userEvent.setup()
    const f = (id: string, fieldType: NewFieldType, extra: Partial<FieldObject> = {}): FieldObject => ({
      id, pageId: 'p1', type: 'field', fieldType, name: id, x: 300, y: 100 + objectsCount++ * 40, width: 150, height: 22, ...extra
    })
    let objectsCount = 0
    setup([
      f('t', 'text', { value: '' }),
      f('c', 'checkbox', { exportValue: 'Yes', value: false }),
      f('ra', 'radio', { name: 'grp', exportValue: 'A' }),
      f('rb', 'radio', { name: 'grp', exportValue: 'B' }),
      f('d', 'dropdown', { options: ['x', 'y'], value: '' }),
      f('l', 'optionlist', { options: ['x', 'y', 'z'], value: [] })
    ])
    setTool('select')
    const input = (name: string, i = 0) => screen.getAllByTestId('form-field').filter((e) => e.dataset.fieldName === name)[i]
    await user.type(input('t'), 'hello')
    expect(fieldObj('t').value).toBe('hello')
    expect(store().past).toHaveLength(1)
    await user.click(input('c'))
    expect(fieldObj('c').value).toBe(true)
    await user.click(input('grp', 1))
    expect([fieldObj('ra').value, fieldObj('rb').value]).toEqual(['B', 'B'])
    expect(input('grp', 1)).toBeChecked()
    expect(input('grp', 0)).not.toBeChecked()
    await user.selectOptions(input('d'), 'y')
    expect(fieldObj('d').value).toBe('y')
    await user.selectOptions(input('l'), ['x', 'z'])
    expect(fieldObj('l').value).toEqual(['x', 'z'])
    // Clicking a field to fill it does not select or move the object.
    expect(store().selectedObjectId).toBeNull()
  })
})

describe('selection across tools', () => {
  it('switching tools clears selections that do not belong to the new tool', () => {
    setup([textObj])
    act(() => store().selectObject('f1'))
    setTool('edit-content')
    expect(store().selectedObjectId).toBeNull()
    setTool('form-design')
    click(fieldBox('name'), { x: 200, y: 90 })
    expect(store().selectedElement?.kind).toBe('field')
    setTool('select')
    expect(store().selectedElement?.kind).toBe('field') // select keeps the selection
    setTool('edit-content')
    expect(store().selectedElement).toBeNull()
  })

  it('Escape deselects first and leaves Prepare form mode on a second press', () => {
    setup()
    click(fieldBox('name'), { x: 200, y: 90 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(store().selectedElement).toBeNull()
    expect(store().tool).toBe('form-design')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(store().tool).toBe('select')
    act(() => activateTool('field-text'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(store().tool).toBe('form-design')
  })
})
