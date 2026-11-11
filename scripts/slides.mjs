#!/usr/bin/env node
// Create, check and export promptcut HTML slide decks. Uses only Node.js built-in modules.
//
// Usage:
//   node slides.mjs new    --out <deck.html> --title "<title>" [--ratio 16:9|4:3] [--lang en]
//   node slides.mjs check  --file <deck.html> [--render] [--fix-runtime]
//   node slides.mjs export --file <deck.html> --format png|pdf|pptx|sheet [--out <path>] [--scale 2|video]
//   node slides.mjs video-plan --file <deck.html> --uploads <upload-results.json> --out <ops.json> [--seconds 4] [--notes-as-captions | --captions <captions.json>] [--font vimo://<id>]
//   node slides.mjs open   --file <deck.html>
//
// Prints one JSON object. Rendering (check --render, export) needs Google Chrome, Microsoft Edge, Chromium or
// Brave. Set PROMPTCUT_BROWSER to the browser's program file to choose one.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildPptx } from './slides-pptx.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_FILE = path.join(HERE, 'slides-runtime.js')
export const RATIOS = { '16:9': [1280, 720], '4:3': [1024, 768] }
export const VIDEO_HEIGHT = 1080
const RUNTIME_START = /<!-- promptcut-slides-runtime v(\d+)[^>]*-->/
const RUNTIME_END = '<!-- /promptcut-slides-runtime -->'
const BROWSER_TIMEOUT_MS = 90_000

// ---------- arguments ----------

const FLAGS = new Set(['--render', '--fix-runtime', '--notes-as-captions', '--help', '-h'])
const OPTIONS = new Set(['--out', '--file', '--title', '--ratio', '--lang', '--format', '--scale', '--uploads', '--seconds', '--font', '--captions'])

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = { command }
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]
    if (FLAGS.has(name)) {
      args[name.replace(/^-+/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true
    } else if (OPTIONS.has(name)) {
      const value = rest[i + 1]
      if (value === undefined) throw new Error(`${name} needs a value`)
      args[name.slice(2)] = value
      i++
    } else {
      throw new Error(`Unknown argument: ${name}`)
    }
  }
  return args
}

// ---------- runtime ----------

export function runtimeVersion(source = fs.readFileSync(RUNTIME_FILE, 'utf8')) {
  const match = /var VERSION = '(\d+)'/.exec(source)
  if (!match) throw new Error('slides-runtime.js has no VERSION')
  return match[1]
}

export function runtimeBlock() {
  const source = fs.readFileSync(RUNTIME_FILE, 'utf8')
  if (source.includes('</script')) throw new Error('slides-runtime.js must not contain a closing script tag')
  const version = runtimeVersion(source)
  return `<!-- promptcut-slides-runtime v${version}: the slide viewer. Do not edit; slides.mjs check --fix-runtime replaces it. -->\n<script>\n${source.trim()}\n</script>\n${RUNTIME_END}`
}

function findRuntime(html) {
  const start = RUNTIME_START.exec(html)
  if (!start) return null
  const endIndex = html.indexOf(RUNTIME_END, start.index)
  if (endIndex === -1) return null
  return { start: start.index, end: endIndex + RUNTIME_END.length, version: start[1] }
}

export function replaceRuntime(html) {
  const block = runtimeBlock()
  const found = findRuntime(html)
  if (found) return html.slice(0, found.start) + block + html.slice(found.end)
  const head = html.search(/<\/head>/i)
  if (head === -1) throw new Error('The deck has no </head> tag to put the runtime before')
  return `${html.slice(0, head)}${block}\n${html.slice(head)}`
}

function withoutRuntime(html) {
  const found = findRuntime(html)
  return found ? html.slice(0, found.start) + html.slice(found.end) : html
}

