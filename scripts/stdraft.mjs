#!/usr/bin/env node
// Read and edit CapCut STDraft documents locally.
//
//   node stdraft.mjs new      --width 1080 --height 1920 --out draft.json
//   node stdraft.mjs summary  --in draft.json
//   node stdraft.mjs validate --in draft.json
//   node stdraft.mjs apply    --in draft.json --ops ops.json --out new.json
//
// An STDraft document is {"version": "...", "segments": [...]}: one DRAFT root segment plus
// VIDEO, AUDIO and TEXT segments that point at it with parent_id. Times are in milliseconds.
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

const TYPES = new Set(['DRAFT', 'VIDEO', 'AUDIO', 'TEXT'])

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

function nextLayer(draft, type, base) {
  const layers = draft.segments.filter(s => s.type === type).map(s => s.layout?.layer ?? base - 1)
  return Math.max(base - 1, ...layers) + 1
}

function overlaps(a, b) {
  return a['start.ms'] < b['start.ms'] + b['duration.ms'] && b['start.ms'] < a['start.ms'] + a['duration.ms']
}

// The lowest layer from CAPTION_LAYER up where no existing TEXT segment overlaps the new cues in time.
function captionLayer(draft, timelines) {
  const texts = draft.segments.filter(s => s.type === 'TEXT' && s.timeline)
  for (let layer = CAPTION_LAYER; ; layer++) {
    const onLayer = texts.filter(s => (s.layout?.layer ?? -1) === layer)
    if (!onLayer.some(s => timelines.some(t => overlaps(s.timeline, t)))) return layer
  }
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
  return changed
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
    if (op.background_blur !== undefined) { a['background.blur'] = requireNumber(op.background_blur, 'background_blur', 0, 1); delete a['background.color']; changed.push('background blur') }
    if (op.background_color !== undefined) { a['background.color'] = requireColor(op.background_color, 'background_color'); delete a['background.blur']; changed.push('background colour') }
  }
  return changed
}

