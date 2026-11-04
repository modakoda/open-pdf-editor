/**
 * Update check in a packaged app with the real (bundled) electron-updater, against a feed served
 * by the test (OPE_E2E_UPDATER=real with OPE_UPDATE_FEED_URL): the build can read update metadata
 * and, being unsigned / unpacked, offers the download instead of updating itself. Skipped unless
 * OPE_PACKAGED_APP points to the packaged executable (see packaged.spec.ts).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { clickMenuItem, expect, test } from './helpers'

const executablePath = process.env.OPE_PACKAGED_APP ? resolve(process.env.OPE_PACKAGED_APP) : undefined

/** Serves latest*.yml announcing `version`; records the requested paths. */
async function startFeed(version: string): Promise<{ url: string; requests: string[]; server: Server }> {
  const requests: string[] = []
  const file = `open-pdf-editor-${version}-update.zip`
  const sha512 = Buffer.alloc(64, 1).toString('base64')
  const body = [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    '    size: 1024',
    `path: ${file}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-30T00:00:00.000Z'",
    ''
  ].join('\n')
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    requests.push(path)
    if (/^\/latest[\w-]*\.yml$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'text/yaml' })
      res.end(body)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/`, requests, server }
}

test.describe('packaged app updates', () => {
  test.skip(!executablePath, 'set OPE_PACKAGED_APP to the packaged executable')

  test('reads the update feed and links to the download', async ({ launch }) => {
    const feed = await startFeed('99.0.0')
    try {
      const { app, page } = await launch({
        executablePath,
        env: { OPE_E2E_UPDATER: 'real', OPE_UPDATE_FEED_URL: feed.url }
      })
      expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
      await clickMenuItem(app, 'menu:check-for-updates')
      const banner = page.getByTestId('update-banner')
      await expect(banner).toHaveAttribute('data-status', 'available', { timeout: 30_000 })
      await expect(banner).toContainText('A new version (99.0.0) is available')
      expect(feed.requests.some((p) => /^\/latest[\w-]*\.yml$/.test(p))).toBe(true)
      // Nothing was downloaded: this build only notifies.
      expect(feed.requests.filter((p) => p.endsWith('.zip'))).toEqual([])
    } finally {
      feed.server.close()
    }
  })
})
