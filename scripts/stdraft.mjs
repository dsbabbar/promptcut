#!/usr/bin/env node
// Read and edit CapCut STDraft documents locally.
//
//   node stdraft.mjs new      --width 1080 --height 1920 --out draft.json
//   node stdraft.mjs summary  --in draft.json
//   node stdraft.mjs validate --in draft.json
//   node stdraft.mjs apply    --in draft.json --ops ops.json --out new.json
//
// An STDraft document is {"version": "...", "segments": [...]}: one DRAFT root segment plus VIDEO, AUDIO,
// TEXT, effect, filter and template segments that point at it with parent_id. Times are in milliseconds.
// `apply` runs a JSON array of operations in order and only writes the result if every
// operation succeeds and the result validates. CapCut validates again when the draft is saved.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const TEXT_LAYER_BASE = 1000
export const AUDIO_LAYER_BASE = 100
// Captions go on layer 1, the lowest text track above the main video, as in CapCut's own STDraft examples.
// CapCut's conversion turns captions spread over higher layers into one track each.
export const CAPTION_LAYER = 1

const TEXT_STYLE = {
  alignment: 1,
  font_size: 13,
  font_color: '#FFFFFF',
  text_color: '#FFFFFF',
  border_color: '#000000',
  border_width: 0.06,
  shadow_alpha: 0.4,
  shadow_color: '#000000',
  shadow_distance: 2,
  shadow_smoothing: 0.3,
  line_max_width: 0.8,
}

// CapCut's library font that renders Latin and CJK text. Text without a font is filled in by the cloud with
// one that can't render, so new text always gets a font.
export const DEFAULT_FONT = 'vimo://7317175475195875841'

const TYPES = new Set(['DRAFT', 'VIDEO', 'AUDIO', 'TEXT', 'TEXT_TEMPLATE', 'SUBTITLE_TEMPLATE', 'VIDEO_EFFECT', 'COLOR_FILTER'])
// Effects and filters can sit on the timeline (under the DRAFT root) or under one video clip.
const EFFECT_TYPES = new Set(['VIDEO_EFFECT', 'COLOR_FILTER'])
// The style keys CapCut keeps on a text's per-letter style copies (PATCH child segments). The cloud treats a
// copy as the truth, so a style change on the text must be written to its copies too, or it is undone on save.
const PATCH_STYLE_KEYS = ['font', 'font_size', 'font_color', 'bold', 'italic', 'underline', 'shadow_color', 'shadow_alpha',
  'shadow_angle', 'shadow_smoothing', 'shadow_distance', 'border_color', 'border_width']
// DRAFT ratio_type values CapCut accepts, with the canvas size promptcut uses for each.
const RATIOS = {
  '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440],
  '2:1': [2160, 1080], '2.35:1': [2538, 1080], '1.85:1': [1998, 1080], '1.125:2.436': [1080, 2338],
}
const RATIO_TYPES = new Set([...Object.keys(RATIOS), 'custom', 'original'])
// Blend modes as named in CapCut's editor. CapCut's draft format doesn't document the values; these are untested.
const BLEND_MODES = ['normal', 'darken', 'screen', 'overlay', 'multiply', 'lighten', 'hard_light', 'soft_light',
  'linear_burn', 'color_burn', 'color_dodge']

// ------------------------------------------------------------------ helpers

const clone = value => JSON.parse(JSON.stringify(value))

function root(draft) {
  const found = draft.segments.find(s => s.type === 'DRAFT')
  if (!found) throw new Error('The draft has no DRAFT root segment')
  return found
}

function find(draft, id) {
  const segment = draft.segments.find(s => s.id === id)
  if (!segment) throw new Error(`No segment with id "${id}"`)
  if (segment.type === 'DRAFT') throw new Error('The DRAFT root cannot be changed with this operation')
  return segment
}

function uniqueId(draft, prefix) {
  const ids = new Set(draft.segments.map(s => s.id))
  for (let n = 0; ; n++) {
    const id = `${prefix}_${n}`
    if (!ids.has(id)) return id
  }
}

// CapCut puts every visual segment on the timeline (video clips, images, text, effects, filters, ...) in one shared
// set of layers, and renumbers them into a single sequence on read-back. Audio has its own layers. Segments under
// a clip (an effect on one clip, a text's style copies) follow their parent and take no layer.
function visuals(draft) {
  const rootId = draft.segments.find(s => s?.type === 'DRAFT')?.id
  return draft.segments.filter(s => s && s.type !== 'AUDIO' && s.type !== 'DRAFT' && s.parent_id === rootId &&
    s.timeline && Number.isInteger(s.layout?.layer))
}

// The lowest layer from `from` up where no visual segment overlaps any of the given time ranges.
function freeVisualLayer(draft, timelines, from, skip = new Set()) {
  const taken = visuals(draft).filter(s => !skip.has(s))
  for (let layer = from; ; layer++) {
    if (!taken.some(s => s.layout.layer === layer && timelines.some(t => overlaps(s.timeline, t)))) return layer
  }
}

// The layer just above every visual segment that overlaps the time range, for effects and filters.
function layerAbove(draft, timeline) {
  return Math.max(0, ...visuals(draft).filter(s => overlaps(s.timeline, timeline)).map(s => s.layout.layer + 1))
}

function children(draft, id) {
  return draft.segments.filter(s => s.parent_id === id)
}

function nextLayer(draft, type, base) {
  if (type === 'TEXT') {
    const layers = visuals(draft).map(s => s.layout.layer)
    return Math.max(base - 1, ...layers) + 1
  }
  const layers = draft.segments.filter(s => s.type === type).map(s => s.layout?.layer ?? base - 1)
  return Math.max(base - 1, ...layers) + 1
}

function overlaps(a, b) {
  return a['start.ms'] < b['start.ms'] + b['duration.ms'] && b['start.ms'] < a['start.ms'] + a['duration.ms']
}

// The lowest layer from CAPTION_LAYER up where no existing TEXT segment overlaps the new cues in time.
function captionLayer(draft, timelines) {
  return freeVisualLayer(draft, timelines, CAPTION_LAYER)
}

function requireMs(value, name, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a whole number of milliseconds of at least ${min}`)
  return value
}

function requireSource(value, kinds) {
  if (typeof value !== 'string' || !kinds.some(kind => value.startsWith(`${kind}://`))) {
    throw new Error(`source must start with ${kinds.map(k => `${k}://`).join(' or ')}`)
  }
  return value
}

function mainTrackEnd(draft) {
  return Math.max(0, ...draft.segments.filter(s => s.type === 'VIDEO' && s.layout?.layer === 0)
    .map(s => s.timeline['start.ms'] + s.timeline['duration.ms']))
}

export function draftDuration(draft) {
  return Math.max(0, ...draft.segments.filter(s => s.timeline).map(s => s.timeline['start.ms'] + s.timeline['duration.ms']))
}

// ------------------------------------------------------------------ look and layout

