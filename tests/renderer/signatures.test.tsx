import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const signing = vi.hoisted(() => ({
  signPdf: vi.fn(async (_pdf: Uint8Array, _options: unknown) => new Uint8Array([9, 9, 9]))
}))

vi.mock('@core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core')>()),
  ...(await import('./support/fakeCore')).coreOverrides,
  signPdf: signing.signPdf
}))
vi.mock('@renderer/platform', async () => (await import('./support/fakePlatform')).platformModule)
vi.mock('@renderer/pdf/pdfjs', async () => (await import('./support/fakePdfjs')).pdfjsModule)

import type { EditorDocument, FormFieldInfo, PdfSignatureInfo } from '@core'
import type { UnlockedCertificate } from '@shared/ipc'
import { installDocument, save, saveAs } from '@renderer/actions/fileActions'
import { emptySignatureFieldChoices, signAndSave } from '@renderer/actions/signActions'
import { SignaturePlacementLayer } from '@renderer/components/signatures/SignaturePlacementLayer'
import { SignatureBadge, SignaturesPanel, overallStatus } from '@renderer/components/signatures/SignaturesPanel'
import { DialogHost } from '@renderer/dialogs/DialogHost'
import { certificateValidityProblem } from '@renderer/dialogs/SignDialog'
import { openDialog } from '@renderer/state/dialogs'
import { useSigning, type SignRequest } from '@renderer/state/signing'
import { coreOverrides as core, makeDoc, resetFakeCore } from './support/fakeCore'
import { fake, resetFakePlatform } from './support/fakePlatform'
import { editor, resetStores } from './support/editor'

const CERT: UnlockedCertificate = {
  id: 'cert-1',
  name: 'jane.p12',
  certificate: new Uint8Array([1]),
  chain: [],
  keyType: 'RSA',
  summary: {
    subjectName: 'Jane Doe',
    subject: 'CN=Jane Doe',
    issuerName: 'Jane Doe',
    issuer: 'CN=Jane Doe',
    serialNumber: '01',
    notBefore: new Date(Date.now() - 86_400_000).toISOString(),
    notAfter: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    selfSigned: true,
    keyDescription: 'RSA 2048'
  }
}

function signature(patch: Partial<PdfSignatureInfo> = {}): PdfSignatureInfo {
  return {
    kind: 'signature',
    fieldName: 'Signature1',
    pageIndex: 0,
    box: { x: 10, y: 10, width: 100, height: 40 },
    invisible: false,
    subFilter: 'ETSI.CAdES.detached',
    signerName: 'Jane Doe',
    certificate: CERT.summary,
    certificateCount: 1,
    signingTime: '2026-10-30T10:00:00.000Z',
    signingTimeSource: 'pdf',
    reason: 'Approved',
    byteRange: [0, 10, 20, 30],
    signedLength: 50,
    coversWholeDocument: true,
    laterRevisions: 0,
    digestValid: true,
    signatureValid: true,
    status: 'valid',
    problems: [],
    warnings: [],
    ...patch
  }
}

const sigField: FormFieldInfo = {
  name: 'Approver',
  type: 'signature',
  value: '',
  readOnly: false,
  widgets: [{ pageIndex: 1, box: { x: 50, y: 50, width: 150, height: 40 } }]
}

function signedDoc(signatures: PdfSignatureInfo[], formFields: FormFieldInfo[] = []): EditorDocument {
  const doc = makeDoc(2)
  doc.sources.src1 = { ...doc.sources.src1, signatures, formFields }
  return doc
}

/** A document "opened from a file" (as fileActions.openFileHere installs it). */
function open(doc: EditorDocument, filePath = '/docs/contract.pdf'): void {
  installDocument(doc, { filePath, fileName: filePath.split('/').pop()! })
}

beforeEach(() => {
  resetStores()
  resetFakeCore()
  resetFakePlatform()
  signing.signPdf.mockClear()
  useSigning.setState({ placing: null, removedInSession: null, warnedInSession: null })
})
afterEach(() => cleanup())