// ---------- new ----------

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function newDeck({ title, ratio = '16:9', lang = 'en' }) {
  if (!RATIOS[ratio]) throw new Error('--ratio must be 16:9 or 4:3')
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new Error('--lang must be a language tag such as en or zh-CN')
  const [w, h] = RATIOS[ratio]
  const safeTitle = escapeHtml(title)
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<!-- Fonts: at most two Google Fonts families, only the weights you use. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap">
<style>
/* Every slide is a fixed ${w} x ${h} px canvas. Use px, never vw/vh. Start every selector with .pc-slide or your own class. */
.pc-deck {
  --ink: #111827;
  --paper: #ffffff;
  --accent: #2563eb;
  --muted: #6b7280;
}
.pc-slide {
  padding: 72px 88px;
  background: var(--paper);
  color: var(--ink);
  font-family: "Inter", system-ui, sans-serif;
}
.pc-slide *, .pc-slide *::before, .pc-slide *::after { box-sizing: border-box; }
.pc-slide h1, .pc-slide h2, .pc-slide p { margin: 0; }

.s-cover { display: flex; flex-direction: column; justify-content: center; gap: 24px; }
.s-cover h1 { font-size: 72px; font-weight: 800; line-height: 1.05; letter-spacing: -0.02em; }
.s-cover p { font-size: 26px; color: var(--muted); }
</style>
${runtimeBlock()}
</head>
<body>
<div class="pc-deck" data-ratio="${ratio}">

<section class="pc-slide s-cover" data-notes="">
  <h1 data-animate="fade-up">${safeTitle}</h1>
  <p data-animate="fade-up" data-delay="150">Subtitle</p>
</section>

<!-- next-slide -->
</div>
</body>
</html>
`
}

// ---------- static check ----------

function attr(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!match) return null
  return match[2] ?? match[3] ?? match[4] ?? ''
}

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
    const lower = code.toLowerCase()
    if (lower[0] === '#') {
      const n = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10)
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : all
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[lower]
  })
}

function hasClass(tag, name) {
  const value = attr(tag, 'class')
  return value !== null && value.split(/\s+/).includes(name)
}

export function listSlides(html) {
  const body = withoutRuntime(html).replace(/<!--[\s\S]*?-->/g, '')
  const slides = []
  for (const match of body.matchAll(/<section\b[^>]*>/gi)) {
    const tag = match[0]
    if (!hasClass(tag, 'pc-slide')) continue
    const notes = attr(tag, 'data-notes')
    const seconds = attr(tag, 'data-seconds')
    slides.push({
      num: slides.length + 1,
      id: attr(tag, 'id'),
      notes: notes === null ? '' : decodeEntities(notes).trim(),
      seconds: seconds === null || seconds.trim() === '' ? null : Number(seconds),
    })
  }
  return slides
}

export function deckInfo(html) {
  const clean = withoutRuntime(html).replace(/<!--[\s\S]*?-->/g, '')
  let ratio = null
  let deckCount = 0
  for (const match of clean.matchAll(/<(div|main)\b[^>]*>/gi)) {
    if (!hasClass(match[0], 'pc-deck')) continue
    deckCount++
    if (deckCount === 1) ratio = attr(match[0], 'data-ratio')
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean)
  return { deckCount, ratio, title: title ? decodeEntities(title[1]).trim() : '' }
}

const VIEWPORT_UNIT = /(?<![\w-])-?\d*\.?\d+(vw|vh|vmin|vmax|dvh|svh|lvh|dvw|svw|lvw)\b/i

export function lintCss(css) {
  const issues = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const unit = VIEWPORT_UNIT.exec(text)
  if (unit) issues.push({ level: 'error', message: `Viewport unit "${unit[0].trim()}" in the deck's CSS. Slides are a fixed canvas, so use px.` })
  // Walk top-level rules and rules inside @media/@supports, skipping @keyframes, @font-face and @page bodies.
  const selectors = []
  let depth = 0
  let buffer = ''
  const skipStack = []
  for (const ch of text) {
    if (ch === '{') {
      const prelude = buffer.trim()
      buffer = ''
      const skipping = skipStack.includes(true)
      const isAt = prelude.startsWith('@')
      const skipBody = /^@(-webkit-)?(keyframes|font-face|page|property|counter-style|font-feature-values)/i.test(prelude)
      if (!skipping && !isAt && prelude) selectors.push({ prelude, depth })
      if (!skipping && /^@media/i.test(prelude) && /(max|min)-(width|height)|orientation/i.test(prelude)) {
        issues.push({ level: 'warning', message: `Responsive media query "${prelude}". Slides never change size, so it has no useful effect.` })
      }
      skipStack.push(skipping || skipBody)
      depth++
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1)
      skipStack.pop()
      buffer = ''
    } else if (ch === ';' && depth === 0) {
      buffer = ''
    } else {
      buffer += ch
    }
  }
  const unscoped = new Set()
  for (const { prelude } of selectors) {
    for (const raw of prelude.split(',')) {
      const selector = raw.trim()
      if (!selector) continue
      if (/^(:root|\.|#|\[)/.test(selector)) continue
      unscoped.add(selector)
    }
  }
  if (unscoped.size) {
    const list = [...unscoped].slice(0, 6).join(', ')
    issues.push({ level: 'warning', message: `Unscoped selectors (${list}${unscoped.size > 6 ? ', ...' : ''}) also style the viewer's controls. Start each selector with .pc-slide or a class of your own.` })
  }
  return issues
}

function slideSizeRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of text.matchAll(/(^|})\s*\.pc-slide\s*\{([^}]*)\}/g)) {
    if (/(^|;|\s)(width|height|min-height|max-height|min-width|max-width)\s*:/i.test(match[2])) return true
  }
  return false
}