function requireColor(value, name) {
  if (typeof value !== 'string' || !/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error(`${name} must be a colour like #FFFFFF or #FFFFFFCC`)
  return value.toUpperCase()
}

function requireNumber(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}`)
  return value
}

const ALIGN = { left: 0, center: 1, right: 2 }
// In a real draft, background.blur 0.5 looked strong (shapes unrecognisable); 0.2 is a soft default.
const SOFT_BLUR = 0.2

// Text style fields shared by add_text, add_captions (as style) and update. Friendly names map to CapCut's
// TEXT attributes; outline and shadow defaults are the values CapCut uses on its own captions.
function applyTextStyle(a, op, changed = []) {
  if (op.alignment !== undefined) {
    if (!(op.alignment in ALIGN)) throw new Error('alignment must be left, center or right')
    a.alignment = ALIGN[op.alignment]; changed.push('alignment')
  }
  if (op.outline === false) { a.border_width = 0; changed.push('outline') }
  if (op.outline === true || op.outline_color !== undefined || op.outline_width !== undefined) {
    a.border_color = requireColor(op.outline_color ?? a.border_color ?? '#000000', 'outline_color')
    a.border_width = requireNumber(op.outline_width ?? (a.border_width || 0.06), 'outline_width', 0, 1)
    changed.push('outline')
  }
  if (op.shadow === false) { a.shadow_alpha = 0; changed.push('shadow') }
  if (op.shadow === true || ['shadow_color', 'shadow_opacity', 'shadow_distance', 'shadow_angle', 'shadow_blur'].some(k => op[k] !== undefined)) {
    a.shadow_color = requireColor(op.shadow_color ?? a.shadow_color ?? '#000000', 'shadow_color')
    a.shadow_alpha = requireNumber(op.shadow_opacity ?? (a.shadow_alpha || 0.4), 'shadow_opacity', 0, 1)
    a.shadow_distance = requireNumber(op.shadow_distance ?? a.shadow_distance ?? 2, 'shadow_distance', 0, 100)
    a.shadow_smoothing = requireNumber(op.shadow_blur ?? a.shadow_smoothing ?? 0.3, 'shadow_blur', 0, 1)
    if (op.shadow_angle !== undefined) a.shadow_angle = requireNumber(op.shadow_angle, 'shadow_angle', -360, 360)
    changed.push('shadow')
  }
  if (op.box === false) { a.background_alpha = 0; changed.push('box') }
  if (op.box_color !== undefined || op.box_opacity !== undefined) {
    a.background_color = requireColor(op.box_color ?? a.background_color ?? '#000000', 'box_color')
    a.background_alpha = requireNumber(op.box_opacity ?? (a.background_alpha || 0.6), 'box_opacity', 0, 1)
    changed.push('box')
  }
  if (op.text_opacity !== undefined) { a.text_alpha = requireNumber(op.text_opacity, 'text_opacity', 0, 1); changed.push('text_opacity') }
  if (op.underline !== undefined) { a.underline = Boolean(op.underline); changed.push('underline') }
  for (const key of ['letter_spacing', 'line_spacing', 'bold_width', 'italic_degree']) {
    if (op[key] !== undefined) { a[key] = requireNumber(op[key], key, -100, 100); changed.push(key) }
  }
  if (op.line_max_width !== undefined) { a.line_max_width = requireNumber(op.line_max_width, 'line_max_width', 0.05, 1); changed.push('line_max_width') }
  if (op.vertical !== undefined) { a.type_setting = op.vertical ? 1 : 0; changed.push(op.vertical ? 'vertical text' : 'horizontal text') }
  // A text effect (word art) from capcut-materials, and a bubble taken from text already in the draft.
  for (const [key, attr, label] of [['text_effect', 'flower', 'text effect'], ['bubble', 'bubble', 'bubble']]) {
    if (op[key] === undefined) continue
    if (op[key] === null) delete a[attr]
    else a[attr] = requireSource(op[key], ['vimo'])
    changed.push(op[key] === null ? `${label} removed` : label)
  }
  return changed
}

// Word timings for a caption: CapCut's caption_timeline (TEXT) or subtitle_timeline (caption template) entries,
// relative to the caption's start. Without words, the whole sentence is one entry. With words (project time),
// each entry's text keeps the spaces that follow it, so the entries join back into the caption text exactly.
function captionTimeline(text, start, end, words, label) {
  if (words === undefined) return [{ text, 'start.ms': 0, 'end.ms': end - start }]
  if (!Array.isArray(words) || words.length === 0) throw new Error(`${label}: words must be a non-empty array of {text, start_ms, end_ms}`)
  const entries = []
  let at = 0
  let previous = start
  for (const [i, w] of words.entries()) {
    const wordText = typeof w?.text === 'string' ? w.text.trim() : ''
    if (!wordText) throw new Error(`${label} word ${i + 1} has no text`)
    const ws = requireMs(w.start_ms, `${label} word ${i + 1} start_ms`, { min: previous })
    const we = requireMs(w.end_ms, `${label} word ${i + 1} end_ms`, { min: ws + 1 })
    if (we > end) throw new Error(`${label} word ${i + 1} ends after the caption`)
    const found = text.indexOf(wordText, at)
    if (found === -1 || text.slice(at, found).trim()) throw new Error(`${label}: the words don't match the caption text ("${wordText}")`)
    let stop = found + wordText.length
    if (i === words.length - 1) stop = text.length
    else while (stop < text.length && /\s/.test(text[stop])) stop++
    entries.push({ text: text.slice(i === 0 ? 0 : found, stop), 'start.ms': ws - start, 'end.ms': we - start })
    at = stop
    previous = we
  }
  if (text.slice(at).trim()) throw new Error(`${label}: the words don't cover the whole caption text`)
  return entries
}

function timelineKey(s) {
  return s.type === 'SUBTITLE_TEMPLATE' ? 'subtitle_timeline' : 'caption_timeline'
}

// After a style change on a text, write the changed style keys to its per-letter style copies (PATCH segments),
// which CapCut would otherwise sync back over the change. text_color is font_color on a copy.
function syncStyleCopies(draft, s, before) {
  const a = s.attributes
  const changed = {}
  for (const key of PATCH_STYLE_KEYS) {
    if (JSON.stringify(a[key]) !== JSON.stringify(before[key])) changed[key] = a[key]
  }
  if (a.text_color !== before.text_color && a.text_color !== undefined) changed.font_color = a.text_color
  const copies = children(draft, s.id).filter(c => c.type === 'PATCH')
  if (!copies.length || !Object.keys(changed).length) return 0
  for (const c of copies) {
    c.attributes ??= {}
    for (const [key, value] of Object.entries(changed)) {
      if (value === undefined) delete c.attributes[key]
      else c.attributes[key] = value
    }
  }
  return copies.length
}

// After a text's content changes, clip its style copies' letter ranges to the new length, dropping copies left
// empty.
function clipStyleCopies(draft, s) {
  const length = [...s.attributes.content].length
  let dropped = 0
  for (const c of children(draft, s.id).filter(x => x.type === 'PATCH')) {
    const a = c.attributes ?? {}
    const start = Number(a.letter_start ?? 0)
    if (start >= length) { draft.segments.splice(draft.segments.indexOf(c), 1); dropped++; continue }
    if (a.letter_end !== undefined && Number(a.letter_end) > length) a.letter_end = length
  }
  return dropped
}

// Size, rotation and opacity on a segment's layout. scale sets both scale_x and scale_y.
function applyTransform(layout, op, changed = []) {
  if (op.scale !== undefined) { layout.scale_x = layout.scale_y = requireNumber(op.scale, 'scale', 0.01, 10); changed.push('scale') }
  for (const key of ['scale_x', 'scale_y']) if (op[key] !== undefined) { layout[key] = requireNumber(op[key], key, 0.01, 10); changed.push(key) }
  if (op.rotation !== undefined) { layout.rotation = requireNumber(op.rotation, 'rotation', -360, 360); changed.push('rotation') }
  if (op.opacity !== undefined) { layout.alpha = requireNumber(op.opacity, 'opacity', 0, 1); changed.push('opacity') }
  return changed
}

// Crop and background fill on a video clip or image. crop is [left, top, right, bottom] from 0 to 1.
function applyClipLook(s, op, changed = []) {
  const a = s.attributes
  if (op.crop !== undefined) {
    if (s.type !== 'VIDEO') throw new Error('crop works only on video clips and images')
    if (op.crop === null) { delete a.crop; changed.push('crop removed') } else {
      if (!Array.isArray(op.crop) || op.crop.length !== 4 || op.crop.some(n => typeof n !== 'number' || n < 0 || n > 1)) throw new Error('crop must be [left, top, right, bottom], each from 0 to 1')
      if (op.crop[2] <= op.crop[0] || op.crop[3] <= op.crop[1]) throw new Error('crop right must be past left, and bottom past top')
      a.crop = op.crop; changed.push('crop')
    }
  }
  if (op.background_blur !== undefined || op.background_color !== undefined) {
    if (s.type !== 'VIDEO') throw new Error('background fill works only on video clips and images')
    if (op.background_blur !== undefined) { a['background.blur'] = op.background_blur === true ? SOFT_BLUR : requireNumber(op.background_blur, 'background_blur', 0, 1); delete a['background.color']; changed.push('background blur') }
    if (op.background_color !== undefined) { a['background.color'] = requireColor(op.background_color, 'background_color'); delete a['background.blur']; changed.push('background colour') }
  }
  if (op.blend_mode !== undefined || op.blend_intensity !== undefined) {
    if (s.type !== 'VIDEO') throw new Error('blend works only on video clips and images')
    if (op.blend_mode === null || op.blend_mode === 'normal') { delete a.blend_mode; delete a.blend_intensity; changed.push('blend removed') } else {
      if (op.blend_mode !== undefined) {
        if (!BLEND_MODES.includes(op.blend_mode)) throw new Error(`blend_mode must be one of ${BLEND_MODES.join(', ')}`)
        a.blend_mode = op.blend_mode
      }
      if (!a.blend_mode) throw new Error('blend_intensity needs a blend_mode')
      a.blend_intensity = requireNumber(op.blend_intensity ?? a.blend_intensity ?? 1, 'blend_intensity', 0, 1)
      changed.push('blend')
    }
  }
  if (op.cutout !== undefined) {
    if (s.type !== 'VIDEO') throw new Error('cutout works only on video clips and images')
    if (op.cutout) a.matting = true
    else delete a.matting
    changed.push(op.cutout ? 'background removed (cutout)' : 'cutout removed')
  }
  return changed
}

// Where an effect or filter goes on the timeline: start_ms and duration_ms, or `over` a segment's time range, or
// the whole video. It goes on the layer above everything it overlaps, as CapCut's own tools place them.
function effectTimeline(draft, op) {
  if (op.over !== undefined) {
    if (op.start_ms !== undefined || op.duration_ms !== undefined) throw new Error('Give over or start_ms and duration_ms, not both')
    const target = find(draft, op.over)
    if (!target.timeline) throw new Error(`${op.over} has no time range`)
    return { 'start.ms': target.timeline['start.ms'], 'duration.ms': target.timeline['duration.ms'] }
  }
  const end = draftDuration(draft)
  if (op.start_ms === undefined && op.duration_ms === undefined) {
    if (end === 0) throw new Error('The draft is empty; add clips first or give start_ms and duration_ms')
    return { 'start.ms': 0, 'duration.ms': end }
  }
  const start = requireMs(op.start_ms, 'start_ms')
  const duration = requireMs(op.duration_ms, 'duration_ms', { min: 1 })
  if (end && start + duration > end) throw new Error(`The range ends at ${start + duration} ms, after the end of the video (${end} ms)`)
  return { 'start.ms': start, 'duration.ms': duration }
}