describe('Sign dialog', () => {
  it('unlocks a certificate (retrying a wrong password) and returns the request without the password', async () => {
    const user = userEvent.setup()
    open(signedDoc([], [sigField]))
    render(<DialogHost />)
    const result = openDialog<SignRequest>({ kind: 'sign' })
    const confirm = await screen.findByTestId('dialog-confirm')
    expect(screen.getByTestId('dialog')).toHaveAttribute('data-dialog', 'sign')
    expect(confirm).toBeDisabled()

    fake.openCertificateDialog.mockResolvedValueOnce({ id: 'cert-1', name: 'jane.p12' })
    await user.click(screen.getByTestId('sign-choose-certificate'))
    expect(await screen.findByTestId('sign-certificate-file')).toHaveTextContent('jane.p12')
    await user.type(screen.getByTestId('sign-password'), 'wrong')
    await user.click(screen.getByTestId('dialog-confirm'))
    expect(await screen.findByText(/Incorrect password/)).toBeInTheDocument()
    expect(fake.unlockCertificate).toHaveBeenLastCalledWith('cert-1', 'wrong')

    fake.unlockCertificate.mockResolvedValueOnce({ ok: true, certificate: CERT })
    await user.clear(screen.getByTestId('sign-password'))
    await user.type(screen.getByTestId('sign-password'), 'secret{Enter}')
    expect(await screen.findByTestId('sign-certificate')).toHaveTextContent('Jane Doe')
    expect(screen.getByTestId('sign-self-signed')).toBeInTheDocument()
    expect(screen.getByTestId('sign-display-name')).toHaveValue('Jane Doe')

    const select = screen.getByTestId('sign-field')
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      'Approver (page 2)',
      'New signature box — draw it on a page'
    ])
    expect(select).toHaveValue('Approver')
    await user.type(screen.getByTestId('sign-reason'), 'I agree')
    await user.type(screen.getByTestId('sign-location'), 'Vilnius')
    await user.click(screen.getByTestId('sign-show-date'))
    expect(screen.getByTestId('dialog-confirm')).toHaveTextContent('Sign and save as…')
    await user.click(screen.getByTestId('dialog-confirm'))

    const request = await result
    expect(request).toMatchObject({
      certificate: CERT,
      target: { kind: 'field', name: 'Approver' },
      reason: 'I agree',
      location: 'Vilnius',
      contactInfo: '',
      displayName: 'Jane Doe',
      showDate: false,
      image: null
    })
    expect(JSON.stringify(request)).not.toContain('secret')
    // Handed over to the signing step: not released yet.
    expect(fake.releaseCertificate).not.toHaveBeenCalled()
  })

  it('releases the certificate when cancelled', async () => {
    const user = userEvent.setup()
    open(makeDoc(1))
    render(<DialogHost />)
    const result = openDialog<SignRequest>({ kind: 'sign' })
    fake.openCertificateDialog.mockResolvedValueOnce({ id: 'cert-9', name: 'x.pfx' })
    await user.click(await screen.findByTestId('sign-choose-certificate'))
    await screen.findByTestId('sign-password')
    await user.click(screen.getByTestId('dialog-cancel'))
    expect(await result).toBeNull()
    expect(fake.releaseCertificate).toHaveBeenCalledWith('cert-9')
  })

  it('refuses expired certificates and warns that edits drop existing signatures', async () => {
    expect(certificateValidityProblem({ summary: { ...CERT.summary, notAfter: '2020-01-01T00:00:00Z' } })).toMatch(/expired/)
    const user = userEvent.setup()
    open(signedDoc([signature()]))
    editor().apply((d) => ({ ...d, pages: d.pages.slice(0, 1) }))
    render(<DialogHost />)
    void openDialog<SignRequest>({ kind: 'sign' })
    expect(await screen.findByTestId('sign-existing-removed')).toHaveTextContent('existing signature')
    fake.openCertificateDialog.mockResolvedValueOnce({ id: 'c', name: 'old.p12' })
    fake.unlockCertificate.mockResolvedValueOnce({ ok: true, certificate: { ...CERT, summary: { ...CERT.summary, notAfter: '2020-01-01T00:00:00Z' } } })
    await user.click(screen.getByTestId('sign-choose-certificate'))
    await user.type(await screen.findByTestId('sign-password'), 'pw{Enter}')
    expect(await screen.findByTestId('sign-certificate-invalid')).toHaveTextContent('expired')
    expect(screen.getByTestId('dialog-confirm')).toBeDisabled()
  })

  it('lists empty signature fields: existing unsigned ones and new ones, not signed or removed ones', () => {
    const doc = signedDoc([signature({ fieldName: 'Signed' })], [sigField, { ...sigField, name: 'Signed' }])
    doc.objects = [{ id: 'o1', type: 'field', fieldType: 'signature', name: 'Witness', pageId: 'p1', x: 0, y: 0, width: 100, height: 30 }]
    expect(emptySignatureFieldChoices(doc)).toEqual([
      { name: 'Approver', pageId: 'p2', pageNumber: 2 },
      { name: 'Witness', pageId: 'p1', pageNumber: 1 }
    ])
    expect(emptySignatureFieldChoices({ ...doc, pages: doc.pages.slice(0, 1) }).map((f) => f.name)).toEqual(['Witness'])
  })
})