// The lowest layer from 1 up where no other video clip or image overlaps the given time range.
function overlayLayer(draft, timeline) {
  const visuals = draft.segments.filter(s => s.type === 'VIDEO' && s.timeline)
  for (let layer = 1; ; layer++) {
    if (!visuals.some(s => s.layout?.layer === layer && overlaps(s.timeline, timeline))) return layer
  }
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
  if (draft.segments.some(s => s.type === 'VIDEO' && s.layout?.layer === layer && s.timeline && overlaps(s.timeline, timeline))) throw new Error(`Layer ${layer} already has a clip at that time`)
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
  let moved = 0
  if (delta !== 0 && s.layout?.layer === 0) {
    for (const other of draft.segments) {
      if (other !== s && other.type === 'VIDEO' && other.layout?.layer === 0 && other.timeline && other.timeline['start.ms'] >= oldEnd) {
        other.timeline['start.ms'] += delta
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
  const ids = new Set()
  for (const [index, s] of draft.segments.entries()) {
    const label = `segment ${index} (${s?.id ?? 'no id'})`
    if (!s || typeof s.id !== 'string' || !s.id) { errors.push(`${label} needs a string id`); continue }
    if (ids.has(s.id)) errors.push(`${label} has a duplicate id`)
    ids.add(s.id)
    if (!TYPES.has(s.type)) continue // Unknown types are kept as-is for CapCut to judge.
    if (s.type === 'DRAFT') continue
    if (roots[0] && s.parent_id !== roots[0].id) errors.push(`${label} must have parent_id "${roots[0].id}"`)
    const t = s.timeline
    if (!t || !Number.isInteger(t['start.ms']) || t['start.ms'] < 0) errors.push(`${label} needs timeline["start.ms"] >= 0`)
    if (!t || !Number.isInteger(t['duration.ms']) || t['duration.ms'] <= 0) errors.push(`${label} needs timeline["duration.ms"] > 0`)
    if (!Number.isInteger(s.layout?.layer)) errors.push(`${label} needs layout.layer`)
    const a = s.attributes ?? {}
    if (s.type === 'TEXT' && !(typeof a.content === 'string' && a.content.trim())) errors.push(`${label} needs text content`)
    if ((s.type === 'VIDEO' || s.type === 'AUDIO') && typeof a.source !== 'string') errors.push(`${label} needs a source`)
    if ('start.ms' in a && 'end.ms' in a && a['end.ms'] <= a['start.ms']) errors.push(`${label} has a source range that ends before it starts`)
    if (s.type === 'VIDEO' && a.meta_type === 'photo' && ('speed' in a || 'curve_speed' in a)) errors.push(`${label} is a still image, which cannot have speed or curve_speed`)
    for (const holder of [a, s.layout ?? {}]) {
      for (const [key, frames] of Object.entries(holder)) {
        if (!key.endsWith('.keyframes')) continue
        if (!Array.isArray(frames) || frames.some(f => !f || !Number.isInteger(f['time.ms']) || f['time.ms'] < 0 || !('value' in f))) errors.push(`${label} has invalid ${key}`)
      }
    }
    if (s.layout && 'alpha' in s.layout && !(s.layout.alpha >= 0 && s.layout.alpha <= 1)) errors.push(`${label} has opacity outside 0 to 1`)
    if ('curve_speed' in a) {
      try { checkCurve(JSON.parse(a.curve_speed)) } catch (e) { errors.push(`${label} has an invalid curve_speed: ${e.message}`) }
    }
  }
  const mainTrack = draft.segments.filter(s => s.type === 'VIDEO' && s.layout?.layer === 0)
    .sort((x, y) => x.timeline['start.ms'] - y.timeline['start.ms'])
  for (let i = 1; i < mainTrack.length; i++) {
    const prev = mainTrack[i - 1]
    if (prev.timeline['start.ms'] + prev.timeline['duration.ms'] > mainTrack[i].timeline['start.ms']) {
      errors.push(`Main-track clips ${prev.id} and ${mainTrack[i].id} overlap`)
    }
  }
  const overlays = draft.segments.filter(s => s.type === 'VIDEO' && s.timeline && Number.isInteger(s.layout?.layer) && s.layout.layer > 0)
  for (let i = 0; i < overlays.length; i++) {
    for (let j = i + 1; j < overlays.length; j++) {
      if (overlays[i].layout.layer === overlays[j].layout.layer && overlaps(overlays[i].timeline, overlays[j].timeline)) {
        errors.push(`Overlays ${overlays[i].id} and ${overlays[j].id} overlap on layer ${overlays[i].layout.layer}`)
      }
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
    if (op.font) attributes.font = requireSource(op.font, ['vimo'])
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

  // {op, cues: [{start_ms, end_ms, text}], position_y?, font_size?, font?, layer?, style?: {text style fields}}
  add_captions(draft, op) {
    if (!Array.isArray(op.cues) || op.cues.length === 0) throw new Error('cues must be a non-empty array')
    const timelines = op.cues.map((cue, i) => {
      const start = requireMs(cue.start_ms, `cue ${i + 1} start_ms`)
      return { 'start.ms': start, 'duration.ms': requireMs(cue.end_ms, `cue ${i + 1} end_ms`, { min: start + 1 }) - start }
    })
    if (op.layer !== undefined && !(Number.isInteger(op.layer) && op.layer >= 1)) throw new Error('layer must be a whole number of at least 1')
    const layer = op.layer ?? captionLayer(draft, timelines)
    const added = []
    for (const [i, cue] of op.cues.entries()) {
      const start = requireMs(cue.start_ms, `cue ${i + 1} start_ms`)
      const end = requireMs(cue.end_ms, `cue ${i + 1} end_ms`, { min: start + 1 })
      if (!(typeof cue.text === 'string' && cue.text.trim())) throw new Error(`cue ${i + 1} has no text`)
      const id = uniqueId(draft, 'caption')
      const attributes = { ...TEXT_STYLE, content: cue.text.trim() }
      if (op.font_size !== undefined) attributes.font_size = op.font_size
      if (op.font) attributes.font = requireSource(op.font, ['vimo'])
      if (op.style) applyTextStyle(attributes, op.style)
      draft.segments.push({
        id,
        type: 'TEXT',
        parent_id: root(draft).id,
        timeline: { 'start.ms': start, 'duration.ms': end - start },
        layout: { layer, position_x: 0, position_y: op.position_y ?? -0.6 },
        attributes,
      })
      added.push(id)
    }
    return `Added ${added.length} captions on layer ${layer}`
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

  // {op, id, content?, volume?, font_size?, font_color?, font?, fade_in_ms?, fade_out_ms?, text style fields (TEXT),
  // crop?, background_blur?, background_color? (video clips and images)}
  update(draft, op) {
    const s = find(draft, op.id)
    const a = s.attributes ?? (s.attributes = {})
    const changed = []
    if (op.content !== undefined) {
      if (s.type !== 'TEXT') throw new Error('content can only be changed on TEXT segments')
      if (!String(op.content).trim()) throw new Error('content cannot be empty')
      a.content = String(op.content); changed.push('content')
    }
    if (op.volume !== undefined) {
      if (s.type === 'TEXT') throw new Error('TEXT segments have no volume')
      if (typeof op.volume !== 'number' || op.volume < 0) throw new Error('volume must be a number >= 0')
      a.volume = op.volume; changed.push('volume')
    }
    if (op.font_size !== undefined) { a.font_size = op.font_size; changed.push('font_size') }
    if (op.font_color) { a.font_color = a.text_color = op.font_color; changed.push('font_color') }
    if (op.font) { a.font = requireSource(op.font, ['vimo']); changed.push('font') }
    if (op.fade_in_ms !== undefined) { a['fade_in.ms'] = requireMs(op.fade_in_ms, 'fade_in_ms'); changed.push('fade_in') }
    if (op.fade_out_ms !== undefined) { a['fade_out.ms'] = requireMs(op.fade_out_ms, 'fade_out_ms'); changed.push('fade_out') }
    const styled = applyTextStyle({}, op)
    if (styled.length) {
      if (s.type !== 'TEXT') throw new Error('Text style fields work only on TEXT segments')
      applyTextStyle(a, op, changed)
    }
    applyClipLook(s, op, changed)
    if (changed.length === 0) throw new Error('update needs at least one field to change')
    return `Updated ${s.id}: ${changed.join(', ')}`
  },

  // {op, id, start_ms?, duration_ms?, position_x?, position_y?, layer?, scale?, scale_x?, scale_y?, rotation?, opacity?}
  place(draft, op) {
    const s = find(draft, op.id)
    const changed = []
    if (op.start_ms !== undefined) { s.timeline['start.ms'] = requireMs(op.start_ms, 'start_ms'); changed.push('start') }
    if (op.duration_ms !== undefined) {
      const duration = requireMs(op.duration_ms, 'duration_ms', { min: 1 })
      const isPhoto = s.attributes?.meta_type === 'photo'
      if (s.type === 'VIDEO' && !isPhoto && 'start.ms' in (s.attributes ?? {})) s.attributes['end.ms'] = s.attributes['start.ms'] + Math.round(duration * speedOf(s))
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
    return `Moved ${s.id}: ${changed.join(', ')}`
  },

  // {op, layer?}: packs every caption (TEXT segment whose id starts with "caption") back onto the lowest layers from
  // `layer` (default 1): one layer when no captions overlap in time. Run before every save: CapCut's read-back spreads
  // captions over extra layers, and saving those layers adds tracks.
  reset_caption_layers(draft, op) {
    const base = op.layer ?? CAPTION_LAYER
    if (!(Number.isInteger(base) && base >= 1)) throw new Error('layer must be a whole number of at least 1')
    const captions = draft.segments
      .filter(s => s.type === 'TEXT' && s.timeline && typeof s.id === 'string' && s.id.startsWith('caption'))
      .sort((a, b) => a.timeline['start.ms'] - b.timeline['start.ms'])
    if (captions.length === 0) throw new Error('The draft has no captions (TEXT segments whose id starts with "caption")')
    const placed = []
    for (const s of captions) {
      let layer = base
      while (placed.some(p => p.layer === layer && overlaps(p.timeline, s.timeline))) layer++
      s.layout = { ...(s.layout ?? {}), layer }
      placed.push({ layer, timeline: s.timeline })
    }
    const used = [...new Set(placed.map(p => p.layer))].sort((a, b) => a - b)
    return `Put ${captions.length} captions on layer${used.length > 1 ? 's' : ''} ${used.join(', ')}`
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

  // {op, id, ranges: [{start_ms, end_ms}], to?: 0.25, fade_ms?: 300}: lowers a music track or clip's volume to
  // `to` (a fraction of its normal volume) during each project-time range, for speech or a key moment, with
  // short fades in and out. Replaces any earlier volume keyframes on that segment.
  duck(draft, op) {
    const s = find(draft, op.id)
    if (!['AUDIO', 'VIDEO'].includes(s.type) || s.attributes?.meta_type === 'photo') throw new Error(`${op.id} has no sound to lower`)
    if (!Array.isArray(op.ranges) || op.ranges.length === 0) throw new Error('ranges must be a non-empty array of {start_ms, end_ms}')
    const level = s.attributes.volume ?? 1
    const low = level * requireNumber(op.to ?? 0.25, 'to', 0, 1)
    const fade = requireMs(op.fade_ms ?? 300, 'fade_ms')
    const segStart = s.timeline['start.ms'], segEnd = segStart + s.timeline['duration.ms']
    const ranges = op.ranges.map((r, i) => {
      const start = requireMs(r.start_ms, `range ${i + 1} start_ms`)
      const end = requireMs(r.end_ms, `range ${i + 1} end_ms`, { min: start + 1 })
      return [Math.max(start, segStart), Math.min(end, segEnd)]
    }).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
    if (ranges.length === 0) throw new Error(`None of the ranges fall within ${s.id} on the timeline`)
    const points = []
    for (const [start, end] of ranges) {
      const down = Math.max(segStart, start - fade), up = Math.min(segEnd, end + fade)
      if (points.length && points.at(-1)[0] >= down) points.pop() // merge with the previous range
      else points.push([down, level])
      points.push([start, low], [end, low], [up, level])
    }
    const frames = []
    for (const [t, v] of points) {
      const time = sourceTime(s, t)
      if (frames.length && time <= frames.at(-1)['time.ms']) continue
      frames.push({ 'time.ms': time, value: v })
    }
    s.attributes['volume.keyframes'] = frames
    return `${s.id} drops to ${Math.round((low / (level || 1)) * 100)}% of its volume during ${ranges.length} range${ranges.length > 1 ? 's' : ''}`
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

  // {op, id}
  remove(draft, op) {
    const s = find(draft, op.id)
    draft.segments = draft.segments.filter(x => x !== s)
    return `Removed ${s.type} ${s.id}. Gaps it leaves on the timeline are not closed.`
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
  const lines = [`Canvas ${r.attributes?.width}x${r.attributes?.height}, length ${fmt(draftDuration(draft))}, ${draft.segments.length - 1} segments`]
  const timed = draft.segments.filter(s => s.type !== 'DRAFT' && s.timeline)
    .sort((x, y) => (x.layout?.layer ?? 0) - (y.layout?.layer ?? 0) || x.timeline['start.ms'] - y.timeline['start.ms'])
  for (const s of timed) {
    const t = s.timeline
    const a = s.attributes ?? {}
    const what = s.type === 'TEXT' ? `"${a.content}"${a.font ? ` font ${a.font}` : ''}` : `${a.source ?? ''}${a.meta_type === 'photo' ? ' (still image)' : ''}`
    const range = 'start.ms' in a && 'end.ms' in a ? ` from source ${fmt(a['start.ms'])}-${fmt(a['end.ms'])}` : ''
    const speed = typeof a.curve_speed === 'string' ? ` speed ramp (average ${speedOf(s).toFixed(2)}x)` : typeof a.speed === 'number' && a.speed !== 1 ? ` at ${a.speed}x` : ''
    lines.push(`${s.id.padEnd(12)} ${String(s.type).padEnd(5)} layer ${String(s.layout?.layer).padEnd(4)} ${fmt(t['start.ms'])}-${fmt(t['start.ms'] + t['duration.ms'])}  ${what}${range}${speed}`)
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