const LOCAL_REF_ATTRS = /<(img|source|video|audio|link|script|image|use|track|iframe|embed)\b[^>]*>/gi

export function localReferences(html) {
  const clean = withoutRuntime(html).replace(/<!--[\s\S]*?-->/g, '')
  const refs = new Set()
  for (const match of clean.matchAll(LOCAL_REF_ATTRS)) {
    const tag = match[0]
    for (const name of ['src', 'href', 'poster', 'xlink:href']) {
      const value = attr(tag, name.replace(':', '\\:'))
      if (value) refs.add(decodeEntities(value).trim())
    }
    const srcset = attr(tag, 'srcset')
    if (srcset) for (const part of decodeEntities(srcset).split(',')) refs.add(part.trim().split(/\s+/)[0])
  }
  for (const match of clean.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    refs.add(decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim())
  }
  return [...refs].filter(ref => ref && !/^(https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/|about:)/i.test(ref))
}

export function staticCheck(html, deckPath) {
  const errors = []
  const warnings = []
  const info = deckInfo(html)
  if (info.deckCount === 0) errors.push('No <div class="pc-deck"> wrapper. Put every slide inside it.')
  if (info.deckCount > 1) errors.push('More than one pc-deck wrapper. Use one per file.')
  if (info.deckCount && !RATIOS[info.ratio]) errors.push(`data-ratio on pc-deck must be "16:9" or "4:3" (found ${info.ratio === null ? 'none' : `"${info.ratio}"`}).`)
  const slides = listSlides(html)
  if (!slides.length) errors.push('No slides. Each slide is a <section class="pc-slide"> inside pc-deck.')
  const badSeconds = slides.filter(s => s.seconds !== null && !(s.seconds >= 0.5 && s.seconds <= 600)).map(s => s.num)
  if (badSeconds.length) errors.push(`data-seconds must be a number of seconds from 0.5 to 600 (slides ${badSeconds.join(', ')}).`)
  const noNotes = slides.filter(s => !s.notes).map(s => s.num)
  if (noNotes.length) warnings.push(`Slides without speaker notes (data-notes): ${noNotes.join(', ')}.`)

  const runtime = findRuntime(html)
  const current = runtimeVersion()
  if (!runtime) errors.push('The viewer runtime is missing. Run check with --fix-runtime to add it.')
  else if (runtime.version !== current) errors.push(`The viewer runtime is version ${runtime.version}, current is ${current}. Run check with --fix-runtime to update it.`)

  const outside = withoutRuntime(html)
  if (/<!-- next-slide -->/.test(outside) && slides.length <= 1) warnings.push('The deck still looks like the starter file.')
  for (const match of outside.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(match[0], 'src') || ''
    const type = (attr(match[0], 'type') || '').toLowerCase()
    if (/^https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@/.test(src)) continue
    if (type === 'application/json' || type === 'application/ld+json') continue
    warnings.push(`Extra script${src ? ` (${src})` : ''}. Slides should be static HTML and CSS; scripts can fight the viewer and may not run in exports.`)
  }
  const css = [...outside.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n')
  const inline = [...outside.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map(m => m[1]).join(';')
  for (const issue of lintCss(css)) (issue.level === 'error' ? errors : warnings).push(issue.message)
  const inlineUnit = VIEWPORT_UNIT.exec(inline)
  if (inlineUnit) errors.push(`Viewport unit "${inlineUnit[0].trim()}" in a style attribute. Use px.`)
  if (slideSizeRules(css)) warnings.push('A .pc-slide rule sets width or height. The viewer sizes slides itself, so remove it.')
  if (/class\s*=\s*"[^"]*\bpc-play\b/.test(outside)) errors.push('Do not put pc-play in a class attribute. The viewer adds it when a slide is shown.')

  const missing = []
  const absolute = []
  const base = path.dirname(deckPath)
  for (const ref of localReferences(html)) {
    let file = ref.split(/[?#]/)[0]
    try { file = decodeURIComponent(file) } catch { /* keep raw */ }
    if (/^file:/i.test(ref) || path.isAbsolute(file) || /^[a-z]:[\\/]/i.test(file)) {
      absolute.push(ref)
      continue
    }
    if (!fs.existsSync(path.resolve(base, file))) missing.push(ref)
  }
  if (missing.length) errors.push(`Missing local files: ${missing.join(', ')}. Paths are relative to the deck file.`)
  if (absolute.length) warnings.push(`Absolute paths (${absolute.join(', ')}) break when the deck is moved or shared. Copy the files into the deck's assets folder and use ./assets/... paths.`)

  const renderable = info.deckCount === 1 && Boolean(RATIOS[info.ratio]) && slides.length > 0 && Boolean(runtime) && runtime.version === current
  return { ratio: info.ratio, title: info.title, slideCount: slides.length, slides, errors, warnings, renderable }
}

// ---------- browser ----------

export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    const apps = ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser', 'Google Chrome Canary']
    return apps.flatMap(app => [`/Applications/${app}.app/Contents/MacOS/${app}`, path.join(os.homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', app)])
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe']
    return roots.flatMap(root => rel.map(r => path.win32.join(root, r)))
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean)
  return [...dirs.flatMap(dir => names.map(name => path.join(dir, name))), '/snap/bin/chromium']
}

export function findBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.PROMPTCUT_BROWSER) {
    if (!exists(env.PROMPTCUT_BROWSER)) throw new Error(`PROMPTCUT_BROWSER is set to ${env.PROMPTCUT_BROWSER}, but that file does not exist`)
    return env.PROMPTCUT_BROWSER
  }
  const found = browserCandidates(platform, env).find(candidate => exists(candidate))
  if (!found) {
    throw new Error('No Chrome, Edge, Chromium or Brave browser found. Install Google Chrome, or set PROMPTCUT_BROWSER to the browser program file.')
  }
  return found
}

function browserArgs(extra, profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    '--run-all-compositor-stages-before-draw',
    '--allow-file-access-from-files',
    `--user-data-dir=${profileDir}`,
  ]
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
  return args.concat(extra)
}

function runBrowser(browser, extra, { capture = false } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-browser-'))
  return new Promise((resolve, reject) => {
    const child = spawn(browser, browserArgs(extra, profileDir), { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    let err = ''
    child.stdout.on('data', chunk => { if (capture) out.push(chunk) })
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-4000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), BROWSER_TIMEOUT_MS)
    const finish = fn => {
      clearTimeout(timer)
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
      fn()
    }
    child.on('error', error => finish(() => reject(new Error(`Could not start the browser: ${error.message}`))))
    child.on('close', code => finish(() => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`The browser exited with code ${code}${err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}`))
    }))
  })
}