describe('signing', () => {
  const request = (patch: Partial<SignRequest> = {}): SignRequest => ({
    certificate: CERT,
    target: { kind: 'new' },
    reason: 'OK',
    location: '',
    contactInfo: '',
    displayName: 'Jane',
    showDate: true,
    image: null,
    ...patch
  })

  it('signs the unchanged file itself, saves a "-signed" copy and opens it', async () => {
    const doc = signedDoc([])
    open(doc)
    fake.signWithCertificate.mockResolvedValueOnce(new Uint8Array([7]))
    expect(await signAndSave(request(), { pageIndex: 1, box: { x: 1, y: 2, width: 3, height: 4 } })).toBe(true)
    expect(core.exportDocument).not.toHaveBeenCalled()
    const [base, options] = signing.signPdf.mock.calls[0] as [Uint8Array, { target: unknown; reason?: string; signer: { sign(d: Uint8Array): Promise<Uint8Array> } }]
    expect(base).toBe(doc.sources.src1.bytes)
    expect(options).toMatchObject({ target: { pageIndex: 1, box: { x: 1, y: 2, width: 3, height: 4 } }, reason: 'OK' })
    await options.signer.sign(new Uint8Array([1]))
    expect(fake.signWithCertificate).toHaveBeenCalledWith('cert-1', new Uint8Array([1]))
    expect(fake.saveFileDialog).toHaveBeenCalledWith({ defaultPath: '/docs/contract-signed.pdf', bytes: new Uint8Array([9, 9, 9]) })
    expect(core.openDocument).toHaveBeenCalledWith(new Uint8Array([9, 9, 9]), 'contract-signed.pdf')
    expect(editor().filePath).toBe('/saved/contract-signed.pdf')
    expect(editor().dirty).toBe(false)
    expect(editor().notice?.text).toBe('Signed and saved contract-signed.pdf')
    expect(fake.releaseCertificate).toHaveBeenCalledWith('cert-1')
  })

  it('exports an edited document first', async () => {
    open(makeDoc(2))
    editor().apply((d) => ({ ...d, pages: d.pages.slice(0, 1) }))
    await signAndSave(request(), { fieldName: 'Approver' })
    expect(core.exportDocument).toHaveBeenCalled()
    expect(signing.signPdf.mock.calls[0][0]).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('reports signing errors and releases the certificate', async () => {
    open(makeDoc(1))
    signing.signPdf.mockRejectedValueOnce(new Error('Password-protected documents cannot be signed.'))
    expect(await signAndSave(request(), { fieldName: 'X' })).toBe(false)
    expect(editor().notice).toMatchObject({ kind: 'error', text: expect.stringContaining('Password-protected') })
    expect(fake.saveFileDialog).not.toHaveBeenCalled()
    expect(fake.releaseCertificate).toHaveBeenCalledWith('cert-1')
  })

  it('places a new signature box by dragging on a page; Escape cancels', async () => {
    const doc = makeDoc(1)
    open(doc)
    useSigning.setState({ placing: request() })
    const page = doc.pages[0]
    const { container } = render(
      <div style={{ position: 'relative', width: 600, height: 800 }}>
        <SignaturePlacementLayer page={page} scale={1} />
      </div>
    )
    const layer = screen.getByTestId('signature-placement')
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 30, clientY: 40 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 130, clientY: 80 })
    expect(container.querySelector('.signature-placement-box')).not.toBeNull()
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 130, clientY: 80 })
    await waitFor(() => expect(signing.signPdf).toHaveBeenCalled())
    const options = signing.signPdf.mock.calls[0][1] as { target: { pageIndex: number; box: { x: number; y: number; width: number; height: number } } }
    expect(options.target.pageIndex).toBe(0)
    // scale 1: one CSS px per point.
    expect(options.target.box.x).toBeCloseTo(30)
    expect(options.target.box.width).toBeCloseTo(100)
    await waitFor(() => expect(useSigning.getState().placing).toBeNull())

    useSigning.setState({ placing: request() })
    await act(async () => {})
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useSigning.getState().placing).toBeNull()
    expect(fake.releaseCertificate).toHaveBeenLastCalledWith('cert-1')
  })
})

