/**
 * Digital signatures in the real app: signing with a PKCS#12 certificate (file dialog mocked),
 * verifying the saved file independently, the signatures panel, and the warning when a signed
 * document is edited.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { signPdf, verifyPdfSignatures } from '../../src/core/signatures'
import { loadPkcs12 } from '../../src/core/signatures/pkcs12'
import { createCertificate, createPkcs12, testKey } from '../core/signatures/certs'
import { copyFixture, expect, makeTempDir, mockOpenDialog, mockSaveDialog, test } from './helpers'

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`)
const PASSWORD = 'e2e-secret'

function writeCertificate(dir: string): string {
  const cert = createCertificate({ CN: 'E2E Signer', O: 'Open PDF Editor Tests', key: testKey('rsa') })
  const path = join(dir, 'signer.p12')
  writeFileSync(path, createPkcs12({ key: cert.key, certs: [cert.der], password: PASSWORD }))
  return path
}

async function expectPageCount(page: Page, count: number): Promise<void> {
  await expect(byTestId(page, 'page-count')).toHaveText(String(count), { timeout: 20_000 })
}

test.describe('digital signatures', () => {
  test('signs a PDF with a .p12 certificate; the saved file verifies', async ({ launch }) => {
    const dir = makeTempDir()
    const pdf = await copyFixture('text-3pages.pdf', dir)
    const original = readFileSync(pdf)
    const p12 = writeCertificate(dir)
    const out = join(dir, 'signed.pdf')
    const { app, page } = await launch({ args: [pdf] })
    await expectPageCount(page, 3)
    await expect(byTestId(page, 'signature-badge')).toHaveCount(0)

    await byTestId(page, 'btn-sign').click()
    const dialog = page.locator('[data-testid="dialog"][data-dialog="sign"]')
    await expect(dialog).toBeVisible()
    await mockOpenDialog(app, [p12])
    await byTestId(page, 'sign-choose-certificate').click()
    await expect(byTestId(page, 'sign-certificate-file')).toHaveText('signer.p12')

    await byTestId(page, 'sign-password').fill('wrong')
    await byTestId(page, 'dialog-confirm').click()
    await expect(dialog.locator('[data-testid="field-error"]')).toContainText('Incorrect password')
    await byTestId(page, 'sign-password').fill(PASSWORD)
    await byTestId(page, 'sign-password').press('Enter')
    await expect(byTestId(page, 'sign-certificate')).toContainText('E2E Signer')

    await expect(byTestId(page, 'sign-field')).toHaveValue('__new__')
    await byTestId(page, 'sign-reason').fill('Approved in e2e')
    await byTestId(page, 'sign-location').fill('Vilnius')
    await expect(byTestId(page, 'dialog-confirm')).toHaveText(/Place signature/)
    await byTestId(page, 'dialog-confirm').click()
    await expect(dialog).toHaveCount(0)

    const layer = page.locator('[data-testid="page"][data-page-index="0"] [data-testid="signature-placement"]')
    await expect(layer).toBeVisible()
    await mockSaveDialog(app, out)
    const area = (await layer.boundingBox())!
    await page.mouse.move(area.x + 60, area.y + 80)
    await page.mouse.down()
    await page.mouse.move(area.x + 200, area.y + 120, { steps: 4 })
    await page.mouse.move(area.x + 300, area.y + 150, { steps: 4 })
    await page.mouse.up()

    await expect(byTestId(page, 'notice')).toContainText('Signed and saved signed.pdf', { timeout: 20_000 })
    await expect(byTestId(page, 'signature-placement')).toHaveCount(0)

    // The saved file: the original bytes followed by an incremental update with a valid signature.
    const signed = new Uint8Array(readFileSync(out))
    expect(Buffer.from(signed.subarray(0, original.length)).equals(original)).toBe(true)
    const [sig] = await verifyPdfSignatures(signed)
    expect(sig).toMatchObject({
      status: 'valid',
      signerName: 'E2E Signer',
      reason: 'Approved in e2e',
      location: 'Vilnius',
      pageIndex: 0,
      coversWholeDocument: true,
      subFilter: 'ETSI.CAdES.detached'
    })

    // The window now shows the signed file with its signature.
    await expect(byTestId(page, 'signature-badge')).toHaveAttribute('data-status', 'valid')
    await byTestId(page, 'signature-badge').click()
    await expect(byTestId(page, 'signatures-panel')).toBeVisible()
    const item = byTestId(page, 'signature-item')
    await expect(item).toHaveAttribute('data-status', 'valid')
    await expect(item.locator('[data-testid="signature-signer"]')).toHaveText('E2E Signer')
    await expect(item.locator('[data-testid="signature-reason"]')).toHaveText('Approved in e2e')
    await expect(item.locator('[data-testid="signature-identity"]')).toHaveText('Identity not verified')
  })

  test('editing a signed document warns and saves the changes as a copy', async ({ launch }) => {
    const dir = makeTempDir()
    const p12 = writeCertificate(dir)
    const identity = await loadPkcs12(new Uint8Array(readFileSync(p12)), PASSWORD)
    const base = new Uint8Array(readFileSync(await copyFixture('text-3pages.pdf', dir)))
    const signedPath = join(dir, 'contract.pdf')
    const signedBytes = await signPdf(base, { signer: identity, target: { pageIndex: 0, box: { x: 72, y: 600, width: 200, height: 50 } } })
    writeFileSync(signedPath, signedBytes)

    const { app, page } = await launch({ args: [signedPath] })
    await expectPageCount(page, 3)
    await expect(byTestId(page, 'signature-badge')).toHaveAttribute('data-status', 'valid')

    await byTestId(page, 'btn-rotate-cw').click()
    await expect(byTestId(page, 'notice')).toContainText('digitally signed')
    await byTestId(page, 'btn-save').click()
    const confirm = page.locator('[data-testid="dialog"][data-dialog="confirm"]')
    await expect(confirm).toContainText('digitally signed')

    const copy = join(dir, 'contract-edited.pdf')
    await mockSaveDialog(app, copy)
    await byTestId(page, 'dialog-confirm').click()
    await expect(byTestId(page, 'notice')).toContainText('Saved contract-edited.pdf', { timeout: 20_000 })

    // The signed original is untouched; the copy has the change and no (broken) signatures.
    expect(Buffer.from(readFileSync(signedPath)).equals(Buffer.from(signedBytes))).toBe(true)
    expect(await verifyPdfSignatures(new Uint8Array(readFileSync(copy)))).toEqual([])
    await expect(byTestId(page, 'signature-badge')).toHaveCount(0)
  })
})