async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function deckUrl(deckPath, hash) {
  return `${pathToFileURL(path.resolve(deckPath)).href}#${hash}`
}

export function parseReport(dom) {
  const matches = [...dom.matchAll(/<script type="application\/json" id="pc-report">([\s\S]*?)<\/script>/g)]
  if (!matches.length) return null
  return JSON.parse(matches[matches.length - 1][1])
}

async function renderCheck(deckPath, browser) {
  const dom = await runBrowser(browser, ['--virtual-time-budget=15000', '--dump-dom', deckUrl(deckPath, 'check')], { capture: true })
  const report = parseReport(dom)
  if (!report) throw new Error('The deck did not finish rendering, so no layout report was produced. Check that the viewer runtime is present and the HTML is valid.')
  return report
}

function summarizeRender(report) {
  const problems = []
  for (const slide of report.slides) {
    const parts = []
    if (slide.outside.length) parts.push(`${slide.outside.length} text block(s) past the slide edge`)
    if (slide.clipped.length) parts.push(`${slide.clipped.length} text block(s) cut off`)
    if (slide.overlaps.length) parts.push(`${slide.overlaps.length} overlapping text pair(s)`)
    if (slide.brokenImages.length) parts.push(`${slide.brokenImages.length} image(s) failed to load`)
    if (!slide.textBlocks && !slide.images) parts.push('no text or images found (blank slide?)')
    if (parts.length) problems.push(`Slide ${slide.num}: ${parts.join(', ')}`)
  }
  if (report.fonts.failed.length) problems.push(`Web fonts that did not load: ${report.fonts.failed.join(', ')}`)
  if (report.loadTimedOut) problems.push('Fonts or images were still loading after 8 seconds. Check the internet connection and the font and image links; the layout was measured with fallback fonts.')
  return problems
}

