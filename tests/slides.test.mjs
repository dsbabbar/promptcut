import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  browserCandidates,
  decodeEntities,
  deckInfo,
  findBrowser,
  lintCss,
  listSlides,
  localReferences,
  newDeck,
  parseArgs,
  parseReport,
  replaceRuntime,
  runtimeBlock,
  slideUploads,
  staticCheck,
  videoPlan,
} from '../scripts/slides.mjs'

const script = fileURLToPath(new URL('../scripts/slides.mjs', import.meta.url))
const runtimeFile = fileURLToPath(new URL('../scripts/slides-runtime.js', import.meta.url))

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-slides-'))
}

function deckWith(slidesHtml, { css = '', ratio = '16:9' } = {}) {
  return newDeck({ title: 'Test deck', ratio })
    .replace('</style>', `${css}\n</style>`)
    .replace(/<section class="pc-slide s-cover"[\s\S]*?<\/section>/, slidesHtml)
}

test('parses commands, options and flags', () => {
  assert.deepEqual(parseArgs(['check', '--file', 'a.html', '--render', '--fix-runtime']), { command: 'check', file: 'a.html', render: true, fixRuntime: true })
  assert.deepEqual(parseArgs(['video-plan', '--notes-as-captions', '--seconds', '3']), { command: 'video-plan', notesAsCaptions: true, seconds: '3' })
  assert.throws(() => parseArgs(['check', '--file']), /needs a value/)
  assert.throws(() => parseArgs(['check', '--bogus']), /Unknown argument/)
})

test('the runtime can be inlined in a script tag', () => {
  const source = fs.readFileSync(runtimeFile, 'utf8')
  assert.ok(!source.includes('</script'))
  assert.match(runtimeBlock(), /^<!-- promptcut-slides-runtime v\d+/)
})

test('a new deck passes the static check', () => {
  const dir = tempDir()
  const file = path.join(dir, 'deck.html')
  const html = newDeck({ title: 'Coffee & "cake" <report>', ratio: '4:3', lang: 'en-GB' })
  assert.match(html, /<title>Coffee &amp; &quot;cake&quot; &lt;report&gt;<\/title>/)
  const result = staticCheck(html, file)
  assert.deepEqual(result.errors, [])
  assert.equal(result.ratio, '4:3')
  assert.equal(result.slideCount, 1)
  assert.equal(result.renderable, true)
  assert.ok(result.warnings.some(w => /speaker notes/.test(w)))
  assert.throws(() => newDeck({ title: 'x', ratio: '21:9' }), /16:9 or 4:3/)
  assert.throws(() => newDeck({ title: 'x', lang: 'en"><script>' }), /language tag/)
})

test('lists slides with decoded notes and timing, ignoring comments and the runtime', () => {
  const html = deckWith(`
<!-- <section class="pc-slide">commented out</section> -->
<section class="pc-slide a" data-notes="Line one&#10;Tom &amp; Jerry" data-seconds="6">A</section>
<section class="other">not a slide</section>
<section id="s2" class='pc-slide b'>B</section>`)
  const slides = listSlides(html)
  assert.equal(slides.length, 2)
  assert.deepEqual(slides[0], { num: 1, id: null, notes: 'Line one\nTom & Jerry', seconds: 6 })
  assert.deepEqual(slides[1], { num: 2, id: 's2', notes: '', seconds: null })
  assert.equal(deckInfo(html).title, 'Test deck')
})

test('decodes HTML entities', () => {
  assert.equal(decodeEntities('a &lt;b&gt; &#39;c&#x27; &quot;d&quot; &amp;amp;'), 'a <b> \'c\' "d" &amp;')
})

test('flags viewport units, unscoped selectors and responsive queries', () => {
  const issues = lintCss(`
    :root { --x: 1px }
    .pc-slide h1 { font-size: 10vw }
    section { padding: 0 }
    body, .ok { margin: 0 }
    @keyframes spin { from { opacity: 0 } to { opacity: 1 } }
    @media (max-width: 600px) { .pc-slide p { color: red } div > p { color: blue } }
    @font-face { font-family: X; src: url(x.woff2) }`)
  const text = issues.map(i => `${i.level}: ${i.message}`).join('\n')
  assert.match(text, /error: Viewport unit "10vw"/)
  assert.match(text, /warning: Unscoped selectors \(section, body, div > p\)/)
  assert.match(text, /warning: Responsive media query/)
  assert.doesNotMatch(text, /from|to\b.*Unscoped/)
  assert.deepEqual(lintCss('.pc-slide { width: 100px } .a .b { color: red }'), [])
})

