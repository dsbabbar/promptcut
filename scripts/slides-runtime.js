/* promptcut slide deck runtime. MIT License, part of promptcut (github.com/dsbabbar/promptcut).
 *
 * A deck is one HTML file. Slides are <section class="pc-slide"> elements inside <div class="pc-deck" data-ratio="16:9">.
 * This script sizes every slide to a fixed canvas and adds a viewer around them:
 *   view      (default)  one slide at a time. Keys: arrows/space/PageUp/PageDown, Home/End, F fullscreen,
 *                        O overview grid, P or S presenter window, ? help.
 *   presenter #presenter current and next slide, speaker notes (data-notes) and a timer, synced with the main window.
 *   shot      #shot=N    slide N alone at 1:1 for screenshots (used by slides.mjs export).
 *   sheet     #sheet=N   slides 4N-3 to 4N in a 2x2 grid, for quick visual review.
 *   print     #print     every slide at 1:1, one per page (used for PDF export; any mode prints this way).
 *   check     #check     every slide at 1:1, then appends a JSON layout report (script element, id pc-report).
 * Elements with data-animate="fade-up" (and fade, fade-down, fade-left, fade-right, zoom-in, blur-in) play an
 * entrance animation when their slide is shown in view or presenter mode. data-delay="200" delays it in ms.
 * Content is always visible without animation: screenshots, PDF, PPTX and reduced-motion users see the final state.
 */