// The clip that starts exactly where a clip ends, on the same layer: the other side of a transition.
function nextClip(draft, s) {
  const end = s.timeline['start.ms'] + s.timeline['duration.ms']
  return visuals(draft).find(o => o !== s && o.type === 'VIDEO' && o.layout.layer === s.layout.layer && o.timeline['start.ms'] === end)
}

const TRANSITION_KEYS = ['transition', 'transition.duration.ms', 'transition.overlap']

// Drops transitions whose clips no longer touch, after a move, trim or removal. Returns the clip ids.
function dropBrokenTransitions(draft, clips) {
  const dropped = []
  for (const c of clips) {
    if (!c?.attributes?.transition || c.attributes['transition.overlap'] === true || !draft.segments.includes(c)) continue
    const next = nextClip(draft, c)
    const length = c.attributes['transition.duration.ms']
    if (next && !(typeof length === 'number' && (length > c.timeline['duration.ms'] || length > next.timeline['duration.ms']))) continue
    for (const key of TRANSITION_KEYS) delete c.attributes[key]
    dropped.push(c.id)
  }
  return dropped
}

// The lowest layer from 1 up where no other video clip or image overlaps the given time range.
function overlayLayer(draft, timeline) {
  return freeVisualLayer(draft, [timeline], 1)
}

// Where a new video clip or image goes: the main track (appended unless start_ms is given) or, with overlay
// or layer, on top of it. Returns {timeline start, layout}.
function visualPlacement(draft, op, duration) {
  const overlay = op.overlay === true || (op.layer !== undefined && op.layer !== 0)
  if (!overlay) {
    const layout = { layer: 0 }
    applyTransform(layout, op)
    return { start: requireMs(op.start_ms ?? mainTrackEnd(draft), 'start_ms'), layout }
  }
  if (op.start_ms === undefined) throw new Error('An overlay needs start_ms')
  const start = requireMs(op.start_ms, 'start_ms')
  const timeline = { 'start.ms': start, 'duration.ms': duration }
  if (op.layer !== undefined && !(Number.isInteger(op.layer) && op.layer >= 1)) throw new Error('layer must be a whole number of at least 1')
  const layer = op.layer ?? overlayLayer(draft, timeline)
  if (visuals(draft).some(s => s.layout.layer === layer && overlaps(s.timeline, timeline))) throw new Error(`Layer ${layer} already has a clip, image or text at that time`)
  const layout = { layer }
  for (const key of ['position_x', 'position_y']) {
    if (op[key] !== undefined) layout[key] = requireNumber(op[key], key, -2, 2)
  }
  applyTransform(layout, op)
  return { start, layout }
}

// ------------------------------------------------------------------ keyframes

const LAYOUT_KEYS = { position_x: 'position_x', position_y: 'position_y', scale: null, scale_x: 'scale_x', scale_y: 'scale_y', rotation: 'rotation', opacity: 'alpha' }

function requireKeyframes(points, duration) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('keyframes needs at least two {time_ms, value} points')
  const frames = points.map((p, i) => {
    if (!p || !Number.isInteger(p.time_ms) || p.time_ms < 0 || p.time_ms > duration) throw new Error(`keyframe ${i + 1}: time_ms must be a whole number from 0 to the segment's length (${duration})`)
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) throw new Error(`keyframe ${i + 1}: value must be a number`)
    return { 'time.ms': p.time_ms, value: p.value }
  })
  for (let i = 1; i < frames.length; i++) if (frames[i]['time.ms'] <= frames[i - 1]['time.ms']) throw new Error('keyframe times must increase')
  return frames
}

// Project time to source time for volume keyframes, which CapCut times from the start of the source.
function sourceTime(s, projectMs) {
  return Math.round((projectMs - s.timeline['start.ms']) * speedOf(s) + (s.attributes?.['start.ms'] ?? 0))
}

// ------------------------------------------------------------------ speed

export const MIN_SPEED = 0.1
export const MAX_SPEED = 100

// Named ramp shapes. x is the position through the clip (0 = start, 1 = end); y is the speed there, as a
// multiple of `peak` (1 = peak speed) or normal speed (marked n). Each becomes a CapCut speed curve.
const RAMP_SHAPES = {
  ramp_up: peak => [[0, 1], [1, peak]],
  ramp_down: peak => [[0, peak], [1, 1]],
  fast_middle: peak => [[0, 1], [0.25, peak], [0.75, peak], [1, 1]],
  slow_middle: peak => [[0, peak], [0.25, 1], [0.75, 1], [1, peak]],
}

// CapCut's own curve presets, with the same names as in its Speed > Curve panel. The points are read from
// the panel's graphs (dashed lines at 5x and 0.5x); each gives the clip length CapCut shows for a
// 6-second clip, to within its rounding (montage 3s, hero 3s, bullet 2s, jump_cut 9s, flash_in 3s, flash_out 3s).
const CAPCUT_PRESETS = {
  montage: [[0, 5], [0.1, 5], [0.28, 2.7], [0.5, 7.7], [0.65, 1], [1, 1]],
  hero: [[0, 1], [0.35, 5], [0.44, 0.5], [0.55, 0.5], [0.65, 5], [1, 1]],
  bullet: [[0, 5], [0.41, 5], [0.47, 0.5], [0.55, 0.5], [0.61, 5], [1, 5]],
  jump_cut: [[0, 0.6], [0.43, 0.6], [0.5, 5], [0.57, 0.6], [1, 0.6]],
  flash_in: [[0, 5], [0.4, 5], [0.6, 1], [1, 1]],
  flash_out: [[0, 1], [0.4, 1], [0.6, 5], [1, 5]],
}

function checkSpeed(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_SPEED || value > MAX_SPEED) {
    throw new Error(`${name} must be a number from ${MIN_SPEED} to ${MAX_SPEED}`)
  }
  return value
}

// Points [{x, y}]: x from 0 to 1 in increasing order, starting at 0 and ending at 1; y is a speed.
function checkCurve(points) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('points needs at least two {x, y} points')
  const clean = points.map((p, i) => {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') throw new Error(`point ${i + 1} needs numeric x and y`)
    if (p.x < 0 || p.x > 1) throw new Error(`point ${i + 1}: x must be from 0 to 1`)
    return { x: p.x, y: checkSpeed(p.y, `point ${i + 1} y`) }
  })
  for (let i = 1; i < clean.length; i++) if (clean[i].x <= clean[i - 1].x) throw new Error('point x values must increase')
  if (clean[0].x !== 0 || clean.at(-1).x !== 1) throw new Error('points must start at x 0 and end at x 1')
  return clean
}

// The average playback speed of a curve whose x runs through the source: total source divided by total
// playback time. Each stretch between two points plays at the mean of its end speeds, the same estimate
// CapCut's draft tools use, so clip lengths match what CapCut computes.
export function curveAverageSpeed(points) {
  let playback = 0
  for (let i = 1; i < points.length; i++) playback += (points[i].x - points[i - 1].x) / ((points[i].y + points[i - 1].y) / 2)
  return 1 / playback
}

export function speedOf(segment) {
  const a = segment.attributes ?? {}
  if (typeof a.curve_speed === 'string') {
    try { return curveAverageSpeed(checkCurve(JSON.parse(a.curve_speed))) } catch { return 1 }
  }
  return typeof a.speed === 'number' && a.speed > 0 ? a.speed : 1
}

function speedableVideo(draft, id) {
  const s = find(draft, id)
  if (s.type !== 'VIDEO') throw new Error(`${id} is ${s.type}, not a video clip`)
  if (s.attributes?.meta_type === 'photo') throw new Error(`${id} is a still image, which can't change speed`)
  const a = s.attributes ?? {}
  if (!Number.isInteger(a['start.ms']) || !Number.isInteger(a['end.ms'])) throw new Error(`${id} has no source range to retime`)
  return s
}

// Sets a clip's timeline length from its source range and speed. On the main track, later clips move with it.
function retime(draft, s) {
  const a = s.attributes
  const oldEnd = s.timeline['start.ms'] + s.timeline['duration.ms']
  const duration = Math.max(1, Math.round((a['end.ms'] - a['start.ms']) / speedOf(s)))
  const delta = duration - s.timeline['duration.ms']
  s.timeline['duration.ms'] = duration
  delete s.timeline['end.ms'] // CapCut's read-back adds end.ms; duration.ms wins, so drop the stale value
  let moved = 0
  if (delta !== 0 && s.layout?.layer === 0) {
    for (const other of draft.segments) {
      if (other !== s && other.type === 'VIDEO' && other.layout?.layer === 0 && other.timeline && other.timeline['start.ms'] >= oldEnd) {
        other.timeline['start.ms'] += delta
        delete other.timeline['end.ms']
        moved++
      }
    }
  }
  const change = delta === 0 ? 'length unchanged' : `${delta < 0 ? 'shorter' : 'longer'} by ${(Math.abs(delta) / 1000).toFixed(1)}s`
  const note = moved ? `; ${moved} later main-track clip${moved > 1 ? 's' : ''} moved to match. Text, captions and audio were not moved` : ''
  return `now ${(duration / 1000).toFixed(1)}s (${change})${note}`
}

// ------------------------------------------------------------------ validation

