/**
 * Smoke test for a packaged app (electron-builder output). Skipped unless OPE_PACKAGED_APP points
 * to the app executable, e.g.
 *   OPE_PACKAGED_APP="release/mac-arm64/Open PDF Editor.app/Contents/MacOS/Open PDF Editor" npx playwright test packaged
 *   OPE_PACKAGED_APP=release/linux-unpacked/open-pdf-editor   (Linux)
 *   OPE_PACKAGED_APP="release/win-unpacked/Open PDF Editor.exe" (Windows)
 */
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { derOctetString, derOid, derSequence, derSetOf } from '../../src/core/signatures/asn1'
import { createCertificate, createPkcs12, testKey } from '../core/signatures/certs'
import { copyFixture, expect, makeTempDir, mockOpenDialog, test, windowTitle } from './helpers'

const executablePath = process.env.OPE_PACKAGED_APP ? resolve(process.env.OPE_PACKAGED_APP) : undefined

test.describe('packaged app', () => {
  test.skip(!executablePath, 'set OPE_PACKAGED_APP to the packaged executable')

  test('starts, serves the renderer from app.asar and opens a PDF', async ({ launch }) => {
    const pdf = await copyFixture('text-3pages.pdf')
    const { app, page } = await launch({ executablePath, args: [pdf] })
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
    expect(page.url()).toBe('app://bundle/index.html')
    expect(await page.evaluate(() => typeof window.desktop?.openPdfDialog)).toBe('function')
    const worker = await page.evaluate(async () => {
      const res = await fetch(new URL('index.html', document.baseURI))
      return { status: res.status, type: res.headers.get('content-type') }
    })
    expect(worker).toEqual({ status: 200, type: 'text/html; charset=utf-8' })
    await expect(page.locator('[data-testid="page-count"]')).toHaveText('3', { timeout: 30_000 })
    await expect.poll(() => windowTitle(app, page)).toContain('text-3pages')
  })

  test('unlocks a signing certificate and signs in the main process', async ({ launch }) => {
    const { app, page } = await launch({ executablePath })
    const cert = createCertificate({ CN: 'Packaged Signer', key: testKey('ec') })
    const p12 = join(makeTempDir(), 'packaged.p12')
    writeFileSync(p12, createPkcs12({ key: cert.key, certs: [cert.der], password: 'pw' }))
    await mockOpenDialog(app, [p12])
    // CMS signed attributes: content-type and message-digest.
    const attrs = derSetOf([
      derSequence(derOid('1.2.840.113549.1.9.3'), derSetOf([derOid('1.2.840.113549.1.7.1')])),
      derSequence(derOid('1.2.840.113549.1.9.4'), derSetOf([derOctetString(new Uint8Array(32))]))
    ])
    const result = await page.evaluate(async (data) => {
      const file = await window.desktop!.openCertificateDialog!()
      const unlocked = await window.desktop!.unlockCertificate!(file!.id, 'pw')
      if (!unlocked.ok) return { error: unlocked.message }
      const signature = await window.desktop!.signWithCertificate!(file!.id, new Uint8Array(data))
      window.desktop!.releaseCertificate!(file!.id)
      return { name: unlocked.certificate.summary.subjectName, signatureByte: signature[0] }
    }, Array.from(attrs))
    expect(result).toEqual({ name: 'Packaged Signer', signatureByte: 0x30 })
  })
})