// ---------- commands ----------

function requireFile(args) {
  if (!args.file) throw new Error('--file is required')
  const file = path.resolve(args.file)
  if (!fs.existsSync(file)) throw new Error(`No such file: ${args.file}`)
  if (!/\.html?$/i.test(file)) throw new Error('--file must be an .html file')
  return file
}

function cmdNew(args) {
  if (!args.out) throw new Error('--out is required')
  if (!args.title) throw new Error('--title is required')
  const out = path.resolve(args.out)
  if (!/\.html$/i.test(out)) throw new Error('--out must end in .html')
  if (fs.existsSync(out)) throw new Error(`${args.out} already exists. Choose another name or edit the existing deck.`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, newDeck({ title: args.title, ratio: args.ratio || '16:9', lang: args.lang || 'en' }), { flag: 'wx' })
  return { success: true, file: out, ratio: args.ratio || '16:9', canvas: RATIOS[args.ratio || '16:9'] }
}

async function cmdCheck(args) {
  const file = requireFile(args)
  let html = fs.readFileSync(file, 'utf8')
  let runtimeUpdated = false
  if (args.fixRuntime) {
    const updated = replaceRuntime(html)
    if (updated !== html) {
      fs.writeFileSync(file, updated)
      html = updated
      runtimeUpdated = true
    }
  }
  const result = staticCheck(html, file)
  const output = {
    success: result.errors.length === 0,
    file,
    title: result.title,
    ratio: result.ratio,
    canvas: RATIOS[result.ratio] || null,
    slideCount: result.slideCount,
    errors: result.errors,
    warnings: result.warnings,
  }
  if (runtimeUpdated) output.runtimeUpdated = true
  if (args.render) {
    if (!result.renderable) {
      output.render = { skipped: 'Fix the errors about the deck structure or runtime first.' }
    } else {
      const report = await renderCheck(file, findBrowser())
      const problems = summarizeRender(report)
      output.render = { problems, fonts: report.fonts, slides: report.slides.filter(s => s.outside.length || s.clipped.length || s.overlaps.length || s.brokenImages.length) }
      if (report.slideCount !== result.slideCount) output.errors.push(`The browser found ${report.slideCount} slides but the file has ${result.slideCount}. Slides must be direct children of pc-deck.`)
      output.success = output.errors.length === 0
    }
  }
  return output
}

function defaultOut(file, format) {
  const dir = path.dirname(file)
  const name = path.basename(file).replace(/\.html?$/i, '')
  if (format === 'pdf') return path.join(dir, `${name}.pdf`)
  if (format === 'pptx') return path.join(dir, `${name}.pptx`)
  if (format === 'png') return path.join(dir, `${name}-png`)
  return fs.mkdtempSync(path.join(os.tmpdir(), `promptcut-sheets-${name.slice(0, 40)}-`))
}

async function screenshots(file, browser, ratio, count, scale, outDir, prefix, hashFor) {
  fs.mkdirSync(outDir, { recursive: true })
  const [w, h] = RATIOS[ratio]
  const items = Array.from({ length: count }, (_, i) => i + 1)
  return pool(items, Math.max(1, Math.min(4, os.cpus().length)), async n => {
    const target = path.join(outDir, `${prefix}-${String(n).padStart(2, '0')}.png`)
    fs.rmSync(target, { force: true })
    await runBrowser(browser, [
      '--virtual-time-budget=10000',
      `--window-size=${w},${h}`,
      `--force-device-scale-factor=${scale}`,
      `--screenshot=${target}`,
      deckUrl(file, hashFor(n)),
    ])
    if (!fs.existsSync(target)) throw new Error(`The browser did not save ${path.basename(target)}`)
    return target
  })
}