(function () {
  'use strict'
  var VERSION = '1'
  if (window.__promptcutSlides) return
  window.__promptcutSlides = { version: VERSION }

  var RATIOS = { '16:9': [1280, 720], '4:3': [1024, 768] }

  var CSS = [
    ':root{--pc-w:1280px;--pc-h:720px}',
    '.pc-deck[data-ratio="4:3"]{--pc-w:1024px;--pc-h:768px}',
    'html.pc-ready,html.pc-ready>body{margin:0;padding:0}',
    'html.pc-ready>body{background:#0b0b0c}',
    // Defaults in :where() have zero specificity, so the deck's own styles (display:flex, padding, ...) always win.
    ':where(.pc-slide){position:relative;overflow:hidden;box-sizing:border-box}',
    '.pc-slide{width:var(--pc-w)!important;height:var(--pc-h)!important;margin:0!important}',
    '.pc-frame{position:relative;overflow:hidden;flex:none;width:calc(var(--pc-w) * var(--pc-s,1));height:calc(var(--pc-h) * var(--pc-s,1))}',
    '.pc-frame>.pc-slide{position:absolute!important;left:0;top:0;transform-origin:0 0;transform:scale(var(--pc-s,1))}',
    // view
    '.pc-mode-view>body{overflow:hidden;background:#000}',
    '.pc-mode-view .pc-deck{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}',
    '.pc-mode-view .pc-frame{display:none}',
    '.pc-mode-view .pc-frame.pc-active{display:block}',
    '.pc-mode-view.pc-overview>body{overflow:auto;background:#141416}',
    '.pc-mode-view.pc-overview .pc-deck{position:static;display:flex;flex-wrap:wrap;gap:20px;padding:24px;justify-content:center;align-items:flex-start}',
    '.pc-mode-view.pc-overview .pc-frame{display:block;cursor:pointer;border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,.15)}',
    '.pc-mode-view.pc-overview .pc-frame.pc-active{box-shadow:0 0 0 3px #4c8dff}',
    '.pc-mode-view.pc-overview .pc-frame:after,.pc-mode-sheet .pc-frame:after{content:attr(data-num);position:absolute;left:6px;top:6px;z-index:2;min-width:18px;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.75);color:#fff;font:600 12px/16px system-ui,sans-serif;text-align:center}',
    // shot, sheet
    '.pc-mode-shot>body,.pc-mode-sheet>body{overflow:hidden;background:#fff}',
    '.pc-mode-shot .pc-frame,.pc-mode-sheet .pc-frame{display:none}',
    '.pc-mode-shot .pc-frame.pc-active{display:block}',
    '.pc-mode-sheet .pc-deck{display:grid;grid-template-columns:repeat(2,calc(var(--pc-w) / 2));grid-auto-rows:calc(var(--pc-h) / 2);width:var(--pc-w);height:var(--pc-h);background:#d0d0d4}',
    '.pc-mode-sheet .pc-frame.pc-in-sheet{display:block;outline:1px solid #888;outline-offset:-1px}',
    // print, check
    '.pc-mode-print>body,.pc-mode-check>body{background:#fff}',
    '.pc-mode-print .pc-frame,.pc-mode-check .pc-frame{display:block}',
    '@media print{html.pc-ready>body{background:none!important;overflow:visible!important}',
    '.pc-deck{position:static!important;display:block!important;padding:0!important}',
    '.pc-frame{display:block!important;--pc-s:1!important;box-shadow:none!important;border-radius:0!important;break-after:page;page-break-after:always}',
    '.pc-frame:last-child{break-after:auto;page-break-after:auto}',
    '.pc-frame:after,.pc-ui,.pc-help{display:none!important}',
    '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}}',
    // presenter
    '.pc-mode-presenter>body{overflow:hidden;background:#141416;color:#eee;font:15px/1.5 system-ui,sans-serif}',
    '.pc-mode-presenter .pc-frame{display:none;position:fixed}',
    '.pc-mode-presenter .pc-frame.pc-active,.pc-mode-presenter .pc-frame.pc-next{display:block;box-shadow:0 0 0 1px rgba(255,255,255,.2)}',
    '.pc-pres{position:fixed;inset:0;pointer-events:none}',
    '.pc-pres-label{position:fixed;font:600 12px/1 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#999}',
    '.pc-pres-notes{position:fixed;overflow:auto;white-space:pre-wrap;font:18px/1.5 system-ui,sans-serif;color:#eee;pointer-events:auto}',
    '.pc-pres-bar{position:fixed;left:24px;bottom:16px;display:flex;gap:24px;font:600 20px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums}',
    // entrance animations: hidden states live only inside the keyframes
    '@keyframes pc-fade{from{opacity:0}}',
    '@keyframes pc-fade-up{from{opacity:0;transform:translateY(28px)}}',
    '@keyframes pc-fade-down{from{opacity:0;transform:translateY(-28px)}}',
    '@keyframes pc-fade-left{from{opacity:0;transform:translateX(36px)}}',
    '@keyframes pc-fade-right{from{opacity:0;transform:translateX(-36px)}}',
    '@keyframes pc-zoom-in{from{opacity:0;transform:scale(.92)}}',
    '@keyframes pc-blur-in{from{opacity:0;filter:blur(12px)}}',
    '.pc-play [data-animate]{animation-duration:var(--pc-dur,.7s);animation-timing-function:cubic-bezier(.2,.7,.2,1);animation-fill-mode:both;animation-delay:var(--pc-delay,0ms)}',
    '.pc-play [data-animate="fade"]{animation-name:pc-fade}',
    '.pc-play [data-animate="fade-up"]{animation-name:pc-fade-up}',
    '.pc-play [data-animate="fade-down"]{animation-name:pc-fade-down}',
    '.pc-play [data-animate="fade-left"]{animation-name:pc-fade-left}',
    '.pc-play [data-animate="fade-right"]{animation-name:pc-fade-right}',
    '.pc-play [data-animate="zoom-in"]{animation-name:pc-zoom-in}',
    '.pc-play [data-animate="blur-in"]{animation-name:pc-blur-in}',
    '@media (prefers-reduced-motion:reduce){.pc-play [data-animate]{animation:none!important}}',
    '.pc-overview [data-animate]{animation:none!important}',
    // viewer controls
    '.pc-ui{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483646;display:flex;align-items:center;gap:2px;padding:4px 8px;border-radius:999px;background:rgba(24,24,27,.86);color:#f4f4f5;font:500 13px/1 system-ui,sans-serif;opacity:0;transition:opacity .25s;user-select:none}',
    '.pc-ui.pc-show,.pc-ui:hover,.pc-overview .pc-ui{opacity:1}',
    '.pc-ui button{all:unset;box-sizing:border-box;min-width:32px;height:32px;padding:0 8px;border-radius:999px;cursor:pointer;text-align:center;line-height:32px;font:inherit;color:inherit}',
    '.pc-ui button:hover,.pc-ui button:focus-visible{background:rgba(255,255,255,.16)}',
    '.pc-ui .pc-count{padding:0 8px;font-variant-numeric:tabular-nums;color:#d4d4d8}',
    '.pc-help{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font:15px/1.7 system-ui,sans-serif;color:#f4f4f5}',
    '.pc-help.pc-show{display:flex}',
    '.pc-help>div{padding:24px 32px;border-radius:12px;background:#1f1f23}',
    '.pc-help kbd{display:inline-block;min-width:22px;margin-right:8px;padding:0 6px;border-radius:4px;background:#3f3f46;font:600 13px/22px system-ui,sans-serif;text-align:center}',
  ].join('\n')

  var style = document.createElement('style')
  style.setAttribute('data-pc-runtime', VERSION)
  style.textContent = CSS
  ;(document.head || document.documentElement).appendChild(style)

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  function parseHash() {
    var raw = decodeURIComponent((location.hash || '').replace(/^#/, ''))
    var match = /^(shot|sheet|presenter|print|check)(?:=(\d+))?$/.exec(raw)
    if (match) return { mode: match[1], num: match[2] ? parseInt(match[2], 10) : 1 }
    if (/^\d+$/.test(raw)) return { mode: 'view', num: parseInt(raw, 10) }
    return { mode: 'view', num: 1 }
  }

  onReady(function () {
    var deck = document.querySelector('.pc-deck')
    if (!deck) return
    var root = document.documentElement
    var size = RATIOS[deck.getAttribute('data-ratio')] || RATIOS['16:9']
    var W = size[0]
    var H = size[1]
    var pageStyle = document.createElement('style')
    pageStyle.textContent = '@page{size:' + W + 'px ' + H + 'px;margin:0}'
    document.head.appendChild(pageStyle)

    var slides = Array.prototype.filter.call(deck.children, function (el) {
      return el.classList && el.classList.contains('pc-slide')
    })
    var frames = slides.map(function (slide, i) {
      var frame = document.createElement('div')
      frame.className = 'pc-frame'
      frame.setAttribute('data-num', String(i + 1))
      deck.insertBefore(frame, slide)
      frame.appendChild(slide)
      return frame
    })
    Array.prototype.forEach.call(deck.querySelectorAll('[data-delay]'), function (el) {
      var ms = parseFloat(el.getAttribute('data-delay'))
      if (isFinite(ms)) el.style.setProperty('--pc-delay', ms + 'ms')
    })
    Array.prototype.forEach.call(deck.querySelectorAll('[data-duration]'), function (el) {
      var ms = parseFloat(el.getAttribute('data-duration'))
      if (isFinite(ms)) el.style.setProperty('--pc-dur', ms + 'ms')
    })

    var params = parseHash()
    var mode = params.mode
    root.classList.add('pc-ready', 'pc-mode-' + mode)
    var count = frames.length
    var current = Math.min(Math.max(params.num, 1), Math.max(count, 1)) - 1

    function setScale(frame, s) {
      frame.style.setProperty('--pc-s', String(s))
    }

    if (mode === 'shot') {
      frames.forEach(function (f, i) { f.classList.toggle('pc-active', i === current) })
      return
    }
    if (mode === 'sheet') {
      var first = (params.num - 1) * 4
      frames.forEach(function (f, i) {
        var inSheet = i >= first && i < first + 4
        f.classList.toggle('pc-in-sheet', inSheet)
        if (inSheet) setScale(f, 0.5)
      })
      return
    }
    if (mode === 'print') return
    if (mode === 'check') {
      writeReport(deck, slides, W, H)
      return
    }

    // view and presenter modes are interactive
    var peer = null
    var overview = false
    var countLabel = null
    var ui = null
    var help = null
    var presenterParts = null
    var startedAt = Date.now()
    if (mode === 'presenter') {
      peer = window.opener || null
      buildPresenter()
    } else {
      buildViewer()
    }

    window.addEventListener('message', function (event) {
      var data = event.data
      if (!data || data.pc !== 'goto' || typeof data.index !== 'number') return
      if (mode === 'view' && !peer) peer = event.source
      go(data.index, true)
    })

    function go(index, fromPeer) {
      if (!count) return
      var next = Math.min(Math.max(index, 0), count - 1)
      var changed = next !== current
      current = next
      render(changed)
      if (!fromPeer && peer && !peer.closed) {
        try { peer.postMessage({ pc: 'goto', index: current }, '*') } catch (e) { /* peer gone */ }
      }
      if (mode === 'view') {
        try { history.replaceState(null, '', '#' + (current + 1)) } catch (e) { /* file: urls may refuse */ }
      }
    }

    function play(frame) {
      var slide = frame.firstElementChild
      slide.classList.remove('pc-play')
      void slide.offsetWidth
      slide.classList.add('pc-play')
    }

    function render(changed) {
      frames.forEach(function (f, i) {
        if (i !== current) f.firstElementChild.classList.remove('pc-play')
        f.classList.toggle('pc-active', i === current)
        f.classList.toggle('pc-next', mode === 'presenter' && i === current + 1)
      })
      if (mode === 'presenter') layoutPresenter()
      else layoutViewer()
      if (changed !== false && !overview) play(frames[current])
      if (countLabel) countLabel.textContent = (count ? current + 1 : 0) + ' / ' + count
    }

    function layoutViewer() {
      if (overview) {
        var per = window.innerWidth > 1400 ? 4 : window.innerWidth > 900 ? 3 : 2
        var s = Math.max(0.1, (window.innerWidth - 48 - (per - 1) * 20 - 20) / per / W)
        frames.forEach(function (f) { setScale(f, s) })
        return
      }
      var scale = Math.min(window.innerWidth / W, window.innerHeight / H)
      frames.forEach(function (f) { setScale(f, scale) })
    }

    function button(label, title, action) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.setAttribute('aria-label', title)
      b.addEventListener('click', function (e) { e.stopPropagation(); action() })
      return b
    }

    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen()
      else if (root.requestFullscreen) root.requestFullscreen()
    }

    function toggleOverview(force) {
      overview = typeof force === 'boolean' ? force : !overview
      root.classList.toggle('pc-overview', overview)
      render(false)
      if (overview) frames[current].scrollIntoView({ block: 'center' })
      else play(frames[current])
    }

    function openPresenter() {
      var url = location.href.split('#')[0] + '#presenter=' + (current + 1)
      var win = window.open(url, 'pc-presenter', 'width=1200,height=760')
      if (win) peer = win
    }

    function buildViewer() {
      ui = document.createElement('div')
      ui.className = 'pc-ui'
      countLabel = document.createElement('span')
      countLabel.className = 'pc-count'
      ui.appendChild(button('‹', 'Previous slide', function () { go(current - 1) }))
      ui.appendChild(countLabel)
      ui.appendChild(button('›', 'Next slide', function () { go(current + 1) }))
      ui.appendChild(button('▦', 'Overview (O)', function () { toggleOverview() }))
      ui.appendChild(button('Notes', 'Presenter view with notes (P)', openPresenter))
      ui.appendChild(button('⛶', 'Fullscreen (F)', toggleFullscreen))
      ui.appendChild(button('?', 'Keyboard shortcuts', function () { help.classList.toggle('pc-show') }))
      document.body.appendChild(ui)

      help = document.createElement('div')
      help.className = 'pc-help'
      help.innerHTML = '<div><kbd>→</kbd>Next slide (also Space, Page Down)<br><kbd>←</kbd>Previous slide (also Page Up)<br>' +
        '<kbd>Home</kbd>First slide &nbsp; <kbd>End</kbd>Last slide<br><kbd>F</kbd>Fullscreen<br><kbd>O</kbd>Overview of all slides<br>' +
        '<kbd>P</kbd>Presenter view with notes and timer<br><kbd>?</kbd>Show or hide this help</div>'
      help.addEventListener('click', function () { help.classList.remove('pc-show') })
      document.body.appendChild(help)

      var hideTimer = null
      function showUi() {
        ui.classList.add('pc-show')
        clearTimeout(hideTimer)
        hideTimer = setTimeout(function () { ui.classList.remove('pc-show') }, 2200)
      }
      document.addEventListener('mousemove', showUi)
      showUi()

      frames.forEach(function (f, i) {
        f.addEventListener('click', function (e) {
          if (!overview) return
          e.stopPropagation()
          toggleOverview(false)
          go(i)
        })
      })
      deck.addEventListener('click', function (e) {
        if (overview || e.target.closest('a,button,input,textarea,select,video,audio')) return
        if (e.clientX < window.innerWidth / 3) go(current - 1)
        else go(current + 1)
      })
      var touchX = null
      document.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX }, { passive: true })
      document.addEventListener('touchend', function (e) {
        if (touchX === null) return
        var dx = e.changedTouches[0].clientX - touchX
        touchX = null
        if (Math.abs(dx) > 40) go(current + (dx < 0 ? 1 : -1))
      })
      window.addEventListener('hashchange', function () {
        var p = parseHash()
        if (p.mode === 'view' && p.num - 1 !== current) go(p.num - 1)
      })
    }

    function buildPresenter() {
      document.title = 'Presenter: ' + document.title
      var layer = document.createElement('div')
      layer.className = 'pc-pres'
      function part(cls, text) {
        var el = document.createElement('div')
        el.className = cls
        if (text) el.textContent = text
        layer.appendChild(el)
        return el
      }
      presenterParts = {
        curLabel: part('pc-pres-label', 'Current'),
        nextLabel: part('pc-pres-label', 'Next'),
        notesLabel: part('pc-pres-label', 'Notes'),
        notes: part('pc-pres-notes'),
        bar: part('pc-pres-bar'),
      }
      presenterParts.count = document.createElement('span')
      presenterParts.clock = document.createElement('span')
      presenterParts.bar.appendChild(presenterParts.count)
      presenterParts.bar.appendChild(presenterParts.clock)
      document.body.appendChild(layer)
      countLabel = presenterParts.count
      setInterval(function () {
        var secs = Math.floor((Date.now() - startedAt) / 1000)
        var m = Math.floor(secs / 60)
        var s = secs % 60
        presenterParts.clock.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
      }, 500)
      presenterParts.clock.textContent = '00:00'
      presenterParts.clock.title = 'Click to reset the timer'
      presenterParts.clock.style.pointerEvents = 'auto'
      presenterParts.clock.style.cursor = 'pointer'
      presenterParts.clock.addEventListener('click', function () { startedAt = Date.now() })
    }

    function place(el, x, y, w, h) {
      el.style.left = x + 'px'
      el.style.top = y + 'px'
      if (w !== undefined) el.style.width = w + 'px'
      if (h !== undefined) el.style.height = h + 'px'
    }

    function layoutPresenter() {
      var pad = 24
      var vw = window.innerWidth
      var vh = window.innerHeight
      var mainW = Math.floor((vw - pad * 3) * 0.64)
      var sMain = Math.min(mainW / W, (vh - 110) / H)
      var sideX = pad * 2 + W * sMain
      var sideW = vw - sideX - pad
      var sNext = Math.min(sideW / W, (vh * 0.4) / H)
      frames.forEach(function (f, i) {
        if (i === current) { setScale(f, sMain); place(f, pad, pad + 22) }
        else if (i === current + 1) { setScale(f, sNext); place(f, sideX, pad + 22) }
      })
      var p = presenterParts
      place(p.curLabel, pad, pad)
      place(p.nextLabel, sideX, pad)
      p.nextLabel.textContent = current + 1 < count ? 'Next' : 'End of deck'
      var notesTop = pad + 22 + (current + 1 < count ? H * sNext : 0) + 28
      place(p.notesLabel, sideX, notesTop - 20)
      place(p.notes, sideX, notesTop, sideW, Math.max(80, vh - notesTop - 70))
      var notes = slides[current] ? slides[current].getAttribute('data-notes') : ''
      p.notes.textContent = notes || 'No notes for this slide.'
      p.notes.style.color = notes ? '#eee' : '#777'
    }

    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return
      var k = e.key
      if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'Enter') go(current + 1)
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') go(current - 1)
      else if (k === 'Home') go(0)
      else if (k === 'End') go(count - 1)
      else if (mode === 'view' && (k === 'f' || k === 'F')) toggleFullscreen()
      else if (mode === 'view' && (k === 'o' || k === 'O' || k === 'g' || k === 'G')) toggleOverview()
      else if (mode === 'view' && (k === 'p' || k === 'P' || k === 's' || k === 'S')) openPresenter()
      else if (mode === 'view' && k === '?') help.classList.toggle('pc-show')
      else if (k === 'Escape') {
        if (help) help.classList.remove('pc-show')
        if (overview) toggleOverview(false)
      } else return
      e.preventDefault()
    })
    window.addEventListener('resize', function () { render(false) })
    if (peer && !peer.closed) {
      try { peer.postMessage({ pc: 'goto', index: current }, '*') } catch (e) { /* ignore */ }
    }
    render(true)
  })

  // Layout report for `slides.mjs check --render`.
  function writeReport(deck, slides, W, H) {
    var images = Array.prototype.slice.call(deck.querySelectorAll('img'))
    var waits = images.map(function (img) {
      if (img.complete) return Promise.resolve()
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve)
        img.addEventListener('error', resolve)
      })
    })
    var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
    waits.push(fontsReady)
    var timedOut = false
    var limit = new Promise(function (resolve) {
      setTimeout(function () { timedOut = true; resolve() }, 8000)
    })
    Promise.race([Promise.all(waits), limit]).then(function () {
      // A timer, not requestAnimationFrame: headless browsers may not paint frames before the DOM is read.
      setTimeout(function () {
        var report = { version: VERSION, canvas: [W, H], slideCount: slides.length, slides: [], fonts: fontReport(deck), loadTimedOut: timedOut }
        slides.forEach(function (slide, i) { report.slides.push(slideReport(slide, i)) })
        var out = document.createElement('script')
        out.type = 'application/json'
        out.id = 'pc-report'
        out.textContent = JSON.stringify(report).replace(/</g, '\\u003c')
        document.body.appendChild(out)
      }, 50)
    })
  }

  function directText(el) {
    var text = ''
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) text += n.nodeValue
    return text.replace(/\s+/g, ' ').trim()
  }

  function describe(el) {
    var name = el.tagName.toLowerCase()
    if (el.classList.length) name += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.')
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) name += ' "' + (text.length > 48 ? text.slice(0, 45) + '...' : text) + '"'
    else if (el.tagName === 'IMG') name += ' ' + (el.getAttribute('src') || '').slice(0, 80)
    return name
  }

  function box(r, base) {
    return [Math.round(r.left - base.left), Math.round(r.top - base.top), Math.round(r.width), Math.round(r.height)]
  }

  function visible(el) {
    var cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function slideReport(slide, index) {
    var base = slide.getBoundingClientRect()
    var result = {
      num: index + 1,
      id: slide.id || null,
      notes: !!(slide.getAttribute('data-notes') || '').trim(),
      textBlocks: 0,
      images: 0,
      outside: [],
      clipped: [],
      overlaps: [],
      brokenImages: [],
    }
    var texts = []
    var all = slide.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
      if (el.tagName === 'IMG' && getComputedStyle(el).display !== 'none') {
        result.images++
        if (el.complete && el.naturalWidth === 0) result.brokenImages.push(describe(el))
      }
      if (!visible(el)) continue
      if (!directText(el)) continue
      result.textBlocks++
      var r = el.getBoundingClientRect()
      if (r.left < base.left - 1 || r.top < base.top - 1 || r.right > base.right + 1 || r.bottom > base.bottom + 1) {
        result.outside.push({ element: describe(el), box: box(r, base) })
      }
      var cs = getComputedStyle(el)
      var clipsY = /hidden|clip|auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2
      var clipsX = /hidden|clip|auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2
      var ellipsis = cs.textOverflow === 'ellipsis' || parseInt(cs.webkitLineClamp, 10) > 0
      if ((clipsY || clipsX) && !ellipsis) result.clipped.push({ element: describe(el), box: box(r, base) })
      texts.push({ el: el, r: r })
    }
    for (var a = 0; a < texts.length; a++) {
      for (var b = a + 1; b < texts.length; b++) {
        var A = texts[a]
        var B = texts[b]
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue
        var w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left)
        var h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top)
        if (w <= 2 || h <= 2) continue
        var smaller = Math.min(A.r.width * A.r.height, B.r.width * B.r.height)
        if (smaller > 0 && (w * h) / smaller > 0.2) {
          result.overlaps.push({ elements: [describe(A.el), describe(B.el)], box: box({ left: Math.max(A.r.left, B.r.left), top: Math.max(A.r.top, B.r.top), width: w, height: h }, base) })
        }
        if (result.overlaps.length >= 10) break
      }
    }
    if (result.outside.length > 10) result.outside.length = 10
    if (result.clipped.length > 10) result.clipped.length = 10
    return result
  }

  function fontReport(deck) {
    var families = {}
    var all = deck.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      if (!directText(all[i])) continue
      var first = getComputedStyle(all[i]).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
      if (first) families[first] = true
    }
    var generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i
    var failed = []
    var system = []
    Object.keys(families).forEach(function (fam) {
      if (generic.test(fam)) return
      var declared = false
      var loaded = false
      if (document.fonts && document.fonts.forEach) {
        document.fonts.forEach(function (face) {
          if (face.family.replace(/^["']|["']$/g, '') !== fam) return
          declared = true
          if (face.status === 'loaded') loaded = true
        })
      }
      if (declared && !loaded) failed.push(fam)
      else if (!declared) system.push(fam)
    })
    // failed: web fonts that did not load (text falls back to another font).
    // system: not web fonts, so they only look right on computers that have them installed.
    return { used: Object.keys(families), failed: failed, system: system }
  }
})()