export function validate(draft) {
  const errors = []
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.segments)) return ['The document must be an object with a "segments" array']
  if (typeof draft.version !== 'string') errors.push('The document needs a "version" string')
  const roots = draft.segments.filter(s => s?.type === 'DRAFT')
  if (roots.length !== 1) errors.push(`Expected exactly one DRAFT segment, found ${roots.length}`)
  const rootId = roots[0]?.id
  const byId = new Map(draft.segments.filter(s => typeof s?.id === 'string').map(s => [s.id, s]))
  const ratio = roots[0]?.attributes?.ratio_type
  if (ratio !== undefined && !RATIO_TYPES.has(ratio)) errors.push(`The canvas ratio "${ratio}" is not one CapCut accepts`)
  const ids = new Set()
  for (const [index, s] of draft.segments.entries()) {
    const label = `segment ${index} (${s?.id ?? 'no id'})`
    if (!s || typeof s.id !== 'string' || !s.id) { errors.push(`${label} needs a string id`); continue }
    if (ids.has(s.id)) errors.push(`${label} has a duplicate id`)
    ids.add(s.id)
    if (s.type === 'DRAFT') continue
    if (rootId && !byId.has(s.parent_id)) errors.push(`${label} points at a parent "${s.parent_id}" that isn't in the draft`)
    if (!TYPES.has(s.type)) continue // Other types are kept as-is for CapCut to judge.
    const a = s.attributes ?? {}
    const parent = byId.get(s.parent_id)
    const onClip = EFFECT_TYPES.has(s.type) && parent?.type === 'VIDEO'
    if (rootId && s.parent_id !== rootId && !onClip) errors.push(`${label} must have parent_id "${rootId}"${EFFECT_TYPES.has(s.type) ? ' or a video clip' : ''}`)
    if (!onClip) {
      const t = s.timeline
      if (!t || !Number.isInteger(t['start.ms']) || t['start.ms'] < 0) errors.push(`${label} needs timeline["start.ms"] >= 0`)
      if (!t || !Number.isInteger(t['duration.ms']) || t['duration.ms'] <= 0) errors.push(`${label} needs timeline["duration.ms"] > 0`)
      if (!Number.isInteger(s.layout?.layer)) errors.push(`${label} needs layout.layer`)
    }
    if (s.type === 'TEXT' && !(typeof a.content === 'string' && a.content.trim())) errors.push(`${label} needs text content`)
    if (s.type === 'SUBTITLE_TEMPLATE' && !(typeof a.content === 'string' && a.content.trim())) errors.push(`${label} needs caption text`)
    if (s.type === 'TEXT_TEMPLATE' && !(Array.isArray(a.contents) && a.contents.length && a.contents.every(c => typeof c === 'string'))) errors.push(`${label} needs contents, a list of texts`)
    if (['VIDEO', 'AUDIO', 'TEXT_TEMPLATE', 'VIDEO_EFFECT', 'COLOR_FILTER'].includes(s.type) && typeof a.source !== 'string') errors.push(`${label} needs a source`)
    if ('intensity' in a && !(Number(a.intensity) >= 0 && Number(a.intensity) <= 1)) errors.push(`${label} has intensity outside 0 to 1`)
    if ('effects_adjust_intensity' in a && !(Number(a.effects_adjust_intensity) >= 0 && Number(a.effects_adjust_intensity) <= 1)) errors.push(`${label} has intensity outside 0 to 1`)
    if ('blend_intensity' in a && !(Number(a.blend_intensity) >= 0 && Number(a.blend_intensity) <= 1)) errors.push(`${label} has blend_intensity outside 0 to 1`)
    if ('matting' in a && typeof a.matting !== 'boolean') errors.push(`${label} has a matting value that isn't true or false`)
    if ('start.ms' in a && 'end.ms' in a && a['end.ms'] <= a['start.ms']) errors.push(`${label} has a source range that ends before it starts`)
    if (s.type === 'VIDEO' && a.meta_type === 'photo' && ('speed' in a || 'curve_speed' in a)) errors.push(`${label} is a still image, which cannot have speed or curve_speed`)
    for (const holder of [a, s.layout ?? {}]) {
      for (const [key, frames] of Object.entries(holder)) {
        if (!key.endsWith('.keyframes')) continue
        if (!Array.isArray(frames) || frames.some(f => !f || !Number.isInteger(f['time.ms']) || f['time.ms'] < 0 || !('value' in f))) errors.push(`${label} has invalid ${key}`)
      }
    }
    for (const key of ['caption_timeline', 'subtitle_timeline']) {
      const entries = a[key]
      if (entries === undefined) continue
      const length = s.timeline?.['duration.ms'] ?? Infinity
      if (!Array.isArray(entries) || entries.some(e => !e || typeof e.text !== 'string' || !(Number(e['end.ms']) >= Number(e['start.ms'])) || Number(e['start.ms']) < 0 || Number(e['end.ms']) > length)) {
        errors.push(`${label} has word timings outside the caption`)
      }
    }
    if (s.layout && 'alpha' in s.layout && !(s.layout.alpha >= 0 && s.layout.alpha <= 1)) errors.push(`${label} has opacity outside 0 to 1`)
    if ('curve_speed' in a) {
      try { checkCurve(JSON.parse(a.curve_speed)) } catch (e) { errors.push(`${label} has an invalid curve_speed: ${e.message}`) }
    }
  }
  const mainTrack = visuals(draft).filter(s => s.type === 'VIDEO' && s.layout.layer === 0)
    .sort((x, y) => x.timeline['start.ms'] - y.timeline['start.ms'])
  for (let i = 1; i < mainTrack.length; i++) {
    const prev = mainTrack[i - 1]
    if (prev.timeline['start.ms'] + prev.timeline['duration.ms'] > mainTrack[i].timeline['start.ms']) {
      errors.push(`Main-track clips ${prev.id} and ${mainTrack[i].id} overlap`)
    }
  }
  // Clips, images, text, effects and filters share layers in CapCut; two on the same layer must not overlap in time.
  const shared = visuals(draft).filter(s => !(s.type === 'VIDEO' && s.layout.layer === 0))
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      if (shared[i].layout.layer === shared[j].layout.layer && overlaps(shared[i].timeline, shared[j].timeline)) {
        errors.push(`${shared[i].id} and ${shared[j].id} overlap on layer ${shared[i].layout.layer} (clips, images, text and effects share layers in CapCut)`)
      }
    }
  }
  for (const m of mainTrack) {
    for (const o of visuals(draft).filter(x => x.type !== 'VIDEO' && x.layout.layer === 0)) {
      if (overlaps(m.timeline, o.timeline)) errors.push(`${o.id} is on layer 0 with the main track`)
    }
  }
  return errors
}

// ------------------------------------------------------------------ operations

