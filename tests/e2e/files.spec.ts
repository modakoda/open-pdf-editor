/** File access through window.desktop: dialogs, the per-window path allowlist and writes. */
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyFixture, dialogCalls, expect, fixturePath, makeTempDir, mockMessageBox, mockOpenDialog, mockSaveDialog, test } from './helpers'

const bytesOf = (text: string) => Array.from(Buffer.from(text))

test.describe('file access', () => {
  test('openPdfDialog returns the chosen files with their bytes', async ({ launch }) => {
    const { app, page } = await launch()
    const pdf = await fixturePath('text-3pages.pdf')
    await mockOpenDialog(app, [pdf])
    const files = await page.evaluate(async () => {
      const result = await window.desktop!.openPdfDialog()
      return result.map((f) => ({
        path: f.path,
        name: f.name,
        isBytes: f.bytes instanceof Uint8Array,
        size: f.bytes.length,
        head: String.fromCharCode(...f.bytes.slice(0, 5))
      }))
    })
    expect(files).toEqual([{ path: pdf, name: 'text-3pages.pdf', isBytes: true, size: statSync(pdf).size, head: '%PDF-' }])
    const [call] = await dialogCalls(app, 'showOpenDialog')
    expect(JSON.stringify(call.options.filters)).toContain('pdf')
    expect(call.options.properties).toEqual(['openFile'])
  })

  test('openPdfDialog supports multiple files and cancel', async ({ launch }) => {
    const { app, page } = await launch()
    const a = await fixturePath('text-3pages.pdf')
    const b = await fixturePath('form.pdf')
    await mockOpenDialog(app, [a, b])
    const names = await page.evaluate(async () =>
      (await window.desktop!.openPdfDialog({ multiple: true, title: 'Insert' })).map((f) => f.name)
    )
    expect(names).toEqual(['text-3pages.pdf', 'form.pdf'])
    expect((await dialogCalls(app, 'showOpenDialog'))[0].options.properties).toContain('multiSelections')
    await mockOpenDialog(app, null)
    expect(await page.evaluate(() => window.desktop!.openPdfDialog())).toEqual([])
  })

  test('openImageDialog filters PNG/JPEG and returns null when cancelled', async ({ launch }) => {
    const { app, page } = await launch()
    const dir = makeTempDir()
    const png = join(dir, 'dot.png')
    writeFileSync(
      png,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
    )
    await mockOpenDialog(app, [png])
    const image = await page.evaluate(async () => {
      const f = await window.desktop!.openImageDialog()
      return f && { name: f.name, size: f.bytes.length }
    })
    expect(image).toEqual({ name: 'dot.png', size: statSync(png).size })
    const filters = JSON.stringify((await dialogCalls(app, 'showOpenDialog'))[0].options.filters)
    expect(filters).toContain('png')
    expect(filters).toContain('jpg')
    await mockOpenDialog(app, null)
    expect(await page.evaluate(() => window.desktop!.openImageDialog())).toBeNull()
  })

  test('readFile is denied for paths the user did not open', async ({ launch }) => {
    const { app, page } = await launch()
    const pdf = await fixturePath('form.pdf')
    const denied = await page.evaluate(async (p) => {
      try {
        await window.desktop!.readFile(p)
        return 'read'
      } catch (e) {
        return String((e as Error).message)
      }
    }, pdf)
    expect(denied).toMatch(/denied/i)
    const relative = await page.evaluate(async () => {
      try {
        await window.desktop!.readFile('form.pdf')
        return 'read'
      } catch (e) {
        return String((e as Error).message)
      }
    })
    expect(relative).toMatch(/invalid/i)
    // After the user picks it in a dialog the same path is readable.
    await mockOpenDialog(app, [pdf])
    await page.evaluate(() => window.desktop!.openPdfDialog())
    const size = await page.evaluate(async (p) => (await window.desktop!.readFile(p)).bytes.length, pdf)
    expect(size).toBe(statSync(pdf).size)
  })

  test('writeFile works for a granted path and fails otherwise', async ({ launch }) => {
    const { app, page } = await launch()
    const granted = await copyFixture('text-3pages.pdf')
    const other = join(makeTempDir(), 'other.pdf')
    await mockOpenDialog(app, [granted])
    await page.evaluate(() => window.desktop!.openPdfDialog())
    await page.evaluate(
      async ({ p, bytes }) => window.desktop!.writeFile(p, new Uint8Array(bytes)),
      { p: granted, bytes: bytesOf('%PDF-1.7 saved') }
    )
    expect(readFileSync(granted, 'utf8')).toBe('%PDF-1.7 saved')
    const result = await page.evaluate(
      async ({ p, bytes }) => {
        try {
          await window.desktop!.writeFile(p, new Uint8Array(bytes))
          return 'written'
        } catch (e) {
          return String((e as Error).message)
        }
      },
      { p: other, bytes: bytesOf('nope') }
    )
    expect(result).toMatch(/denied/i)
    expect(existsSync(other)).toBe(false)
  })

  test('saving through a symlink updates the target and keeps the link', async ({ launch }) => {
    const { app, page } = await launch()
    test.skip((await app.evaluate(() => process.platform)) === 'win32', 'symlinks need extra privileges on Windows')
    const dir = makeTempDir()
    const real = await copyFixture('text-3pages.pdf', dir, 'real.pdf')
    const link = join(dir, 'link.pdf')
    symlinkSync(real, link)
    await mockOpenDialog(app, [link])
    await page.evaluate(() => window.desktop!.openPdfDialog())
    await page.evaluate(({ p, bytes }) => window.desktop!.writeFile(p, new Uint8Array(bytes)), {
      p: link,
      bytes: bytesOf('%PDF-1.7 via link')
    })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('%PDF-1.7 via link')
    // No temp files left behind next to either name.
    expect(readdirSync(dir).sort()).toEqual(['link.pdf', 'real.pdf'])
  })

  test('saving a hard-linked file updates every name; permissions are kept', async ({ launch }) => {
    const { app, page } = await launch()
    const platform = await app.evaluate(() => process.platform)
    const dir = makeTempDir()
    const a = await copyFixture('text-3pages.pdf', dir, 'a.pdf')
    const b = join(dir, 'b.pdf')
    linkSync(a, b)
    if (platform !== 'win32') chmodSync(a, 0o640)
    await mockOpenDialog(app, [b])
    await page.evaluate(() => window.desktop!.openPdfDialog())
    await page.evaluate(({ p, bytes }) => window.desktop!.writeFile(p, new Uint8Array(bytes)), {
      p: b,
      bytes: bytesOf('%PDF-1.7 linked')
    })
    expect(readFileSync(a, 'utf8')).toBe('%PDF-1.7 linked')
    expect(readFileSync(b, 'utf8')).toBe('%PDF-1.7 linked')
    expect(statSync(a).ino).toBe(statSync(b).ino)
    if (platform !== 'win32') {
      // A normal (single-link) file is replaced atomically but keeps its mode.
      const c = await copyFixture('text-3pages.pdf', dir, 'c.pdf')
      chmodSync(c, 0o604)
      await mockOpenDialog(app, [c])
      await page.evaluate(() => window.desktop!.openPdfDialog())
      await page.evaluate(({ p, bytes }) => window.desktop!.writeFile(p, new Uint8Array(bytes)), {
        p: c,
        bytes: bytesOf('%PDF-1.7 mode')
      })
      expect(readFileSync(c, 'utf8')).toBe('%PDF-1.7 mode')
      expect(statSync(c).mode & 0o777).toBe(0o604)
      expect(statSync(a).mode & 0o777).toBe(0o640)
    }
  })

  test('saveFileDialog writes the file, appends .pdf and grants the path', async ({ launch }) => {
    const { app, page } = await launch()
    const dir = makeTempDir()
    await mockSaveDialog(app, join(dir, 'exported'))
    const saved = await page.evaluate(
      async (bytes) => window.desktop!.saveFileDialog({ defaultPath: 'report.pdf', bytes: new Uint8Array(bytes) }),
      bytesOf('%PDF-1.7 exported')
    )
    expect(saved).toBe(join(dir, 'exported.pdf'))
    expect(readFileSync(join(dir, 'exported.pdf'), 'utf8')).toBe('%PDF-1.7 exported')
    const [call] = await dialogCalls(app, 'showSaveDialog')
    expect(call.options.defaultPath).toBe('report.pdf')
    expect(JSON.stringify(call.options.filters)).toContain('pdf')
    // The saved path can now be written by Save.
    await page.evaluate(
      async ({ p, bytes }) => window.desktop!.writeFile(p, new Uint8Array(bytes)),
      { p: saved!, bytes: bytesOf('%PDF-1.7 again') }
    )
    expect(readFileSync(saved!, 'utf8')).toBe('%PDF-1.7 again')
    await mockSaveDialog(app, null)
    expect(
      await page.evaluate(() => window.desktop!.saveFileDialog({ defaultPath: 'x.pdf', bytes: new Uint8Array([1]) }))
    ).toBeNull()
  })

  test('saveFileDialog asks before replacing a file it appended .pdf to', async ({ launch }) => {
    const { app, page } = await launch()
    const dir = makeTempDir()
    writeFileSync(join(dir, 'taken.pdf'), 'original')
    await mockSaveDialog(app, join(dir, 'taken'))
    await mockMessageBox(app, 1) // Cancel
    const result = await page.evaluate(() =>
      window.desktop!.saveFileDialog({ defaultPath: 'taken.pdf', bytes: new Uint8Array([37, 80, 68, 70]) })
    )
    expect(result).toBeNull()
    expect(readFileSync(join(dir, 'taken.pdf'), 'utf8')).toBe('original')
    await mockMessageBox(app, 0) // Replace
    const replaced = await page.evaluate(() =>
      window.desktop!.saveFileDialog({ defaultPath: 'taken.pdf', bytes: new Uint8Array([37, 80, 68, 70]) })
    )
    expect(replaced).toBe(join(dir, 'taken.pdf'))
    expect(readFileSync(join(dir, 'taken.pdf'), 'utf8')).toBe('%PDF')
  })

  test('saveFilesToFolder writes every file and keeps existing ones', async ({ launch }) => {
    const { app, page } = await launch()
    const dir = makeTempDir()
    writeFileSync(join(dir, 'part-1.pdf'), 'existing')
    await mockOpenDialog(app, [dir])
    await mockMessageBox(app, 0) // Keep Both
    const folder = await page.evaluate(() =>
      window.desktop!.saveFilesToFolder([
        { name: 'part-1.pdf', bytes: new Uint8Array([49]) },
        { name: 'part-2.pdf', bytes: new Uint8Array([50]) },
        { name: '../escape.pdf', bytes: new Uint8Array([51]) },
        { name: 'part-2.pdf', bytes: new Uint8Array([52]) }
      ])
    )
    expect(folder).toBe(dir)
    expect(readFileSync(join(dir, 'part-1.pdf'), 'utf8')).toBe('existing')
    expect(readFileSync(join(dir, 'part-1 (2).pdf'), 'utf8')).toBe('1')
    expect(readFileSync(join(dir, 'part-2.pdf'), 'utf8')).toBe('2')
    expect(readFileSync(join(dir, 'escape.pdf'), 'utf8')).toBe('3')
    expect(readFileSync(join(dir, 'part-2 (2).pdf'), 'utf8')).toBe('4')
    expect(existsSync(join(dir, '..', 'escape.pdf'))).toBe(false)
    const [box] = await dialogCalls(app, 'showMessageBox')
    expect(box.options.buttons).toEqual(['Keep Both', 'Replace', 'Cancel'])
  })

  test('a file dropped/picked in the page becomes readable via getPathForFile', async ({ launch }) => {
    const { page } = await launch()
    const pdf = await fixturePath('rotated.pdf')
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'e2e-file'
      input.style.display = 'none'
      document.body.appendChild(input)
    })
    await page.setInputFiles('#e2e-file', pdf)
    const result = await page.evaluate(async () => {
      const input = document.getElementById('e2e-file') as HTMLInputElement
      const file = input.files![0]
      const path = window.desktop!.getPathForFile(file)
      const opened = path ? await window.desktop!.readFile(path) : null
      input.remove()
      return { path, size: opened?.bytes.length, synthetic: window.desktop!.getPathForFile(new File(['x'], 'x.pdf')) }
    })
    expect(result).toEqual({ path: pdf, size: statSync(pdf).size, synthetic: null })
  })
})