describe('signatures panel and badge', () => {
  it('lists signatures with their status and summarizes the worst one in the badge', async () => {
    const user = userEvent.setup()
    open(
      signedDoc([
        signature(),
        signature({
          fieldName: 'Signature2',
          signerName: 'Mallory',
          status: 'invalid',
          digestValid: false,
          problems: ['The document has been altered since it was signed (the signed content does not match).'],
          pageIndex: 1
        })
      ])
    )
    render(
      <>
        <SignatureBadge />
        <SignaturesPanel />
      </>
    )
    const badge = screen.getByTestId('signature-badge')
    expect(badge).toHaveAttribute('data-status', 'invalid')
    expect(badge).toHaveTextContent('Invalid signature')
    const items = screen.getAllByTestId('signature-item')
    expect(items.map((i) => i.getAttribute('data-status'))).toEqual(['valid', 'invalid'])
    expect(items[0]).toHaveTextContent('Jane Doe')
    expect(items[0]).toHaveTextContent('Signature is valid')
    expect(items[0]).toHaveTextContent('Approved')
    expect(items[0]).toHaveTextContent('Covers the whole document.')
    expect(items[1]).toHaveTextContent('Signature is invalid')
    expect(items[1]).toHaveTextContent('altered since it was signed')
    expect(screen.getAllByTestId('signature-identity')[0]).toHaveTextContent('Identity not verified')

    await user.click(items[1].querySelector('button')!)
    expect(editor().currentPageId).toBe('p2')
    await user.click(badge)
    expect(editor().sidebarTab).toBe('signatures')
    expect(overallStatus([signature(), signature({ status: 'modified' })])).toBe('modified')
  })

  it('warns once when a signed document is edited', async () => {
    open(signedDoc([signature()]))
    render(
      <>
        <SignatureBadge />
        <SignaturesPanel />
      </>
    )
    expect(screen.queryByTestId('signatures-edited-warning')).toBeNull()
    act(() => editor().apply((d) => ({ ...d, pages: d.pages.slice(0, 1) })))
    expect(await screen.findByTestId('signatures-edited-warning')).toBeInTheDocument()
    expect(editor().notice?.text).toMatch(/digitally signed/)
    act(() => editor().clearNotice())
    act(() => editor().apply((d) => ({ ...d, objects: [] })))
    expect(editor().notice).toBeNull()
  })
})

describe('saving signed documents', () => {
  it('saves an unchanged signed file byte for byte (Save As)', async () => {
    const doc = signedDoc([signature()])
    open(doc)
    expect(await saveAs()).toBe(true)
    expect(core.exportDocument).not.toHaveBeenCalled()
    expect(fake.saveFileDialog.mock.calls[0][0].bytes).toBe(doc.sources.src1.bytes)
  })

  it('asks before saving changes over a signed file and offers a copy', async () => {
    const user = userEvent.setup()
    open(signedDoc([signature()]))
    editor().apply((d) => ({ ...d, pages: d.pages.slice(0, 1) }))
    render(<DialogHost />)

    // Cancel: nothing is written.
    let saving = save()
    expect(await screen.findByTestId('dialog')).toHaveTextContent('digitally signed')
    await user.click(screen.getByTestId('dialog-cancel'))
    expect(await saving).toBe(false)
    expect(fake.writeFile).not.toHaveBeenCalled()

    // Save as copy.
    saving = save()
    await user.click(await screen.findByText('Save as copy…'))
    expect(await saving).toBe(true)
    expect(fake.writeFile).not.toHaveBeenCalled()
    expect(fake.saveFileDialog).toHaveBeenCalledTimes(1)
    expect(core.exportDocument).toHaveBeenCalled()
    // The window now shows the copy, which has no signatures.
    expect(useSigning.getState().removedInSession).toBe(editor().docSession)
    render(<SignatureBadge />)
    expect(screen.queryByTestId('signature-badge')).toBeNull()
  })

  it('can save over the signed file, removing its signatures', async () => {
    const user = userEvent.setup()
    open(signedDoc([signature()]))
    editor().apply((d) => ({ ...d, pages: d.pages.slice(0, 1) }))
    render(<DialogHost />)
    const saving = save()
    await user.click(await screen.findByText('Save and remove signatures'))
    expect(await saving).toBe(true)
    expect(fake.writeFile).toHaveBeenCalledWith('/docs/contract.pdf', new Uint8Array([1, 2, 3]))
    // No second warning: the file has no signatures anymore.
    editor().apply((d) => ({ ...d, objects: [] }))
    await save()
    expect(screen.queryByTestId('dialog')).toBeNull()
  })
})