const OPERATIONS = {
  // {op, content, start_ms, duration_ms, position_y?, position_x?, font_size?, font_color?, font?, plus text
  // style fields (alignment, outline, shadow, box, ...) and scale, rotation, opacity}
  add_text(draft, op) {
    if (!(typeof op.content === 'string' && op.content.trim())) throw new Error('content is required')
    const id = uniqueId(draft, 'text')
    const attributes = { ...TEXT_STYLE, content: op.content }
    if (op.font_size !== undefined) attributes.font_size = op.font_size
    if (op.font_color) attributes.font_color = attributes.text_color = op.font_color
    attributes.font = op.font ? requireSource(op.font, ['vimo']) : DEFAULT_FONT
    applyTextStyle(attributes, op)
    const layout = { layer: nextLayer(draft, 'TEXT', TEXT_LAYER_BASE), position_x: op.position_x ?? 0, position_y: op.position_y ?? 0.4 }
    applyTransform(layout, op)
    draft.segments.push({
      id,
      type: 'TEXT',
      parent_id: root(draft).id,
      timeline: { 'start.ms': requireMs(op.start_ms, 'start_ms'), 'duration.ms': requireMs(op.duration_ms, 'duration_ms', { min: 1 }) },
      layout,
      attributes,
    })
    return `Added text "${op.content}" (${id}) at ${op.start_ms} ms for ${op.duration_ms} ms`
  },

  // {op, cues: [{start_ms, end_ms, text, words?: [{text, start_ms, end_ms}]}], position_y?, font_size?, font?, layer?,
  // style?: {text style fields}, template?: "vimo://..."}
  // Captions are TEXT segments with a caption_timeline (word timings), which is how CapCut tells captions from
  // plain text. With template (a caption template already in the draft), they become caption-template segments.
  add_captions(draft, op) {
    if (!Array.isArray(op.cues) || op.cues.length === 0) throw new Error('cues must be a non-empty array')
    const timelines = op.cues.map((cue, i) => {
      const start = requireMs(cue.start_ms, `cue ${i + 1} start_ms`)
      return { 'start.ms': start, 'duration.ms': requireMs(cue.end_ms, `cue ${i + 1} end_ms`, { min: start + 1 }) - start }
    })
    if (op.layer !== undefined && !(Number.isInteger(op.layer) && op.layer >= 1)) throw new Error('layer must be a whole number of at least 1')
    const template = op.template === undefined ? null : requireSource(op.template, ['vimo'])
    if (template && (op.font !== undefined || op.font_size !== undefined || op.style !== undefined)) throw new Error('A caption template brings its own look; leave out font, font_size and style')
    const layer = op.layer ?? captionLayer(draft, timelines)
    if (op.layer !== undefined && freeVisualLayer(draft, timelines, op.layer) !== op.layer) throw new Error(`Layer ${op.layer} already has a clip, image or text during these captions`)
    const added = []
    for (const [i, cue] of op.cues.entries()) {
      const start = timelines[i]['start.ms']
      const end = start + timelines[i]['duration.ms']
      if (!(typeof cue.text === 'string' && cue.text.trim())) throw new Error(`cue ${i + 1} has no text`)
      const text = cue.text.trim()
      const words = captionTimeline(text, start, end, cue.words, `cue ${i + 1}`)
      const id = uniqueId(draft, 'caption')
      let attributes
      if (template) {
        attributes = { source: template, content: text, subtitle_timeline: words }
      } else {
        attributes = { ...TEXT_STYLE, content: text, caption_timeline: words }
        if (op.font_size !== undefined) attributes.font_size = op.font_size
        attributes.font = op.font ? requireSource(op.font, ['vimo']) : DEFAULT_FONT
        if (op.style) applyTextStyle(attributes, op.style)
      }
      draft.segments.push({
        id,
        type: template ? 'SUBTITLE_TEMPLATE' : 'TEXT',
        parent_id: root(draft).id,
        timeline: { 'start.ms': start, 'duration.ms': end - start },
        layout: { layer, position_x: 0, position_y: op.position_y ?? -0.6 },
        attributes,
      })
      added.push(id)
    }
    return `Added ${added.length} caption${added.length > 1 ? "s" : ""}${template ? ' with a caption template' : ''} on layer ${layer}`
  },

  // {op, source: "sid://..." (searched music) | "vid://..." | "vimo://..." | "tos://...", start_ms?, duration_ms?,
  // source_start_ms? (where in the track to start, e.g. the chorus), kind?: "music" | "sound", volume?,
  // fade_in_ms?, fade_out_ms?, loop?}
  add_audio(draft, op) {
    const source = requireSource(op.source, ['sid', 'vid', 'vimo', 'tos'])
    const start = requireMs(op.start_ms ?? 0, 'start_ms')
    const duration = requireMs(op.duration_ms ?? Math.max(1, draftDuration(draft) - start), 'duration_ms', { min: 1 })
    const from = requireMs(op.source_start_ms ?? 0, 'source_start_ms')
    if (op.kind !== undefined && !['music', 'sound'].includes(op.kind)) throw new Error('kind must be music or sound')
    const id = uniqueId(draft, 'audio')
    const attributes = { source, volume: op.volume ?? 1, auto_loop: op.loop ?? (op.kind !== 'sound'), 'end.ms': from + duration }
    if (from) attributes['start.ms'] = from
    if (op.kind) attributes.meta_type = op.kind === 'sound' ? 'SOUND' : 'MUSIC'
    if (op.fade_in_ms) attributes['fade_in.ms'] = requireMs(op.fade_in_ms, 'fade_in_ms')
    if (op.fade_out_ms) attributes['fade_out.ms'] = requireMs(op.fade_out_ms, 'fade_out_ms')
    draft.segments.push({
      id,
      type: 'AUDIO',
      parent_id: root(draft).id,
      timeline: { 'start.ms': start, 'duration.ms': duration },
      layout: { layer: nextLayer(draft, 'AUDIO', AUDIO_LAYER_BASE) },
      attributes,
    })
    return `Added audio ${source} (${id}) at ${start} ms for ${duration} ms`
  },

  // {op, source: "vid://...", source_start_ms?, source_end_ms, start_ms?, volume?, overlay?, layer?, position_x?,
  // position_y?, scale?, rotation?, opacity?, crop?, background_blur?, background_color?}
  // Appends to the end of the main track unless start_ms is given. overlay: true (with start_ms) puts it on top
  // of the main track instead, on the lowest free layer, as picture-in-picture.
  add_video(draft, op) {
    const source = requireSource(op.source, ['vid'])
    const from = requireMs(op.source_start_ms ?? 0, 'source_start_ms')
    const to = requireMs(op.source_end_ms, 'source_end_ms', { min: from + 1 })
    const { start, layout } = visualPlacement(draft, op, to - from)
    const id = uniqueId(draft, 'video')
    const s = {
      id,
      type: 'VIDEO',
      parent_id: root(draft).id,
      timeline: { 'start.ms': start, 'duration.ms': to - from },
      layout,
      attributes: { source, meta_type: 'video', 'start.ms': from, 'end.ms': to, volume: op.volume ?? 1 },
    }
    applyClipLook(s, op)
    draft.segments.push(s)
    return `Added video ${source} (${id}) for ${to - from} ms${layout.layer ? ` as an overlay on layer ${layout.layer}` : ''}`
  },

  // {op, source: "tos://..." (an uploaded image's uri; the tos:// prefix is added if missing), duration_ms, start_ms?,
  // overlay?, layer?, position_x?, position_y?, scale?, rotation?, opacity?, crop?, background_blur?, background_color?}
  // A still image on the main track, shown for duration_ms. Appends to the end of the main track unless start_ms is
  // given. overlay: true (with start_ms) puts it on top instead, for a logo or a picture-in-picture photo.
  add_image(draft, op) {
    const raw = typeof op.source === 'string' ? op.source.trim() : ''
    if (!raw) throw new Error('source is required')
    const source = requireSource(raw.includes('://') ? raw : `tos://${raw.replace(/^\/+/, '')}`, ['tos', 'vid', 'asset'])
    const duration = requireMs(op.duration_ms, 'duration_ms', { min: 1 })
    const { start, layout } = visualPlacement(draft, op, duration)
    const id = uniqueId(draft, 'image')
    const s = {
      id,
      type: 'VIDEO',
      parent_id: root(draft).id,
      timeline: { 'start.ms': start, 'duration.ms': duration },
      layout,
      attributes: { source, meta_type: 'photo', 'start.ms': 0 },
    }
    applyClipLook(s, op)
    draft.segments.push(s)
    return `Added image ${source} (${id}) for ${duration} ms${layout.layer ? ` as an overlay on layer ${layout.layer}` : ''}`
  },

  // {op, id, content?, texts? (text templates), source? (music, sound, effect, filter, text template, video clip),
  // intensity? (effect, filter), volume?, font_size?, font_color?, font?, fade_in_ms?, fade_out_ms?, text style
  // fields (text and captions), crop?, background_blur?, background_color?, blend_mode?, blend_intensity?, cutout?
  // (video clips and images)}
  update(draft, op) {
    const s = find(draft, op.id)
    const a = s.attributes ?? (s.attributes = {})
    const before = clone(a)
    const changed = []
    const isText = s.type === 'TEXT'
    if (op.content !== undefined) {
      if (!['TEXT', 'SUBTITLE_TEMPLATE'].includes(s.type)) throw new Error(`content can only be changed on text and captions${s.type === 'TEXT_TEMPLATE' ? '; use texts for a text template' : ''}`)
      const text = String(op.content).trim()
      if (!text) throw new Error('content cannot be empty')
      a.content = text; changed.push('content')
      // content and the word timings are the same text twice; rewrite them together, as one sentence.
      const key = timelineKey(s)
      if (a[key] !== undefined || s.type === 'SUBTITLE_TEMPLATE') a[key] = [{ text, 'start.ms': 0, 'end.ms': s.timeline['duration.ms'] }]
      const dropped = clipStyleCopies(draft, s)
      if (dropped) changed.push(`${dropped} style cop${dropped > 1 ? 'ies' : 'y'} past the new text dropped`)
    }
    if (op.texts !== undefined) {
      if (s.type !== 'TEXT_TEMPLATE') throw new Error('texts works only on text templates')
      if (!Array.isArray(op.texts) || !op.texts.length || op.texts.some(t => typeof t !== 'string' || !t.trim())) throw new Error('texts must be a list of non-empty texts, one per slot')
      a.contents = op.texts.map(t => t.trim()); changed.push('texts')
    }
    if (op.source !== undefined) {
      const kinds = { AUDIO: ['sid', 'vid', 'vimo', 'tos'], VIDEO: a.meta_type === 'photo' ? ['tos', 'vid', 'asset'] : ['vid', 'asset'], VIDEO_EFFECT: ['vimo'], COLOR_FILTER: ['vimo'], TEXT_TEMPLATE: ['vimo'], SUBTITLE_TEMPLATE: ['vimo'] }[s.type]
      if (!kinds) throw new Error(`${s.type} segments have no source to replace`)
      a.source = requireSource(op.source, kinds); changed.push('source')
    }
    if (op.intensity !== undefined) {
      if (!EFFECT_TYPES.has(s.type)) throw new Error('intensity works only on effects and filters')
      a[s.type === 'COLOR_FILTER' ? 'intensity' : 'effects_adjust_intensity'] = requireNumber(op.intensity, 'intensity', 0, 1); changed.push('intensity')
    }
    if (op.volume !== undefined) {
      if (!['VIDEO', 'AUDIO'].includes(s.type)) throw new Error('Only video clips and audio have volume; text has no volume')
      if (typeof op.volume !== 'number' || op.volume < 0 || op.volume > 4) throw new Error('volume must be a number from 0 to 4')
      a.volume = op.volume; changed.push('volume')
    }
    if (op.font_size !== undefined || op.font_color || op.font) {
      if (!isText) throw new Error('font, font_size and font_color work only on text and plain captions')
      if (op.font_size !== undefined) { a.font_size = op.font_size; changed.push('font_size') }
      if (op.font_color) { a.font_color = a.text_color = requireColor(op.font_color, 'font_color'); changed.push('font_color') }
      if (op.font) { a.font = requireSource(op.font, ['vimo']); changed.push('font') }
    }
    if (op.fade_in_ms !== undefined) { a['fade_in.ms'] = requireMs(op.fade_in_ms, 'fade_in_ms'); changed.push('fade_in') }
    if (op.fade_out_ms !== undefined) { a['fade_out.ms'] = requireMs(op.fade_out_ms, 'fade_out_ms'); changed.push('fade_out') }
    const styled = applyTextStyle({}, op)
    if (styled.length) {
      if (!isText) throw new Error('Text style fields work only on text and plain captions')
      applyTextStyle(a, op, changed)
    }
    applyClipLook(s, op, changed)
    if (changed.length === 0) throw new Error('update needs at least one field to change')
    if (isText) {
      const copies = syncStyleCopies(draft, s, before)
      if (copies) changed.push(`also written to ${copies} per-letter style cop${copies > 1 ? 'ies' : 'y'}`)
    }
    return `Updated ${s.id}: ${changed.join(', ')}`
  },

  // {op, id, start_ms?, duration_ms?, position_x?, position_y?, layer?, scale?, scale_x?, scale_y?, rotation?, opacity?}
  place(draft, op) {
    const s = find(draft, op.id)
    const changed = []
    if (op.start_ms !== undefined || op.duration_ms !== undefined) delete s.timeline['end.ms'] // stale once moved or trimmed
    if (op.start_ms !== undefined) { s.timeline['start.ms'] = requireMs(op.start_ms, 'start_ms'); changed.push('start') }
    if (op.duration_ms !== undefined) {
      const duration = requireMs(op.duration_ms, 'duration_ms', { min: 1 })
      const isPhoto = s.attributes?.meta_type === 'photo'
      if (s.type === 'VIDEO' && !isPhoto && 'start.ms' in (s.attributes ?? {})) s.attributes['end.ms'] = s.attributes['start.ms'] + Math.round(duration * speedOf(s))
      // Word timings must stay inside the caption. One whole-sentence entry stretches to the new length.
      const key = timelineKey(s)
      const words = s.attributes?.[key]
      if (Array.isArray(words)) {
        if (words.length === 1) words[0]['end.ms'] = duration
        else if (words.some(w => Number(w['end.ms']) > duration)) throw new Error(`${s.id}'s word timings run past ${duration} ms; change its text with update content first`)
      }
      s.timeline['duration.ms'] = duration; changed.push('duration')
    }
    for (const key of ['position_x', 'position_y']) {
      if (op[key] !== undefined) {
        if (typeof op[key] !== 'number' || op[key] < -1 || op[key] > 1) throw new Error(`${key} must be between -1 and 1`)
        s.layout[key] = op[key]; changed.push(key)
      }
    }
    if (op.layer !== undefined) { s.layout.layer = op.layer; changed.push('layer') }
    if (s.type !== 'AUDIO') applyTransform(s.layout, op, changed)
    if (changed.length === 0) throw new Error('place needs at least one field to change')
    if (s.type === 'VIDEO') {
      const before = visuals(draft).filter(o => o.type === 'VIDEO' && o.attributes?.transition)
      const dropped = dropBrokenTransitions(draft, before)
      if (dropped.length) changed.push(`transition removed from ${dropped.join(', ')} because its clips no longer touch`)
    }
    return `Moved ${s.id}: ${changed.join(', ')}`
  },

  // {op, layer?}: packs every caption (TEXT segment whose id starts with "caption") back onto the lowest layers from
  // `layer` (default 1): one layer when no captions overlap in time. Run before every save: CapCut's read-back spreads
  // captions over extra layers, and saving those layers adds tracks.
  reset_caption_layers(draft, op) {
    const base = op.layer ?? CAPTION_LAYER
    if (!(Number.isInteger(base) && base >= 1)) throw new Error('layer must be a whole number of at least 1')
    const captions = draft.segments
      .filter(s => ['TEXT', 'SUBTITLE_TEMPLATE'].includes(s.type) && s.timeline && typeof s.id === 'string' && s.id.startsWith('caption'))
      .sort((a, b) => a.timeline['start.ms'] - b.timeline['start.ms'])
    if (captions.length === 0) throw new Error('The draft has no captions (TEXT segments whose id starts with "caption")')
    // Group captions that don't overlap each other, then give each group the lowest layer from `base` that no
    // other clip, image or text uses during those captions (CapCut shares layers between them).
    const groups = []
    for (const s of captions) {
      const group = groups.find(g => !g.some(c => overlaps(c.timeline, s.timeline)))
      if (group) group.push(s)
      else groups.push([s])
    }
    const skip = new Set(captions)
    const used = []
    for (const group of groups) {
      let layer = base
      for (;;) {
        layer = freeVisualLayer(draft, group.map(c => c.timeline), layer, skip)
        if (!used.includes(layer)) break
        layer++
      }
      for (const c of group) c.layout = { ...(c.layout ?? {}), layer }
      used.push(layer)
    }
    used.sort((a, b) => a - b)
    return `Put ${captions.length} caption${captions.length > 1 ? "s" : ""} on layer${used.length > 1 ? 's' : ''} ${used.join(', ')}`
  },

  // {op, id, property: "position_x" | "position_y" | "scale" | "scale_x" | "scale_y" | "rotation" | "opacity",
  //  keyframes: [{time_ms, value}]}: animates a visual segment over time. time_ms counts from the segment's start
  // on the timeline. An empty keyframes array removes that animation.
  animate(draft, op) {
    const s = find(draft, op.id)
    if (!['VIDEO', 'TEXT'].includes(s.type)) throw new Error(`${op.id} is ${s.type}; only video clips, images and text can be animated`)
    if (!Object.hasOwn(LAYOUT_KEYS, op.property)) throw new Error(`property must be one of ${Object.keys(LAYOUT_KEYS).join(', ')}`)
    const keys = op.property === 'scale' ? ['scale_x', 'scale_y'] : [LAYOUT_KEYS[op.property]]
    if (Array.isArray(op.keyframes) && op.keyframes.length === 0) {
      for (const key of keys) delete s.layout[`${key}.keyframes`]
      return `Removed the ${op.property} animation from ${s.id}`
    }
    const frames = requireKeyframes(op.keyframes, s.timeline['duration.ms'])
    if (op.property === 'opacity' && frames.some(f => f.value < 0 || f.value > 1)) throw new Error('opacity keyframe values must be from 0 to 1')
    for (const key of keys) s.layout[`${key}.keyframes`] = frames.map(f => ({ ...f }))
    return `Animated ${s.id} ${op.property} with ${frames.length} keyframes`
  },

  // {op, id, from?: 1, to?: 1.15, pan?: "left" | "right" | "up" | "down", pan_amount?: 0.1}
  // A slow zoom (the Ken Burns effect) over a clip or image's whole length: scale goes from `from` to `to`,
  // with an optional drift in one direction. Use to < from to zoom out.
  zoom(draft, op) {
    const s = find(draft, op.id)
    if (s.type !== 'VIDEO') throw new Error(`${op.id} is ${s.type}; zoom works on video clips and images`)
    const from = requireNumber(op.from ?? 1, 'from', 0.1, 5)
    const to = requireNumber(op.to ?? 1.15, 'to', 0.1, 5)
    const end = s.timeline['duration.ms']
    for (const key of ['scale_x', 'scale_y']) s.layout[`${key}.keyframes`] = [{ 'time.ms': 0, value: from }, { 'time.ms': end, value: to }]
    let pan = ''
    if (op.pan !== undefined) {
      const dir = { left: ['position_x', -1], right: ['position_x', 1], up: ['position_y', 1], down: ['position_y', -1] }[op.pan]
      if (!dir) throw new Error('pan must be left, right, up or down')
      const amount = requireNumber(op.pan_amount ?? 0.1, 'pan_amount', 0, 1)
      const base = s.layout[dir[0]] ?? 0
      s.layout[`${dir[0]}.keyframes`] = [{ 'time.ms': 0, value: base }, { 'time.ms': end, value: base + dir[1] * amount }]
      pan = ` and drifts ${op.pan}`
    }
    return `${s.id} zooms from ${from}x to ${to}x over ${(end / 1000).toFixed(1)}s${pan}`
  },

  // {op, id, ranges: [{start_ms, end_ms}], to?: 0.25, fade_ms?: 300}: lowers a music or sound track to `to`
  // (a fraction of its volume) during each project-time range, for speech or a key moment.
  // CapCut's cloud drafts drop volume keyframes, so the track is split into back-to-back parts instead: quieter
  // parts during the ranges, and short crossfades (overlapping parts on two layers) at each change.
  duck(draft, op) {
    const s = find(draft, op.id)
    if (s.type !== 'AUDIO') throw new Error(`${op.id} is ${s.type}; duck works on music and sound tracks. Lower a video clip's own sound with update volume.`)
    if (!Array.isArray(op.ranges) || op.ranges.length === 0) throw new Error('ranges must be a non-empty array of {start_ms, end_ms}')
    const a = s.attributes
    const level = a.volume ?? 1
    const low = Math.round(level * requireNumber(op.to ?? 0.25, 'to', 0, 1) * 1000) / 1000
    const fade = requireMs(op.fade_ms ?? 300, 'fade_ms')
    const S = s.timeline['start.ms'], E = S + s.timeline['duration.ms']
    let ranges = op.ranges.map((r, i) => {
      const start = requireMs(r.start_ms, `range ${i + 1} start_ms`)
      const end = requireMs(r.end_ms, `range ${i + 1} end_ms`, { min: start + 1 })
      return [Math.max(start, S), Math.min(end, E)]
    }).filter(([x, y]) => y > x).map(([x, y]) => {
      // A dip shorter than one fade can't crossfade in and out; widen it to the fade length.
      if (y - x >= fade) return [x, y]
      const mid = (x + y) / 2
      return [Math.max(S, Math.round(mid - fade / 2)), Math.min(E, Math.round(mid + fade / 2))]
    }).sort((x, y) => x[0] - y[0])
    if (ranges.length === 0) throw new Error(`None of the ranges fall within ${s.id} on the timeline`)
    // Merge ranges closer together than a crossfade, so parts are never shorter than the fades.
    ranges = ranges.reduce((out, r) => {
      if (out.length && r[0] - out.at(-1)[1] < 2 * fade) out.at(-1)[1] = Math.max(out.at(-1)[1], r[1])
      else out.push([...r])
      return out
    }, [])
    // Back-to-back parts covering [S, E]: [start, end, volume].
    const parts = []
    let at = S
    for (const [x, y] of ranges) {
      if (x - at > 0) parts.push([at, x, level])
      parts.push([x, y, low])
      at = y
    }
    if (E > at) parts.push([at, E, level])
    const speed = typeof a.speed === 'number' && a.speed > 0 ? a.speed : 1
    const src0 = a['start.ms'] ?? 0
    const altLayer = nextLayer(draft, 'AUDIO', AUDIO_LAYER_BASE)
    const half = Math.floor(fade / 2)
    const ids = new Set(draft.segments.map(x => x.id))
    const partId = () => { for (let n = 0; ; n++) { const id = `${s.id}_part_${n}`; if (!ids.has(id)) { ids.add(id); return id } } }
    const made = parts.map(([x, y, volume], i) => {
      const first = i === 0, last = i === parts.length - 1
      // Each inner boundary overlaps both neighbours by half a fade, for a crossfade.
      const start = first ? x : Math.max(S, x - half)
      const end = last ? y : Math.min(E, y + half)
      const attributes = { ...a, volume, 'start.ms': Math.round(src0 + (start - S) * speed), 'end.ms': Math.round(src0 + (end - S) * speed) }
      delete attributes['volume.keyframes']
      delete attributes['duration.ms']
      if (first) delete attributes['fade_in.ms']
      if (!first) attributes['fade_in.ms'] = Math.min(fade, end - start)
      if (last) { delete attributes['fade_out.ms']; if (a['fade_out.ms'] !== undefined) attributes['fade_out.ms'] = a['fade_out.ms'] } else attributes['fade_out.ms'] = Math.min(fade, end - start)
      if (first && a['fade_in.ms'] !== undefined) attributes['fade_in.ms'] = a['fade_in.ms']
      const timeline = { 'start.ms': start, 'duration.ms': end - start }
      const layout = { ...(s.layout ?? {}), layer: i % 2 === 0 ? s.layout.layer : altLayer }
      return { ...s, id: first ? s.id : partId(), timeline, layout, attributes }
    })
    draft.segments.splice(draft.segments.indexOf(s), 1, ...made)
    return `Split ${s.id} into ${made.length} parts so it drops to ${Math.round((low / (level || 1)) * 100)}% during ${ranges.length} range${ranges.length > 1 ? 's' : ''}, with ${fade} ms crossfades`
  },

  // {op, id, speed}: plays a video clip at a constant speed (2 = twice as fast, 0.5 = half speed, 1 = normal).
  // Replaces any speed ramp. The clip's length changes to match; later main-track clips move with it.
  set_speed(draft, op) {
    const s = speedableVideo(draft, op.id)
    const speed = checkSpeed(op.speed, 'speed')
    delete s.attributes.curve_speed
    if (speed === 1) delete s.attributes.speed
    else s.attributes.speed = speed
    return `Set ${s.id} to ${speed}x: ${retime(draft, s)}`
  },

  // {op, id, shape?, peak?, points?: [{x, y}]}
  // A speed ramp on a video clip, written as CapCut's curve_speed. shape is one of CapCut's presets (montage,
  // hero, bullet, jump_cut, flash_in, flash_out) or a basic shape (ramp_up, ramp_down, fast_middle,
  // slow_middle; peak speed, default 3, and for slow_middle the ends run at peak). Or give custom points.
  speed_ramp(draft, op) {
    const s = speedableVideo(draft, op.id)
    let points
    if (op.points !== undefined) {
      if (op.shape !== undefined) throw new Error('Give shape or points, not both')
      points = checkCurve(op.points)
    } else {
      const preset = Object.hasOwn(CAPCUT_PRESETS, op.shape) ? CAPCUT_PRESETS[op.shape] : null
      const make = Object.hasOwn(RAMP_SHAPES, op.shape) ? RAMP_SHAPES[op.shape] : null
      if (!preset && !make) throw new Error(`shape must be one of ${[...Object.keys(CAPCUT_PRESETS), ...Object.keys(RAMP_SHAPES)].join(', ')}, or give points`)
      if (preset && op.peak !== undefined) throw new Error(`peak works only with ${Object.keys(RAMP_SHAPES).join(', ')}; ${op.shape} is a fixed CapCut preset`)
      points = (preset ?? make(checkSpeed(op.peak ?? 3, 'peak'))).map(([x, y]) => ({ x, y }))
    }
    delete s.attributes.speed
    s.attributes.curve_speed = JSON.stringify(points)
    const label = op.shape ? `${op.shape.replace('_', ' ')} ${Object.hasOwn(CAPCUT_PRESETS, op.shape) ? 'curve' : 'ramp'}` : 'custom speed ramp'
    return `Added a ${label} to ${s.id}: ${retime(draft, s)}`
  },

  // {op, id}: removes a segment with everything under it (effects on a clip, a text's style copies). A transition
  // into a removed clip is removed too.
  remove(draft, op) {
    const s = find(draft, op.id)
    const gone = new Set([s])
    for (let grew = true; grew;) {
      grew = false
      for (const x of draft.segments) if (!gone.has(x) && [...gone].some(g => g.id === x.parent_id)) { gone.add(x); grew = true }
    }
    const before = s.type === 'VIDEO' ? visuals(draft).filter(o => o !== s && o.type === 'VIDEO' && o.attributes?.transition) : []
    draft.segments = draft.segments.filter(x => !gone.has(x))
    const dropped = dropBrokenTransitions(draft, before)
    const extra = gone.size > 1 ? ` with ${gone.size - 1} segment${gone.size > 2 ? 's' : ''} attached to it` : ''
    const note = dropped.length ? ` The transition on ${dropped.join(', ')} was removed too.` : ''
    return `Removed ${s.type} ${s.id}${extra}. Gaps it leaves on the timeline are not closed.${note}`
  },

  // {op, id, source?: "vimo://..." | null, duration_ms?: 500}: a transition from clip `id` into the clip that starts
  // where it ends, on the same track. Applying one again replaces it; source null removes it. Clips never move.
  add_transition(draft, op) {
    const s = find(draft, op.id)
    if (s.type !== 'VIDEO' || !visuals(draft).includes(s)) throw new Error(`${op.id} is not a video clip or image on the timeline`)
    if (op.source === null) {
      if (!s.attributes.transition) throw new Error(`${s.id} has no transition`)
      for (const key of TRANSITION_KEYS) delete s.attributes[key]
      return `Removed the transition after ${s.id}`
    }
    const source = requireSource(op.source, ['vimo'])
    const next = nextClip(draft, s)
    if (!next) throw new Error(`No clip starts right where ${s.id} ends on its track; a transition goes between two clips that touch`)
    const longest = Math.min(s.timeline['duration.ms'], next.timeline['duration.ms'])
    const duration = requireMs(op.duration_ms ?? Math.min(500, longest), 'duration_ms', { min: 1 })
    if (duration > longest) throw new Error(`duration_ms can be at most ${longest} ms, the length of the shorter clip`)
    s.attributes.transition = source
    s.attributes['transition.duration.ms'] = duration
    delete s.attributes['transition.overlap']
    return `Added a ${duration} ms transition from ${s.id} into ${next.id}`
  },

  // {op, source: "vimo://...", intensity?: 0.6, start_ms?, duration_ms?, over?: id}: a filter over a stretch of the
  // video (start_ms and duration_ms), the time of one segment (over), or the whole video (neither).
  add_filter(draft, op) {
    const timeline = effectTimeline(draft, op)
    const id = uniqueId(draft, 'filter')
    draft.segments.push({
      id,
      type: 'COLOR_FILTER',
      parent_id: root(draft).id,
      timeline,
      layout: { layer: layerAbove(draft, timeline) },
      attributes: { source: requireSource(op.source, ['vimo']), intensity: requireNumber(op.intensity ?? 0.6, 'intensity', 0, 1) },
    })
    return `Added filter ${id} at ${Math.round((op.intensity ?? 0.6) * 100)}% from ${timeline['start.ms']} ms for ${timeline['duration.ms']} ms`
  },

  // {op, source: "vimo://...", intensity?, start_ms?, duration_ms?, over?: id}: a video effect or face effect, placed
  // like add_filter. Without intensity the effect keeps its own default strength.
  add_effect(draft, op) {
    const timeline = effectTimeline(draft, op)
    const id = uniqueId(draft, 'effect')
    const attributes = { source: requireSource(op.source, ['vimo']) }
    if (op.intensity !== undefined) attributes.effects_adjust_intensity = requireNumber(op.intensity, 'intensity', 0, 1)
    draft.segments.push({ id, type: 'VIDEO_EFFECT', parent_id: root(draft).id, timeline, layout: { layer: layerAbove(draft, timeline) }, attributes })
    return `Added effect ${id} from ${timeline['start.ms']} ms for ${timeline['duration.ms']} ms`
  },

  // {op, source: "vimo://...", texts: [...], start_ms, duration_ms, position_x?, position_y?, scale?, rotation?,
  // opacity?}: a CapCut text template (a styled, often animated title), with texts in slot order.
  add_text_template(draft, op) {
    if (!Array.isArray(op.texts) || !op.texts.length || op.texts.some(t => typeof t !== 'string' || !t.trim())) throw new Error('texts must be a list of non-empty texts, one per slot')
    const id = uniqueId(draft, 'template')
    const layout = { layer: nextLayer(draft, 'TEXT', TEXT_LAYER_BASE), position_x: requireNumber(op.position_x ?? 0, 'position_x', -1, 1), position_y: requireNumber(op.position_y ?? 0, 'position_y', -1, 1) }
    applyTransform(layout, op)
    draft.segments.push({
      id,
      type: 'TEXT_TEMPLATE',
      parent_id: root(draft).id,
      timeline: { 'start.ms': requireMs(op.start_ms, 'start_ms'), 'duration.ms': requireMs(op.duration_ms, 'duration_ms', { min: 1 }) },
      layout,
      attributes: { source: requireSource(op.source, ['vimo']), contents: op.texts.map(t => t.trim()) },
    })
    return `Added text template ${id} with ${op.texts.length} text${op.texts.length > 1 ? 's' : ''} at ${op.start_ms} ms for ${op.duration_ms} ms`
  },

  // {op, ratio?: "9:16" | "16:9" | "1:1" | ..., width?, height?}: changes the canvas. Clips keep their size, so a
  // clip that no longer fills the frame shows the background (set background_blur or background_color on it).
  set_canvas(draft, op) {
    const r = root(draft)
    r.attributes ??= {}
    if (op.ratio !== undefined) {
      if (op.width !== undefined || op.height !== undefined) throw new Error('Give ratio or width and height, not both')
      if (!Object.hasOwn(RATIOS, op.ratio)) throw new Error(`ratio must be one of ${Object.keys(RATIOS).join(', ')}`)
      ;[r.attributes.width, r.attributes.height] = RATIOS[op.ratio]
      r.attributes.ratio_type = op.ratio
    } else {
      for (const key of ['width', 'height']) {
        if (!Number.isInteger(op[key]) || op[key] < 16 || op[key] > 8192) throw new Error(`${key} must be a whole number of pixels from 16 to 8192 (or give ratio)`)
      }
      r.attributes.width = op.width
      r.attributes.height = op.height
      r.attributes.ratio_type = 'custom'
    }
    return `Canvas is now ${r.attributes.width}x${r.attributes.height}${op.ratio ? ` (${op.ratio})` : ''}. Clips keep their size; fill any empty space with background_blur or background_color`
  },
}

