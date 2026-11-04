/** Shared helpers for editing-layer component tests (jsdom). */
import { act, fireEvent, render } from '@testing-library/react'
import { vi } from 'vitest'
import {
  displaySize,
  type EditObject,
  type EditorDocument,
  type FormFieldInfo,
  type PageEntry,
  type Rotation,
  type SourceDocument
} from '@core'
import { DEFAULT_TOOL_OPTIONS, useEditor } from '@renderer/state/store'
import { PageOverlay } from '@renderer/editing/PageOverlay'
import { PropertiesPanel } from '@renderer/editing/PropertiesPanel'
import { useEditingShortcuts } from '@renderer/editing/useEditingShortcuts'
import { useEditing } from '@renderer/editing/editingState'

// jsdom lacks blob URLs.
if (typeof URL.createObjectURL !== 'function') {
  let n = 0
  URL.createObjectURL = () => `blob:mock/${++n}`
  URL.revokeObjectURL = () => undefined
}

export const A4 = { width: 600, height: 800 }

export function makePage(id: string, opts: Partial<PageEntry> = {}): PageEntry {
  return {
    id,
    source: { kind: 'blank' },
    width: A4.width,
    height: A4.height,
    baseRotation: 0,
    rotation: 0,
    ...opts
  }
}

export function makeSource(id: string, formFields: FormFieldInfo[] = [], pageCount = 1): SourceDocument {
  return {
    id,
    name: `${id}.pdf`,
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    isEncrypted: false,
    pageCount,
    metadata: {},
    formFields
  }
}

export function makeDoc(opts: {
  pages?: PageEntry[]
  objects?: EditObject[]
  sources?: SourceDocument[]
} = {}): EditorDocument {
  const sources = opts.sources ?? []
  return {
    primarySourceId: sources[0]?.id ?? null,
    sources: Object.fromEntries(sources.map((s) => [s.id, s])),
    pages: opts.pages ?? [makePage('p1')],
    objects: opts.objects ?? [],
    formValues: {},
    settings: { metadata: {}, watermark: null, pageNumbers: null, flattenForms: false, encryption: null }
  }
}

/** Reset the shared stores and load `doc`. */
export function loadDoc(doc: EditorDocument): void {
  act(() => {
    useEditor.getState().setDocument(doc, { filePath: null, fileName: 'test.pdf' })
    useEditor.setState({ toolOptions: { ...DEFAULT_TOOL_OPTIONS }, tool: 'select', notice: null, pendingImage: null })
    useEditing.getState().reset()
    useEditing.setState({ cancelToken: 0 })
  })
}

export const store = () => useEditor.getState()
export const doc = () => useEditor.getState().doc!
export const objects = () => doc().objects

function Shortcuts() {
  useEditingShortcuts()
  return null
}

/** Mimics the viewer: a positioned page box with the overlay on top. */
function PageHarness({ pageIndex, scale }: { pageIndex: number; scale: number }) {
  const page = useEditor((s) => s.doc?.pages[pageIndex])
  if (!page) return null
  const size = displaySize(page)
  return (
    <div
      data-testid="page"
      data-page-id={page.id}
      style={{ position: 'relative', width: size.width * scale, height: size.height * scale }}
    >
      <PageOverlay page={page} pageIndex={pageIndex} scale={scale} />
    </div>
  )
}

export function renderPage(opts: { pageIndex?: number; scale?: number; panel?: boolean; shortcuts?: boolean } = {}) {
  const { pageIndex = 0, scale = 1, panel = false, shortcuts = true } = opts
  return render(
    <>
      {shortcuts && <Shortcuts />}
      <PageHarness pageIndex={pageIndex} scale={scale} />
      {panel && <PropertiesPanel />}
    </>
  )
}

/**
 * jsdom has no layout. Every element reports a rect at the origin, so clientX/clientY equal
 * view coordinates relative to the page.
 */
export function mockLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const w = (this as HTMLElement).style?.width ? parseFloat((this as HTMLElement).style.width) : 0
    const h = (this as HTMLElement).style?.height ? parseFloat((this as HTMLElement).style.height) : 0
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect
  })
}

export interface Pt {
  x: number
  y: number
}

const pid = { pointerId: 1, button: 0, isPrimary: true, pointerType: 'mouse' }

export function pointerDown(el: Element, p: Pt, init: Record<string, unknown> = {}): void {
  fireEvent.pointerDown(el, { ...pid, clientX: p.x, clientY: p.y, buttons: 1, ...init })
}
export function pointerMove(el: Element, p: Pt, init: Record<string, unknown> = {}): void {
  fireEvent.pointerMove(el, { ...pid, clientX: p.x, clientY: p.y, buttons: 1, ...init })
}
export function pointerUp(el: Element, p: Pt, init: Record<string, unknown> = {}): void {
  fireEvent.pointerUp(el, { ...pid, clientX: p.x, clientY: p.y, buttons: 0, ...init })
}

/** Press at `from`, move in steps to `to`, release. */
export function drag(el: Element, from: Pt, to: Pt, init: Record<string, unknown> = {}, steps = 4): void {
  pointerDown(el, from, init)
  for (let i = 1; i <= steps; i++) {
    pointerMove(el, { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, init)
  }
  pointerUp(el, to, init)
}

export function click(el: Element, p: Pt, init: Record<string, unknown> = {}): void {
  pointerDown(el, p, init)
  pointerUp(el, p, init)
}

export function setTool(tool: Parameters<ReturnType<typeof store>['setTool']>[0]): void {
  act(() => store().setTool(tool))
}

export function rotatedPage(id: string, rotation: Rotation): PageEntry {
  return makePage(id, { rotation })
}

/** Minimal PNG header (signature + IHDR) with the given size. */
export function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  b[24] = 8
  b[25] = 6
  return b
}

export function objectEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="object"][data-object-id="${id}"]`)
  if (!el) throw new Error(`object ${id} not rendered`)
  return el
}