test('static check reports structure, runtime and file problems', () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'ok.png'), 'x')
  const file = path.join(dir, 'deck.html')
  const html = deckWith(
    `<section class="pc-slide" data-notes="n" data-seconds="0">
      <img src="./assets/ok.png"><img src="./assets/missing.png"><img src="https://example.com/a.png">
      <div style="background:url('assets/also-missing.jpg'); height: 50vh"></div>
      <img src="/Users/me/photo.png"><script>alert(1)</script>
    </section>`,
    { css: '.pc-slide { height: 800px }' },
  )
  const result = staticCheck(html, file)
  const errors = result.errors.join('\n')
  const warnings = result.warnings.join('\n')
  assert.match(errors, /Missing local files: \.\/assets\/missing\.png, assets\/also-missing\.jpg/)
  assert.match(errors, /Viewport unit "50vh" in a style attribute/)
  assert.match(errors, /data-seconds must be/)
  assert.match(warnings, /Absolute paths \(\/Users\/me\/photo\.png\)/)
  assert.match(warnings, /Extra script/)
  assert.match(warnings, /sets width or height/)
  assert.equal(result.renderable, true)

  const noRuntime = html.replace(/<!-- promptcut-slides-runtime[\s\S]*<!-- \/promptcut-slides-runtime -->/, '')
  const broken = staticCheck(noRuntime, file)
  assert.match(broken.errors.join('\n'), /runtime is missing/)
  assert.equal(broken.renderable, false)
  assert.equal(staticCheck(replaceRuntime(noRuntime), file).renderable, true)

  const old = html.replace(/promptcut-slides-runtime v\d+/, 'promptcut-slides-runtime v0')
  assert.match(staticCheck(old, file).errors.join('\n'), /version 0/)
  assert.match(staticCheck('<html><body></body></html>', file).errors.join('\n'), /No <div class="pc-deck">/)
})

test('finds only local references', () => {
  const refs = localReferences(`<img src="a.png" srcset="b.png 1x, c.png 2x"><link rel="stylesheet" href="https://fonts.googleapis.com/x">
    <video poster="p.jpg"><source src="v.mp4"></video><div style="background:url(data:image/png;base64,AA)"></div><a href="#x">x</a>`)
  assert.deepEqual(refs.sort(), ['a.png', 'b.png', 'c.png', 'p.jpg', 'v.mp4'])
})

test('replaceRuntime updates an existing block in place', () => {
  const html = newDeck({ title: 'x' })
  const stale = html.replace(/(<script>\n)[\s\S]*?(\n<\/script>\n<!-- \/promptcut-slides-runtime -->)/, '$1// old$2')
  const fixed = replaceRuntime(stale)
  assert.equal(fixed, html)
  assert.equal((fixed.match(/promptcut-slides-runtime v/g) || []).length, 1)
})

test('looks for browsers in the usual places', () => {
  const mac = browserCandidates('darwin', {})
  assert.ok(mac.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
  const win = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' })
  assert.ok(win.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'))
  const linux = browserCandidates('linux', { PATH: ['/usr/bin', '/opt/bin'].join(path.delimiter) })
  assert.ok(linux.includes(path.join('/usr/bin', 'google-chrome')))

  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: p => p === path.join('/usr/bin', 'chromium') }), path.join('/usr/bin', 'chromium'))
  assert.equal(findBrowser({ env: { PROMPTCUT_BROWSER: '/x/chrome' }, exists: p => p === '/x/chrome' }), '/x/chrome')
  assert.throws(() => findBrowser({ env: { PROMPTCUT_BROWSER: '/nope' }, exists: () => false }), /does not exist/)
  assert.throws(() => findBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), /No Chrome, Edge/)
})

test('reads the layout report from the dumped page', () => {
  const report = { slideCount: 1, note: 'a </script> b' }
  const json = JSON.stringify(report).replace(/</g, '\\u003c')
  const dom = `<script>/* <script type="application/json" id="pc-report">fake</script> */</script>` +
    `<script type="application/json" id="pc-report">${json}</script>`
  assert.deepEqual(parseReport(dom), report)
  assert.equal(parseReport('<html></html>'), null)
})