async function cmdExport(args) {
  const file = requireFile(args)
  const format = (args.format || '').toLowerCase()
  if (!['png', 'pdf', 'pptx', 'sheet'].includes(format)) throw new Error('--format must be png, pdf, pptx or sheet')
  const html = fs.readFileSync(file, 'utf8')
  const check = staticCheck(html, file)
  if (check.errors.length) return { success: false, file, errors: check.errors, warnings: check.warnings }
  // "video" renders slides 1080 px tall: 1920x1080 for 16:9, 1440x1080 for 4:3.
  const scale = args.scale === undefined ? (format === 'sheet' ? 1 : 2) : args.scale === 'video' ? VIDEO_HEIGHT / RATIOS[check.ratio][1] : Number(args.scale)
  if (!(scale >= 1 && scale <= 4)) throw new Error('--scale must be between 1 and 4, or video')
  const browser = findBrowser()
  const out = path.resolve(args.out || defaultOut(file, format))
  const base = { success: true, file, format, slideCount: check.slideCount, warnings: check.warnings }

  if (format === 'pdf') {
    if (!/\.pdf$/i.test(out)) throw new Error('--out must end in .pdf')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const replaced = fs.existsSync(out)
    fs.rmSync(out, { force: true })
    await runBrowser(browser, ['--virtual-time-budget=15000', '--no-pdf-header-footer', `--print-to-pdf=${out}`, deckUrl(file, 'print')])
    if (!fs.existsSync(out)) throw new Error('The browser did not save the PDF')
    return { ...base, output: out, bytes: fs.statSync(out).size, replaced }
  }
  if (format === 'png') {
    const files = await screenshots(file, browser, check.ratio, check.slideCount, scale, out, 'slide', n => `shot=${n}`)
    return { ...base, outputDir: out, files }
  }
  if (format === 'sheet') {
    const sheets = Math.ceil(check.slideCount / 4)
    const files = await screenshots(file, browser, check.ratio, sheets, scale, out, 'sheet', n => `sheet=${n}`)
    return { ...base, outputDir: out, files, note: 'Each sheet shows four slides in a 2x2 grid with slide numbers in the corner.' }
  }
  // pptx
  if (!/\.pptx$/i.test(out)) throw new Error('--out must end in .pptx')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-pptx-'))
  try {
    const pngs = await screenshots(file, browser, check.ratio, check.slideCount, scale, temp, 'slide', n => `shot=${n}`)
    const buffer = buildPptx({
      slides: pngs.map((png, i) => ({ png: fs.readFileSync(png), notes: check.slides[i]?.notes || '' })),
      ratio: RATIOS[check.ratio],
      title: check.title || path.basename(file, path.extname(file)),
    })
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const replaced = fs.existsSync(out)
    fs.writeFileSync(out, buffer)
    return { ...base, output: out, bytes: buffer.length, replaced, note: 'Each slide is a picture of the HTML slide, so its text is not editable in PowerPoint. Speaker notes are included.' }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

// Map uploaded slide images (slide-01.png ...) back to slide numbers.
export function slideUploads(uploads, count) {
  const list = Array.isArray(uploads) ? uploads : uploads?.results
  if (!Array.isArray(list)) throw new Error('--uploads must be the JSON printed by capcut-upload.mjs (an object with a "results" array)')
  const bySlide = new Map()
  for (const item of list) {
    const name = path.basename(String(item?.file_name || item?.file || ''))
    const match = /(?:^|[^0-9])(\d{1,3})\.(png|jpe?g|webp)$/i.exec(name)
    if (!match) continue
    const num = parseInt(match[1], 10)
    if (item.success === false || typeof item.uri !== 'string' || !item.uri) continue
    if (bySlide.has(num)) throw new Error(`Two uploads are for slide ${num}`)
    bySlide.set(num, item.uri)
  }
  const missing = []
  for (let n = 1; n <= count; n++) if (!bySlide.has(n)) missing.push(n)
  if (missing.length) throw new Error(`No uploaded image for slide(s) ${missing.join(', ')}. Upload the PNGs from export --format png and pass the upload results.`)
  return bySlide
}

// Captions sit a little above the bottom edge in a smaller size, so they don't cover slide content.
const SLIDE_CAPTION_STYLE = { position_y: -0.7, font_size: 10 }

export function videoPlan({ slides, ratio, uploads, seconds = 4, notesAsCaptions = false, captions = null, font = null }) {
  if (font !== null && !/^vimo:\/\/\d+$/.test(font)) throw new Error('--font must be a CapCut font stdraft_uri such as vimo://123')
  if (captions !== null) {
    if (!Array.isArray(captions) || captions.length !== slides.length) throw new Error(`--captions must be a JSON array with one entry per slide (${slides.length})`)
    for (const [i, text] of captions.entries()) {
      if (text !== null && typeof text !== 'string') throw new Error(`--captions entry ${i + 1} must be text or null`)
    }
  }
  if (!(seconds >= 0.5 && seconds <= 600)) throw new Error('--seconds must be from 0.5 to 600')
  const [w, h] = RATIOS[ratio]
  const width = Math.round((w * VIDEO_HEIGHT) / h)
  const bySlide = slideUploads(uploads, slides.length)
  const operations = []
  const cues = []
  let at = 0
  for (const slide of slides) {
    const duration = Math.round((slide.seconds ?? seconds) * 1000)
    const uri = bySlide.get(slide.num)
    operations.push({ op: 'add_image', source: uri.includes('://') ? uri : `tos://${uri.replace(/^\/+/, '')}`, start_ms: at, duration_ms: duration })
    const text = captions !== null ? (captions[slide.num - 1] || '') : notesAsCaptions ? slide.notes : ''
    if (text && text.trim()) cues.push({ start_ms: at, end_ms: at + duration, text: text.replace(/\s+/g, ' ').trim() })
    at += duration
  }
  if (cues.length) operations.push({ op: 'add_captions', cues, ...SLIDE_CAPTION_STYLE, ...(font ? { font } : {}) })
  return { width, height: VIDEO_HEIGHT, totalMs: at, operations }
}

function cmdVideoPlan(args) {
  const file = requireFile(args)
  if (!args.uploads) throw new Error('--uploads is required')
  if (!args.out) throw new Error('--out is required')
  const check = staticCheck(fs.readFileSync(file, 'utf8'), file)
  if (!RATIOS[check.ratio] || !check.slideCount) return { success: false, file, errors: check.errors }
  const uploads = JSON.parse(fs.readFileSync(path.resolve(args.uploads), 'utf8'))
  const plan = videoPlan({
    slides: check.slides,
    ratio: check.ratio,
    uploads,
    seconds: args.seconds === undefined ? 4 : Number(args.seconds),
    notesAsCaptions: Boolean(args.notesAsCaptions),
    captions: args.captions ? JSON.parse(fs.readFileSync(path.resolve(args.captions), 'utf8')) : null,
    font: args.font ?? null,
  })
  const out = path.resolve(args.out)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(plan.operations, null, 2)}\n`)
  return {
    success: true,
    file,
    ops: out,
    width: plan.width,
    height: plan.height,
    slideCount: check.slideCount,
    totalSeconds: plan.totalMs / 1000,
    next: `node stdraft.mjs new --width ${plan.width} --height ${plan.height} --out <draft.json>, then apply --ops ${path.basename(out)}`,
  }
}

function cmdOpen(args) {
  const file = requireFile(args)
  const url = pathToFileURL(file).href
  const [cmd, cmdArgs] =
    process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : ['xdg-open', [file]]
  const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  return { success: true, file, url, note: 'Opened in the default browser. Press P there for presenter view with notes.' }
}

const HELP = `Usage:
  node slides.mjs new    --out <deck.html> --title "<title>" [--ratio 16:9|4:3] [--lang en]
  node slides.mjs check  --file <deck.html> [--render] [--fix-runtime]
  node slides.mjs export --file <deck.html> --format png|pdf|pptx|sheet [--out <path>] [--scale 2|video]
  node slides.mjs video-plan --file <deck.html> --uploads <upload-results.json> --out <ops.json> [--seconds 4] [--notes-as-captions | --captions <captions.json>] [--font vimo://<id>]
  node slides.mjs open   --file <deck.html>`

export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help || !args.command || args.command === 'help') return { success: true, help: HELP }
  if (args.command === 'new') return cmdNew(args)
  if (args.command === 'check') return cmdCheck(args)
  if (args.command === 'export') return cmdExport(args)
  if (args.command === 'open') return cmdOpen(args)
  if (args.command === 'video-plan') return cmdVideoPlan(args)
  throw new Error(`Unknown command: ${args.command}\n${HELP}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (result && result.success === false) process.exitCode = 1
    })
    .catch(error => {
      process.stdout.write(`${JSON.stringify({ success: false, error: error.message }, null, 2)}\n`)
      process.exitCode = 1
    })
}