export function applyOperations(input, operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('Operations must be a non-empty JSON array')
  const draft = clone(input)
  const before = validate(draft)
  if (before.length) throw new Error(`The input draft is invalid: ${before.join('; ')}`)
  const changes = operations.map((op, index) => {
    const run = OPERATIONS[op?.op]
    if (!run) throw new Error(`Operation ${index + 1}: unknown op "${op?.op}". Known: ${Object.keys(OPERATIONS).join(', ')}`)
    try {
      return run(draft, op)
    } catch (error) {
      throw new Error(`Operation ${index + 1} (${op.op}): ${error.message}`)
    }
  })
  const after = validate(draft)
  if (after.length) throw new Error(`The edited draft is invalid: ${after.join('; ')}`)
  return { draft, changes }
}

export function newDraft(width, height) {
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < 16 || value > 8192) throw new Error(`${name} must be a whole number of pixels between 16 and 8192`)
  }
  return { version: '0.1.0', segments: [{ id: 'draft', type: 'DRAFT', attributes: { width, height } }] }
}

// ------------------------------------------------------------------ summary

// A usable font is a CapCut library font: vimo:// followed by a numeric resource id. The
// CapCut desktop app can save local font paths, which come back as broken vimo:// links.
export function fontProblems(draft) {
  return draft.segments
    .filter(s => s.type === 'TEXT' && typeof s.attributes?.font === 'string' && !/^vimo:\/\/\d+$/.test(s.attributes.font))
    .map(s => s.id)
}