test('maps uploaded slide images to slides', () => {
  const uploads = {
    results: [
      { file_name: 'slide-02.png', success: true, uri: 'tos-x/b' },
      { file_name: 'slide-01.png', success: true, uri: 'tos://tos-x/a' },
      { file_name: 'notes.txt', success: true, uri: 'ignored' },
    ],
  }
  const map = slideUploads(uploads, 2)
  assert.equal(map.get(1), 'tos://tos-x/a')
  assert.equal(map.get(2), 'tos-x/b')
  assert.throws(() => slideUploads(uploads, 3), /slide\(s\) 3/)
  assert.throws(() => slideUploads({ results: [...uploads.results, { file_name: 'x-1.png', uri: 'u' }] }, 2), /Two uploads are for slide 1/)
  assert.throws(() => slideUploads({ results: [{ file_name: 'slide-01.png', success: false, error: 'x' }] }, 1), /slide\(s\) 1/)
  assert.throws(() => slideUploads('nope', 1), /results/)
})

test('plans a slideshow draft with per-slide timing and optional captions', () => {
  const slides = [
    { num: 1, notes: 'Hello\nthere', seconds: null },
    { num: 2, notes: '', seconds: 2.5 },
  ]
  const uploads = { results: [{ file_name: 'slide-01.png', uri: 'b/1' }, { file_name: 'slide-02.png', uri: 'b/2' }] }
  const plain = videoPlan({ slides, ratio: '4:3', uploads, seconds: 3 })
  assert.equal(plain.width, 1440)
  assert.equal(plain.height, 1080)
  assert.equal(plain.totalMs, 5500)
  assert.deepEqual(plain.operations, [
    { op: 'add_image', source: 'tos://b/1', start_ms: 0, duration_ms: 3000 },
    { op: 'add_image', source: 'tos://b/2', start_ms: 3000, duration_ms: 2500 },
  ])
  const captioned = videoPlan({ slides, ratio: '16:9', uploads, notesAsCaptions: true, font: 'vimo://42' })
  assert.equal(captioned.width, 1920)
  assert.deepEqual(captioned.operations.at(-1), { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 4000, text: 'Hello there' }], position_y: -0.75, font_size: 5, font: 'vimo://42' })
  const shortened = videoPlan({ slides, ratio: '16:9', uploads, captions: [null, 'Short line'] })
  assert.deepEqual(shortened.operations.at(-1), { op: 'add_captions', cues: [{ start_ms: 4000, end_ms: 6500, text: 'Short line' }], position_y: -0.75, font_size: 5 })
  assert.equal(videoPlan({ slides, ratio: '16:9', uploads, captions: [null, ''] }).operations.length, 2)
  assert.throws(() => videoPlan({ slides, ratio: '16:9', uploads, captions: ['one'] }), /one entry per slide/)
  assert.throws(() => videoPlan({ slides, ratio: '16:9', uploads, captions: [1, null] }), /text or null/)
  assert.throws(() => videoPlan({ slides, ratio: '16:9', uploads, seconds: 0 }), /--seconds/)
  assert.throws(() => videoPlan({ slides, ratio: '16:9', uploads, font: 'arial' }), /--font/)
})

test('command line: new refuses to overwrite, check and video-plan print JSON', () => {
  const dir = tempDir()
  const deck = path.join(dir, 'p', 'demo', 'demo.html')
  const run = args => {
    try {
      return JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }))
    } catch (error) {
      return JSON.parse(error.stdout)
    }
  }
  assert.equal(run(['new', '--out', deck, '--title', 'Demo']).success, true)
  assert.match(run(['new', '--out', deck, '--title', 'Demo']).error, /already exists/)
  const check = run(['check', '--file', deck])
  assert.equal(check.success, true)
  assert.equal(check.slideCount, 1)
  assert.deepEqual(check.canvas, [1280, 720])

  const uploads = path.join(dir, 'uploads.json')
  fs.writeFileSync(uploads, JSON.stringify({ results: [{ file_name: 'slide-01.png', success: true, uri: 'bucket/key' }] }))
  const ops = path.join(dir, 'ops.json')
  const plan = run(['video-plan', '--file', deck, '--uploads', uploads, '--out', ops, '--seconds', '5'])
  assert.equal(plan.success, true)
  assert.equal(plan.totalSeconds, 5)
  assert.deepEqual(JSON.parse(fs.readFileSync(ops, 'utf8')), [{ op: 'add_image', source: 'tos://bucket/key', start_ms: 0, duration_ms: 5000 }])
  assert.match(run(['export', '--file', deck, '--format', 'gif']).error, /--format/)
  assert.match(run(['nope']).error, /Unknown command/)
})
