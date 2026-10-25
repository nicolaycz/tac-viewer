// Graba el giro de 360° del cráneo cuadro a cuadro con Chrome headless.
//
// Requiere el servidor de desarrollo corriendo (npm run dev). Uso:
//   node scripts/render-360.mjs --url http://localhost:5173 --frames 360 --size 1080
// Después: ../.venv/bin/python ../pipeline/turntable.py  (arma el MP4)
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const url = args.url ?? 'http://localhost:5173'
const frames = Number(args.frames ?? 360)
const size = Number(args.size ?? 1080)
const out = path.resolve(here, args.out ?? '../../data/export/frames-360')
const query = new URLSearchParams({
  export: '360',
  size: String(size),
  hueso: args.hueso ?? '0.3',
  aire: args.aire ?? '1',
  elevacion: args.elevacion ?? '12',
})

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const executablePath = CHROME_PATHS.find((p) => existsSync(p))
if (!executablePath) throw new Error('No encontré Chrome. Define CHROME_PATH.')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  defaultViewport: { width: size, height: size, deviceScaleFactor: 1 },
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error('[página]', e.message))
  await page.goto(`${url}/?${query}`, { waitUntil: 'networkidle0', timeout: 120_000 })
  await page.waitForFunction(() => window.__tac360?.ready, { timeout: 120_000 })

  const t0 = Date.now()
  for (let i = 0; i < frames; i++) {
    const dataUrl = await page.evaluate((i, n) => window.__tac360.render(i, n), i, frames)
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    await writeFile(path.join(out, `${String(i).padStart(4, '0')}.png`), png)
    if ((i + 1) % 45 === 0) console.log(`  ${i + 1}/${frames} cuadros (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  }
  console.log(`Listo: ${frames} cuadros en ${out}`)
} finally {
  await browser.close()
}