export function summarize(draft) {
  const r = root(draft)
  const fmt = ms => `${(ms / 1000).toFixed(1)}s`
  const lines = [`Canvas ${r.attributes?.width}x${r.attributes?.height}${r.attributes?.ratio_type && r.attributes.ratio_type !== 'custom' ? ` (${r.attributes.ratio_type})` : ''}, length ${fmt(draftDuration(draft))}, ${draft.segments.length - 1} segments`]
  const timed = draft.segments.filter(s => s.type !== 'DRAFT' && s.timeline)
    .sort((x, y) => (x.layout?.layer ?? 0) - (y.layout?.layer ?? 0) || x.timeline['start.ms'] - y.timeline['start.ms'])
  for (const s of timed) {
    const t = s.timeline
    const a = s.attributes ?? {}
    let what
    if (s.type === 'TEXT') what = `"${a.content}"${a.font ? ` font ${a.font}` : ''}${a.caption_template ? ` caption template ${a.caption_template}` : ''}${a.flower ? ` text effect ${a.flower}` : ''}${a.bubble ? ` bubble ${a.bubble}` : ''}${a.type_setting === 1 ? ' vertical' : ''}`
    else if (s.type === 'SUBTITLE_TEMPLATE') what = `"${a.content}" caption template ${a.source ?? ''}`
    else if (s.type === 'TEXT_TEMPLATE') what = `${a.source ?? ''} texts ${JSON.stringify(a.contents ?? [])}`
    else what = `${a.source ?? ''}${a.meta_type === 'photo' ? ' (still image)' : ''}`
    const range = 'start.ms' in a && 'end.ms' in a ? ` from source ${fmt(a['start.ms'])}-${fmt(a['end.ms'])}` : ''
    const speed = typeof a.curve_speed === 'string' ? ` speed ramp (average ${speedOf(s).toFixed(2)}x)` : typeof a.speed === 'number' && a.speed !== 1 ? ` at ${a.speed}x` : ''
    const strength = a.intensity ?? a.effects_adjust_intensity
    const extras = [
      strength !== undefined ? ` at ${Math.round(Number(strength) * 100)}%` : '',
      a.transition ? ` then transition ${a.transition} (${a['transition.duration.ms']} ms)` : '',
      a.blend_mode ? ` blend ${a.blend_mode}` : '',
      a.matting === true ? ' background removed' : '',
      children(draft, s.id).filter(c => EFFECT_TYPES.has(c.type)).map(c => ` with ${c.type === 'COLOR_FILTER' ? 'filter' : 'effect'} ${c.id}`).join(''),
    ].join('')
    lines.push(`${s.id.padEnd(12)} ${String(s.type).padEnd(5)} layer ${String(s.layout?.layer).padEnd(4)} ${fmt(t['start.ms'])}-${fmt(t['start.ms'] + t['duration.ms'])}  ${what}${range}${speed}${extras}`)
  }
  const other = draft.segments.filter(s => s.type !== 'DRAFT' && !s.timeline)
  if (other.length) lines.push(`Other segments kept unchanged: ${other.map(s => `${s.id} (${s.type})`).join(', ')}`)
  const broken = fontProblems(draft)
  if (broken.length) lines.push(`Warning: text with a font that is not a CapCut library font (may render in a fallback font): ${broken.join(', ')}`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ CLI

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--in', '--ops', '--out', '--width', '--height'].includes(argv[i]) || argv[i + 1] === undefined) throw new Error(`Unexpected argument: ${argv[i]}`)
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!['new', 'summary', 'validate', 'apply'].includes(command)) {
    console.log('Usage:\n  stdraft.mjs new      --width 1080 --height 1920 --out draft.json\n  stdraft.mjs summary  --in draft.json\n  stdraft.mjs validate --in draft.json\n  stdraft.mjs apply    --in draft.json --ops ops.json --out new.json')
    process.exitCode = command ? 1 : 0
    return
  }
  const args = parseArgs(rest)
  if (command === 'new') {
    if (!args.out) throw new Error('new needs --out')
    if (fs.existsSync(args.out)) throw new Error(`${args.out} already exists`)
    fs.writeFileSync(args.out, JSON.stringify(newDraft(Number(args.width), Number(args.height))), 'utf8')
    console.log(JSON.stringify({ success: true, out: args.out }))
    return
  }
  if (!args.in) throw new Error('--in is required')
  const draft = readJson(args.in)
  if (command === 'summary') {
    console.log(summarize(draft))
  } else if (command === 'validate') {
    const errors = validate(draft)
    console.log(JSON.stringify({ valid: errors.length === 0, errors }))
    if (errors.length) process.exitCode = 1
  } else {
    if (!args.ops || !args.out) throw new Error('apply needs --ops and --out')
    const { draft: edited, changes } = applyOperations(draft, readJson(args.ops))
    fs.writeFileSync(args.out, JSON.stringify(edited), 'utf8')
    console.log(JSON.stringify({ success: true, out: args.out, changes }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message }))
    process.exit(1)
  }
}
