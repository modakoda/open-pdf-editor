import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormFieldInfo } from '@core'
import { doc, loadDoc, makeDoc, makePage, makeSource, mockLayout, renderPage, setTool, store } from './helpers'

vi.mock('@renderer/pdf/pdfjs', () => ({ getPdfPage: vi.fn() }))

const w = (x: number, y: number, width = 200, height = 22, pageIndex = 0, onValue?: string) => ({
  pageIndex,
  box: { x, y, width, height },
  ...(onValue ? { onValue } : {})
})

const fields: FormFieldInfo[] = [
  { name: 'name', type: 'text', value: '', readOnly: false, maxLength: 10, widgets: [w(150, 80)] },
  { name: 'notes', type: 'text', value: 'old', readOnly: false, multiline: true, widgets: [w(150, 120, 250, 70)] },
  { name: 'agree', type: 'checkbox', value: false, readOnly: false, widgets: [w(150, 200, 18, 18, 0, 'Yes')] },
  {
    name: 'color', type: 'radio', value: '', options: ['red', 'green', 'blue'], readOnly: false,
    widgets: [w(150, 240, 18, 18, 0, 'red'), w(210, 240, 18, 18, 0, 'green'), w(270, 240, 18, 18, 0, 'blue')]
  },
  // Export values differ from the labels shown to the user.
  {
    name: 'country', type: 'dropdown', value: 'FR', options: ['LT', 'DE', 'FR'],
    optionLabels: ['Lithuania', 'Germany', 'France'], readOnly: false, widgets: [w(150, 280)]
  },
  { name: 'langs', type: 'optionlist', value: [], options: ['English', 'German', 'Lithuanian'], readOnly: false, widgets: [w(150, 320, 200, 70)] },
  { name: 'readonly', type: 'text', value: 'fixed', readOnly: true, widgets: [w(150, 420)] },
  { name: 'submit', type: 'button', value: '', readOnly: false, widgets: [w(150, 460)] },
  { name: 'sig', type: 'signature', value: '', readOnly: false, widgets: [w(150, 500)] },
  { name: 'page2', type: 'text', value: '', readOnly: false, widgets: [w(150, 80, 200, 22, 1)] }
]

const SRC = 'src1'
const field = (name: string) => screen.getAllByTestId('form-field').filter((el) => el.dataset.fieldName === name)
const value = (name: string) => doc().formValues[SRC]?.[name]

beforeEach(() => {
  mockLayout()
  loadDoc(
    makeDoc({
      sources: [makeSource(SRC, fields, 2)],
      pages: [
        makePage('p1', { source: { kind: 'source', sourceId: SRC, pageIndex: 0 } }),
        makePage('p2', { source: { kind: 'source', sourceId: SRC, pageIndex: 1 } })
      ]
    })
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('form fields', () => {
  it('renders an input per supported widget of this page at the widget box', () => {
    renderPage({ scale: 2 })
    const names = screen.getAllByTestId('form-field').map((el) => el.dataset.fieldName)
    expect(names).toEqual(['name', 'notes', 'agree', 'color', 'color', 'color', 'country', 'langs', 'readonly'])
    const name = field('name')[0] as HTMLInputElement
    expect(name.tagName).toBe('INPUT')
    expect(name.style.left).toBe('300px')
    expect(name.style.top).toBe('160px')
    expect(name.style.width).toBe('400px')
    expect(name.maxLength).toBe(10)
    expect(parseFloat(name.style.fontSize)).toBeGreaterThan(20) // scales with zoom
    expect(field('notes')[0].tagName).toBe('TEXTAREA')
    expect(field('readonly')[0]).toBeDisabled()
    expect(field('readonly')[0]).toHaveValue('fixed')
  })

  it('only renders fields of the page it covers', () => {
    renderPage({ pageIndex: 1 })
    expect(screen.getAllByTestId('form-field').map((el) => el.dataset.fieldName)).toEqual(['page2'])
  })

  it('reads and writes values of every field type', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(field('name')[0], 'Ann')
    expect(value('name')).toBe('Ann')
    expect(store().past).toHaveLength(1) // typing coalesces into one undo step

    expect(field('notes')[0]).toHaveValue('old')
    await user.type(field('notes')[0], '{Enter}line')
    expect(value('notes')).toBe('old\nline')

    await user.click(field('agree')[0])
    expect(value('agree')).toBe(true)
    expect(field('agree')[0]).toBeChecked()
    await user.click(field('agree')[0])
    expect(value('agree')).toBe(false)

    await user.click(field('color')[1])
    expect(value('color')).toBe('green')
    expect(field('color')[1]).toBeChecked()
    expect(field('color')[0]).not.toBeChecked()

    expect(field('country')[0]).toHaveValue('FR')
    expect((field('country')[0] as HTMLSelectElement).selectedOptions[0].textContent).toBe('France')
    await user.selectOptions(field('country')[0], 'Germany')
    expect(value('country')).toBe('DE')

    await user.selectOptions(field('langs')[0], ['English', 'Lithuanian'])
    expect(value('langs')).toEqual(['English', 'Lithuanian'])

    // Both selections were one coalesced step: undo restores the value from the file.
    act(() => store().undo())
    expect(value('langs')).toBeUndefined()
    expect(value('country')).toBe('DE')
  })

  it('shows values changed elsewhere (e.g. undo) and stays interactive only in select mode', () => {
    renderPage()
    act(() =>
      store().apply((d) => ({ ...d, formValues: { [SRC]: { name: 'Bob', agree: true, color: 'blue' } } }))
    )
    expect(field('name')[0]).toHaveValue('Bob')
    expect(field('agree')[0]).toBeChecked()
    expect(field('color')[2]).toBeChecked()
    const layer = screen.getAllByTestId('form-field')[0].parentElement!
    expect(layer).toHaveAttribute('data-interactive', 'true')
    setTool('rect')
    expect(layer).toHaveAttribute('data-interactive', 'false')
  })
})
