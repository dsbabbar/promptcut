import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyOperations, curveAverageSpeed, draftDuration, fontProblems, newDraft, summarize, validate } from '../scripts/stdraft.mjs'

const script = fileURLToPath(new URL('../scripts/stdraft.mjs', import.meta.url))

// Synthetic draft: two main-track clips, one music track and one title.
function sampleDraft() {
  return {
    version: '0.1.0',
    segments: [
      { id: 'draft', type: 'DRAFT', attributes: { width: 1080, height: 1920 } },
      { id: 'clip_a', type: 'VIDEO', parent_id: 'draft', timeline: { 'start.ms': 0, 'duration.ms': 3000 }, layout: { layer: 0 },
        attributes: { source: 'vid://example-a', meta_type: 'video', 'start.ms': 0, 'end.ms': 3000, volume: 1 } },
      { id: 'clip_b', type: 'VIDEO', parent_id: 'draft', timeline: { 'start.ms': 3000, 'duration.ms': 2000 }, layout: { layer: 0 },
        attributes: { source: 'vid://example-b', meta_type: 'video', 'start.ms': 1000, 'end.ms': 3000, volume: 1 } },
      { id: 'music', type: 'AUDIO', parent_id: 'draft', timeline: { 'start.ms': 0, 'duration.ms': 5000 }, layout: { layer: 100 },
        attributes: { source: 'vid://example-music', 'end.ms': 5000, volume: 0.5, auto_loop: true } },
      { id: 'title', type: 'TEXT', parent_id: 'draft', timeline: { 'start.ms': 0, 'duration.ms': 2000 }, layout: { layer: 1000, position_x: 0, position_y: 0.4 },
        attributes: { content: 'Hello', font_size: 13 } },
    ],
  }
}

test('a well-formed draft validates', () => {
  assert.deepEqual(validate(sampleDraft()), [])
  assert.equal(draftDuration(sampleDraft()), 5000)
})

test('validation catches structural problems', () => {
  const d = sampleDraft()
  d.segments.push({ ...d.segments[1] })
  d.segments[2].parent_id = 'elsewhere'
  d.segments[4].attributes.content = ' '
  d.segments[2].timeline['start.ms'] = 2000
  const errors = validate(d).join('\n')
  assert.match(errors, /duplicate id/)
  assert.match(errors, /parent_id "draft"/)
  assert.match(errors, /needs text content/)
  assert.match(errors, /overlap/)
  assert.deepEqual(validate({}), ['The document must be an object with a "segments" array'])
})

test('adds text, captions and music on new layers without touching the input', () => {
  const input = sampleDraft()
  const { draft, changes } = applyOperations(input, [
    { op: 'add_text', content: 'Grand opening', start_ms: 0, duration_ms: 1500, font: 'vimo://123' },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1200, text: 'Hi there' }, { start_ms: 1300, end_ms: 2500, text: 'Welcome' }] },
    { op: 'add_audio', source: 'vimo://456', volume: 0.3, fade_out_ms: 1000 },
  ])
  assert.equal(input.segments.length, 5, 'input must not be mutated')
  assert.equal(changes.length, 3)
  const text = draft.segments.find(s => s.attributes?.content === 'Grand opening')
  assert.equal(text.layout.layer, 1001)
  assert.equal(text.attributes.font, 'vimo://456'.replace('456', '123'))
  const captions = draft.segments.filter(s => s.id.startsWith('caption_'))
  assert.equal(captions.length, 2)
  assert.ok(captions.every(c => c.layout.layer === 1), 'captions go on layer 1')
  assert.deepEqual(captions[1].timeline, { 'start.ms': 1300, 'duration.ms': 1200 })
  const audio = draft.segments.find(s => s.id === 'audio_0')
  assert.equal(audio.layout.layer, 101)
  assert.equal(audio.timeline['duration.ms'], 5000)
  assert.equal(audio.attributes['fade_out.ms'], 1000)
  assert.deepEqual(validate(draft), [])
})

test('accepts searched music (sid://) and keeps captions on one low layer', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'add_audio', source: 'sid://789' },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'English' }] },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'Second language' }] },
    { op: 'add_captions', cues: [{ start_ms: 2000, end_ms: 3000, text: 'Later' }] },
  ])
  assert.equal(draft.segments.find(s => s.attributes?.source === 'sid://789').type, 'AUDIO')
  const layerOf = text => draft.segments.find(s => s.attributes?.content === text).layout.layer
  assert.equal(layerOf('English'), 1)
  assert.equal(layerOf('Second language'), 2, 'overlapping captions move up one layer')
  assert.equal(layerOf('Later'), 1, 'non-overlapping captions share layer 1')
  // CapCut's read-back spreads captions over layers; reset puts them back on one.
  for (const s of draft.segments) if (s.id.startsWith('caption_')) s.layout.layer += 5
  const { draft: reset, changes } = applyOperations(draft, [{ op: 'reset_caption_layers' }])
  assert.match(changes[0], /Put 3 captions on layers 1, 2/)
  assert.equal(reset.segments.find(s => s.attributes?.content === 'Later').layout.layer, 1)
  assert.equal(reset.segments.find(s => s.attributes?.content === 'Second language').layout.layer, 2)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'reset_caption_layers' }]), /no captions/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_captions', layer: 0, cues: [{ start_ms: 0, end_ms: 1, text: 'x' }] }]), /layer must be/)
})

test('appends video, updates, moves and removes segments', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'add_video', source: 'vid://example-c', source_start_ms: 500, source_end_ms: 2500 },
    { op: 'update', id: 'title', content: 'Hello world', font_color: '#FFCC00' },
    { op: 'update', id: 'music', volume: 0.2 },
    { op: 'place', id: 'title', start_ms: 500, position_y: -0.5 },
    { op: 'place', id: 'clip_b', duration_ms: 1000 },
    { op: 'remove', id: 'clip_a' },
  ])
  const added = draft.segments.find(s => s.id === 'video_0')
  // Added at 5000, then the main track closed up: clip_b got 1000 ms shorter and clip_a (3000 ms) was removed.
  assert.deepEqual(added.timeline, { 'start.ms': 1000, 'duration.ms': 2000 })
  assert.equal(draft.segments.find(s => s.id === 'clip_b').timeline['start.ms'], 0)
  const title = draft.segments.find(s => s.id === 'title')
  assert.equal(title.attributes.content, 'Hello world')
  assert.equal(title.attributes.text_color, '#FFCC00')
  assert.equal(title.timeline['start.ms'], 500)
  assert.equal(title.layout.position_y, -0.5)
  assert.equal(draft.segments.find(s => s.id === 'music').attributes.volume, 0.2)
  assert.equal(draft.segments.find(s => s.id === 'clip_b').attributes['end.ms'], 2000)
  assert.equal(draft.segments.some(s => s.id === 'clip_a'), false)
})

test('rejects bad operations with the failing step named', () => {
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'explode' }]), /Operation 1: unknown op "explode"/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_text', content: 'x', start_ms: 0, duration_ms: 0 }]), /Operation 1 \(add_text\): duration_ms/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_audio', source: 'https://x' }]), /source must start with/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'remove', id: 'draft' }]), /DRAFT root/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'title', volume: 1 }]), /no volume/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'place', id: 'title', position_y: 3 }]), /between -1 and 1/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_video', source: 'vid://x', start_ms: 1000, source_end_ms: 1000 }]), /overlap/)
})

test('summary lists segments by layer and time', () => {
  const lines = summarize(sampleDraft()).split('\n')
  assert.equal(lines[0], 'Canvas 1080x1920, length 5.0s, 4 segments')
  assert.match(lines[1], /^clip_a\s+VIDEO layer 0\s+0\.0s-3\.0s\s+vid:\/\/example-a from source 0\.0s-3\.0s$/)
  assert.match(lines[4], /^title\s+TEXT\s+layer 1000\s+0\.0s-2\.0s\s+"Hello"$/)
})

test('CLI applies operations, keeps UTF-8 and refuses to write invalid results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-draft-'))
  const input = path.join(dir, 'draft.json')
  const ops = path.join(dir, 'ops.json')
  const out = path.join(dir, 'out.json')
  fs.writeFileSync(input, '﻿' + JSON.stringify(sampleDraft()))
  fs.writeFileSync(ops, JSON.stringify([{ op: 'add_text', content: 'Reality ✂️😱', start_ms: 0, duration_ms: 1000 }]))
  const result = JSON.parse(execFileSync(process.execPath, [script, 'apply', '--in', input, '--ops', ops, '--out', out]).toString())
  assert.equal(result.success, true)
  assert.ok(fs.readFileSync(out, 'utf8').includes('Reality ✂️😱'))

  fs.writeFileSync(ops, JSON.stringify([{ op: 'remove', id: 'missing' }]))
  fs.rmSync(out)
  assert.throws(() => execFileSync(process.execPath, [script, 'apply', '--in', input, '--ops', ops, '--out', out], { stdio: 'pipe' }))
  assert.equal(fs.existsSync(out), false)
})

test('builds a new draft and adds an uploaded clip with captions', () => {
  assert.throws(() => newDraft(0, 1920), /width/)
  const { draft } = applyOperations(newDraft(1080, 1920), [
    { op: 'add_video', source: 'vid://uploaded', source_end_ms: 4000 },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 2000, text: 'Line one' }] },
  ])
  assert.deepEqual(validate(draft), [])
  assert.match(summarize(draft), /^Canvas 1080x1920, length 4\.0s, 2 segments/)
})

test('handles untimed segments and flags fonts that are not library fonts', () => {
  const d = sampleDraft()
  d.segments.push({ id: 'patch_0', type: 'PATCH', parent_id: 'draft', attributes: { note: 'added by an editor app' } })
  d.segments.find(s => s.id === 'title').attributes.font = 'vimo://C:/Users/someone/fonts/Local.ttf'
  assert.deepEqual(validate(d), [])
  assert.deepEqual(fontProblems(d), ['title'])
  const text = summarize(d)
  assert.match(text, /Other segments kept unchanged: patch_0 \(PATCH\)/)
  assert.match(text, /Warning: .*title/)
  const { draft } = applyOperations(d, [{ op: 'update', id: 'title', font: 'vimo://7317175475195875841' }])
  assert.deepEqual(fontProblems(draft), [])
  assert.ok(draft.segments.some(s => s.id === 'patch_0'), 'unknown segments are preserved')
})

test('add_image appends still images to the main track', () => {
  const draft = newDraft(1920, 1080)
  const { draft: out, changes } = applyOperations(draft, [
    { op: 'add_image', source: 'tos-x/slide1', duration_ms: 4000 },
    { op: 'add_image', source: 'tos://tos-x/slide2', duration_ms: 2500 },
    { op: 'place', id: 'image_0', duration_ms: 3000 },
  ])
  const images = out.segments.filter(s => s.attributes?.meta_type === 'photo')
  assert.equal(images.length, 2)
  assert.equal(images[0].attributes.source, 'tos://tos-x/slide1')
  assert.deepEqual(images[1].timeline, { 'start.ms': 3000, 'duration.ms': 2500 }, 'moved up when image_0 got shorter')
  assert.equal(images[0].timeline['duration.ms'], 3000)
  assert.ok(!('end.ms' in images[0].attributes), 'a still image has no source end')
  assert.equal(images[0].type, 'VIDEO')
  assert.equal(images[0].layout.layer, 0)
  assert.match(changes[0], /Added image/)
  assert.match(summarize(out), /\(still image\)/)
  assert.deepEqual(validate(out), [])
  assert.throws(() => applyOperations(draft, [{ op: 'add_image', source: 'tos://x' }]), /duration_ms/)
  assert.throws(() => applyOperations(draft, [{ op: 'add_image', source: 'https://example.com/a.png', duration_ms: 1000 }]), /source must start with/)
})

test('validation rejects speed on still images', () => {
  const { draft } = applyOperations(newDraft(1920, 1080), [{ op: 'add_image', source: 'tos://x/y', duration_ms: 1000 }])
  draft.segments.find(s => s.type === 'VIDEO').attributes.speed = 2
  assert.match(validate(draft).join('\n'), /cannot have speed/)
})

test('set_speed retimes a clip and moves later main-track clips', () => {
  const { draft, changes } = applyOperations(sampleDraft(), [{ op: 'set_speed', id: 'clip_a', speed: 2 }])
  const a = draft.segments.find(s => s.id === 'clip_a')
  const b = draft.segments.find(s => s.id === 'clip_b')
  assert.equal(a.attributes.speed, 2)
  assert.equal(a.timeline['duration.ms'], 1500)
  assert.equal(b.timeline['start.ms'], 1500, 'the next clip moves up')
  assert.equal(draft.segments.find(s => s.id === 'title').timeline['start.ms'], 0, 'text is not moved')
  assert.match(changes[0], /2x: now 1.5s \(shorter by 1.5s\); 1 later main-track clip moved/)
  assert.deepEqual(validate(draft), [])
  const back = applyOperations(draft, [{ op: 'set_speed', id: 'clip_a', speed: 1 }]).draft
  assert.equal('speed' in back.segments.find(s => s.id === 'clip_a').attributes, false)
  assert.equal(back.segments.find(s => s.id === 'clip_b').timeline['start.ms'], 3000)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'set_speed', id: 'clip_a', speed: 0 }]), /speed must be/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'set_speed', id: 'title', speed: 2 }]), /not a video clip/)
})

test('speed_ramp writes a CapCut speed curve and retimes the clip', () => {
  assert.equal(curveAverageSpeed([{ x: 0, y: 2 }, { x: 1, y: 2 }]), 2)
  assert.ok(Math.abs(curveAverageSpeed([{ x: 0, y: 1 }, { x: 0.25, y: 3 }, { x: 0.75, y: 3 }, { x: 1, y: 1 }]) - 2.4) < 1e-9)
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'set_speed', id: 'clip_a', speed: 2 },
    { op: 'speed_ramp', id: 'clip_a', shape: 'fast_middle' },
  ])
  const a = draft.segments.find(s => s.id === 'clip_a')
  assert.equal('speed' in a.attributes, false, 'a ramp replaces a constant speed')
  assert.deepEqual(JSON.parse(a.attributes.curve_speed), [{ x: 0, y: 1 }, { x: 0.25, y: 3 }, { x: 0.75, y: 3 }, { x: 1, y: 1 }])
  assert.equal(a.timeline['duration.ms'], 1250)
  assert.equal(draft.segments.find(s => s.id === 'clip_b').timeline['start.ms'], 1250)
  assert.match(summarize(draft), /speed ramp \(average 2.40x\)/)
  assert.deepEqual(validate(draft), [])
  // Trimming a ramped clip keeps the source range in step with its speed.
  const trimmed = applyOperations(draft, [{ op: 'place', id: 'clip_a', duration_ms: 1000 }]).draft
  assert.equal(trimmed.segments.find(s => s.id === 'clip_a').attributes['end.ms'], 2400)
  const custom = applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_b', points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }]).draft
  assert.equal(custom.segments.find(s => s.id === 'clip_b').timeline['duration.ms'], 4000)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_a', shape: 'zoom' }]), /shape must be/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_a', points: [{ x: 0, y: 1 }, { x: 0.5, y: 2 }] }]), /end at x 1/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_a', points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] }]), /y must be/)
  const bad = sampleDraft(); bad.segments[1].attributes.curve_speed = '[{"x":0,"y":1}]'
  assert.match(validate(bad).join('\n'), /invalid curve_speed/)
})

test('CapCut curve presets give the clip lengths CapCut shows for a 6-second clip', () => {
  const six = () => {
    const d = sampleDraft()
    Object.assign(d.segments[1], { timeline: { 'start.ms': 0, 'duration.ms': 6000 } })
    Object.assign(d.segments[1].attributes, { 'start.ms': 0, 'end.ms': 6000 })
    d.segments[2].timeline['start.ms'] = 6000
    return d
  }
  const expected = { montage: 3, hero: 3, bullet: 2, jump_cut: 9, flash_in: 3, flash_out: 3 }
  for (const [shape, seconds] of Object.entries(expected)) {
    const { draft, changes } = applyOperations(six(), [{ op: 'speed_ramp', id: 'clip_a', shape }])
    const ms = draft.segments.find(s => s.id === 'clip_a').timeline['duration.ms']
    assert.ok(Math.abs(ms / 1000 - seconds) < 0.5, `${shape}: ${ms} ms, CapCut shows ${seconds}s`)
    assert.match(changes[0], /curve to clip_a/)
    assert.deepEqual(validate(draft), [])
  }
  assert.throws(() => applyOperations(six(), [{ op: 'speed_ramp', id: 'clip_a', shape: 'hero', peak: 4 }]), /fixed CapCut preset/)
})

test('overlays (picture-in-picture, logos) go on free layers above the main track', () => {
  const { draft, changes } = applyOperations(sampleDraft(), [
    { op: 'add_image', source: 'tos://logo', overlay: true, start_ms: 0, duration_ms: 5000, position_x: 0.7, position_y: -0.8, scale: 0.2, opacity: 0.9 },
    { op: 'add_video', source: 'vid://facecam', overlay: true, start_ms: 1000, source_end_ms: 2000, scale: 0.35, position_x: -0.6, position_y: 0.6 },
    { op: 'add_video', source: 'vid://more', source_end_ms: 1000 },
  ])
  const logo = draft.segments.find(s => s.attributes?.source === 'tos://logo')
  assert.deepEqual(logo.layout, { layer: 1, position_x: 0.7, position_y: -0.8, scale_x: 0.2, scale_y: 0.2, alpha: 0.9 })
  assert.equal(draft.segments.find(s => s.attributes?.source === 'vid://facecam').layout.layer, 2, 'overlapping overlays stack')
  const more = draft.segments.find(s => s.attributes?.source === 'vid://more')
  assert.deepEqual([more.layout.layer, more.timeline['start.ms']], [0, 5000], 'main track still appends')
  assert.match(changes[0], /overlay on layer 1/)
  assert.deepEqual(validate(draft), [])
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_image', source: 'tos://x', overlay: true, duration_ms: 100 }]), /needs start_ms/)
  assert.throws(() => applyOperations(draft, [{ op: 'add_image', source: 'tos://y', layer: 1, start_ms: 10, duration_ms: 100 }]), /already has a clip/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_image', source: 'tos://x', overlay: true, start_ms: 0, duration_ms: 100, opacity: 2 }]), /opacity must be/)
  const clash = applyOperations(sampleDraft(), [{ op: 'add_image', source: 'tos://x', overlay: true, start_ms: 0, duration_ms: 1000 }]).draft
  clash.segments.push({ ...clash.segments.at(-1), id: 'copy' })
  assert.match(validate(clash).join('\n'), /overlap on layer 1/)
})

test('crop, background fill, size, rotation and opacity', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'update', id: 'clip_a', crop: [0.1, 0, 0.9, 1], background_blur: 0.5 },
    { op: 'update', id: 'clip_b', background_color: '#112233' },
    { op: 'place', id: 'clip_b', scale: 0.8, rotation: 5, opacity: 0.5 },
    { op: 'place', id: 'title', scale_x: 1.2 },
  ])
  const a = draft.segments.find(s => s.id === 'clip_a')
  assert.deepEqual(a.attributes.crop, [0.1, 0, 0.9, 1])
  assert.equal(a.attributes['background.blur'], 0.5)
  const b = draft.segments.find(s => s.id === 'clip_b')
  assert.equal(b.attributes['background.color'], '#112233')
  assert.deepEqual([b.layout.scale_x, b.layout.scale_y, b.layout.rotation, b.layout.alpha], [0.8, 0.8, 5, 0.5])
  assert.equal(draft.segments.find(s => s.id === 'title').layout.scale_x, 1.2)
  assert.equal('crop' in applyOperations(draft, [{ op: 'update', id: 'clip_a', crop: null }]).draft.segments.find(s => s.id === 'clip_a').attributes, false)
  assert.deepEqual(validate(draft), [])
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'clip_a', crop: [0.5, 0, 0.4, 1] }]), /right must be past left/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'title', crop: [0, 0, 1, 1] }]), /only on video clips/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'clip_a', background_color: 'red' }]), /colour like/)
})

test('text style: outline, shadow, box, alignment and spacing', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'add_text', content: 'Just listed', start_ms: 0, duration_ms: 2000, alignment: 'left', outline_color: '#ffcc00', outline_width: 0.1, shadow: true, box_color: '#000000', box_opacity: 0.5, underline: true, letter_spacing: 2, rotation: -8 },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'Hi' }], style: { outline: false, shadow: false } },
    { op: 'update', id: 'title', shadow_opacity: 0.8, text_opacity: 0.9 },
  ])
  const t = draft.segments.find(s => s.attributes?.content === 'Just listed')
  assert.equal(t.attributes.alignment, 0)
  assert.deepEqual([t.attributes.border_color, t.attributes.border_width], ['#FFCC00', 0.1])
  assert.deepEqual([t.attributes.shadow_color, t.attributes.shadow_alpha, t.attributes.shadow_distance, t.attributes.shadow_smoothing], ['#000000', 0.4, 2, 0.3])
  assert.deepEqual([t.attributes.background_color, t.attributes.background_alpha], ['#000000', 0.5])
  assert.equal(t.attributes.underline, true)
  assert.equal(t.layout.rotation, -8)
  const c = draft.segments.find(s => s.id.startsWith('caption_'))
  assert.deepEqual([c.attributes.border_width, c.attributes.shadow_alpha], [0, 0])
  const title = draft.segments.find(s => s.id === 'title')
  assert.deepEqual([title.attributes.shadow_alpha, title.attributes.text_alpha], [0.8, 0.9])
  assert.deepEqual(validate(draft), [])
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'clip_a', shadow: true }]), /only on text/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'title', alignment: 'middle' }]), /alignment must be/)
})

test('animate and zoom write layout keyframes timed from the segment start', () => {
  const { draft, changes } = applyOperations(sampleDraft(), [
    { op: 'zoom', id: 'clip_a', to: 1.2, pan: 'left', pan_amount: 0.05 },
    { op: 'animate', id: 'title', property: 'opacity', keyframes: [{ time_ms: 0, value: 0 }, { time_ms: 500, value: 1 }] },
  ])
  const a = draft.segments.find(s => s.id === 'clip_a')
  assert.deepEqual(a.layout['scale_x.keyframes'], [{ 'time.ms': 0, value: 1 }, { 'time.ms': 3000, value: 1.2 }])
  assert.deepEqual(a.layout['scale_y.keyframes'], a.layout['scale_x.keyframes'])
  assert.deepEqual(a.layout['position_x.keyframes'], [{ 'time.ms': 0, value: 0 }, { 'time.ms': 3000, value: -0.05 }])
  assert.match(changes[0], /zooms from 1x to 1.2x over 3.0s and drifts left/)
  assert.deepEqual(draft.segments.find(s => s.id === 'title').layout['alpha.keyframes'], [{ 'time.ms': 0, value: 0 }, { 'time.ms': 500, value: 1 }])
  assert.deepEqual(validate(draft), [])
  const cleared = applyOperations(draft, [{ op: 'animate', id: 'title', property: 'opacity', keyframes: [] }]).draft
  assert.equal('alpha.keyframes' in cleared.segments.find(s => s.id === 'title').layout, false)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'animate', id: 'title', property: 'opacity', keyframes: [{ time_ms: 0, value: 0 }, { time_ms: 9000, value: 1 }] }]), /time_ms must be/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'animate', id: 'music', property: 'scale', keyframes: [{ time_ms: 0, value: 1 }, { time_ms: 1, value: 2 }] }]), /only video clips, images and text/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'zoom', id: 'title' }]), /zoom works on video/)
})

test('music: start offset, sound effects and lowering it under speech', () => {
  const { draft, changes } = applyOperations(sampleDraft(), [
    { op: 'add_audio', source: 'sid://song', source_start_ms: 30000, duration_ms: 4000, volume: 0.8 },
    { op: 'add_audio', source: 'sid://whoosh', kind: 'sound', start_ms: 3200, duration_ms: 600 },
  ])
  const song = draft.segments.find(s => s.attributes?.source === 'sid://song')
  assert.deepEqual([song.attributes['start.ms'], song.attributes['end.ms']], [30000, 34000])
  const whoosh = draft.segments.find(s => s.attributes?.source === 'sid://whoosh')
  assert.deepEqual([whoosh.attributes.meta_type, whoosh.attributes.auto_loop], ['SOUND', false])
  assert.match(changes[1], /at 3200 ms/)
  // The song plays project 0-4000 from source 30000; duck project 1000-2000 to 25% with 200 ms crossfades.
  const ducked = applyOperations(draft, [{ op: 'duck', id: song.id, ranges: [{ start_ms: 1000, end_ms: 2000 }], fade_ms: 200 }]).draft
  const parts = ducked.segments.filter(s => s.attributes?.source === 'sid://song').sort((x, y) => x.timeline['start.ms'] - y.timeline['start.ms'])
  assert.deepEqual(parts.map(p => [p.timeline['start.ms'], p.timeline['duration.ms'], p.attributes.volume, p.attributes['start.ms'], p.attributes['end.ms']]), [
    [0, 1100, 0.8, 30000, 31100],
    [900, 1200, 0.2, 30900, 32100],
    [1900, 2100, 0.8, 31900, 34000],
  ])
  assert.equal(parts[0].id, song.id, 'the first part keeps the original id')
  assert.notEqual(parts[1].layout.layer, parts[0].layout.layer, 'overlapping parts sit on two layers')
  assert.equal(parts[2].layout.layer, parts[0].layout.layer)
  assert.deepEqual([parts[0].attributes['fade_out.ms'], parts[1].attributes['fade_in.ms'], parts[1].attributes['fade_out.ms'], parts[2].attributes['fade_in.ms']], [200, 200, 200, 200])
  assert.ok(parts.every(p => !('volume.keyframes' in p.attributes)), 'no keyframes, which CapCut drops')
  // Close ranges merge, ranges are clipped to the track, and a very short dip is widened to one fade.
  const merged = applyOperations(sampleDraft(), [{ op: 'duck', id: 'music', ranges: [{ start_ms: 1000, end_ms: 2000 }, { start_ms: 2100, end_ms: 9000 }], to: 0.5 }]).draft
  assert.deepEqual(merged.segments.filter(s => s.type === 'AUDIO').map(p => p.attributes.volume), [0.5, 0.25])
  const blip = applyOperations(sampleDraft(), [{ op: 'duck', id: 'music', ranges: [{ start_ms: 2500, end_ms: 2550 }] }]).draft
  const low = blip.segments.find(s => s.type === 'AUDIO' && s.attributes.volume < 0.5)
  assert.ok(low.timeline['duration.ms'] >= 300)
  assert.deepEqual(validate(ducked), [])
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'duck', id: 'clip_a', ranges: [{ start_ms: 0, end_ms: 1000 }] }]), /works on music and sound/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'duck', id: 'title', ranges: [{ start_ms: 0, end_ms: 1 }] }]), /works on music and sound/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'duck', id: 'music', ranges: [{ start_ms: 9000, end_ms: 9500 }] }]), /None of the ranges/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_audio', source: 'sid://x', kind: 'voice' }]), /kind must be/)
})

test('clips, images and text share layers: captions avoid an overlay on layer 1', () => {
  // A read-back-style draft: CapCut renumbered layers into one sequence (logo 1, title 2).
  const d = sampleDraft()
  d.segments.push({ id: 'logo', type: 'VIDEO', parent_id: 'draft', timeline: { 'start.ms': 0, 'duration.ms': 5000 }, layout: { layer: 1 }, attributes: { source: 'tos://logo', meta_type: 'photo' } })
  d.segments.find(s => s.id === 'title').layout.layer = 2
  const { draft } = applyOperations(d, [
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'One' }, { start_ms: 1000, end_ms: 2000, text: 'Two' }] },
  ])
  const caps = draft.segments.filter(s => s.id.startsWith('caption_'))
  assert.ok(caps.every(c => c.layout.layer === 3), 'captions skip the logo (1) and the title (2)')
  assert.deepEqual(validate(draft), [])
  // A caption on the logo's layer is caught locally, before CapCut rejects the save.
  const clash = structuredClone(draft)
  clash.segments.find(s => s.id === 'caption_0').layout.layer = 1
  assert.match(validate(clash).join('\n'), /caption_0 overlap on layer 1/)
  // CapCut's read-back spreads captions over layers (here 3 and 4); reset puts them back on one free layer.
  caps[1].layout.layer = 4
  const { draft: reset } = applyOperations(draft, [{ op: 'reset_caption_layers' }])
  assert.ok(reset.segments.filter(s => s.id.startsWith('caption_')).every(c => c.layout.layer === 3))
  assert.deepEqual(validate(reset), [])
  // A new title goes above everything; an explicit caption layer that clashes is refused.
  const titled = applyOperations(reset, [{ op: 'add_text', content: 'Hi', start_ms: 0, duration_ms: 500 }]).draft
  assert.ok(titled.segments.find(s => s.attributes?.content === 'Hi').layout.layer >= 1000)
  assert.throws(() => applyOperations(d, [{ op: 'add_captions', layer: 1, cues: [{ start_ms: 0, end_ms: 500, text: 'x' }] }]), /already has a clip, image or text/)
})

test('speed changes and moves drop the stale end.ms from read-back timelines', () => {
  const d = sampleDraft()
  d.segments[1].timeline['end.ms'] = 3000
  d.segments[2].timeline['end.ms'] = 5000
  const { draft } = applyOperations(d, [{ op: 'set_speed', id: 'clip_a', speed: 2 }])
  assert.ok(draft.segments.slice(1, 3).every(s => !('end.ms' in s.timeline)))
  const t = sampleDraft(); t.segments[4].timeline['end.ms'] = 2000
  assert.equal('end.ms' in applyOperations(t, [{ op: 'place', id: 'title', start_ms: 100 }]).draft.segments[4].timeline, false)
  assert.equal(applyOperations(sampleDraft(), [{ op: 'update', id: 'clip_a', background_blur: true }]).draft.segments[1].attributes['background.blur'], 0.2)
})

test('transitions go between touching clips on one track, and are replaced, removed and cleaned up', () => {
  const { draft, changes } = applyOperations(sampleDraft(), [{ op: 'add_transition', id: 'clip_a', source: 'vimo://t1' }])
  const a = draft.segments.find(s => s.id === 'clip_a').attributes
  assert.equal(a.transition, 'vimo://t1')
  assert.equal(a['transition.duration.ms'], 500)
  assert.match(changes[0], /into clip_b/)
  const replaced = applyOperations(draft, [{ op: 'add_transition', id: 'clip_a', source: 'vimo://t2', duration_ms: 800 }]).draft
  assert.equal(replaced.segments[1].attributes.transition, 'vimo://t2')
  assert.equal(replaced.segments[1].attributes['transition.duration.ms'], 800)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_transition', id: 'clip_b', source: 'vimo://t1' }]), /No clip starts right where clip_b ends/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_transition', id: 'clip_a', source: 'vimo://t1', duration_ms: 2500 }]), /at most 2000 ms/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_transition', id: 'clip_a', source: 'sid://x' }]), /vimo:\/\//)
  const off = applyOperations(draft, [{ op: 'add_transition', id: 'clip_a', source: null }]).draft
  assert.equal('transition' in off.segments[1].attributes, false)
  const removed = applyOperations(draft, [{ op: 'remove', id: 'clip_b' }])
  assert.equal('transition' in removed.draft.segments[1].attributes, false)
  assert.match(removed.changes[0], /transition on clip_a was removed/)
  // CapCut keeps the main track gap-free, so a main-track clip can't be moved on its own.
  assert.throws(() => applyOperations(draft, [{ op: 'place', id: 'clip_b', start_ms: 3500 }]), /gap-free/)
  // Trimming the first clip keeps the clips touching, so the transition stays.
  const trimmed = applyOperations(draft, [{ op: 'place', id: 'clip_a', duration_ms: 2000 }]).draft
  assert.equal(trimmed.segments[1].attributes.transition, 'vimo://t1')
  assert.equal(trimmed.segments[2].timeline['start.ms'], 2000)
})

test('filters and effects cover a range, one clip or the whole video, on a layer above what they cover', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'add_filter', source: 'vimo://warm' },
    { op: 'add_effect', source: 'vimo://glow', over: 'clip_b', intensity: 0.4 },
    { op: 'add_filter', source: 'vimo://bw', start_ms: 1000, duration_ms: 500, intensity: 0.3 },
  ])
  const [whole, glow, bw] = ['filter_0', 'effect_0', 'filter_1'].map(id => draft.segments.find(s => s.id === id))
  assert.deepEqual([whole.type, whole.timeline, whole.attributes.intensity], ['COLOR_FILTER', { 'start.ms': 0, 'duration.ms': 5000 }, 0.6])
  assert.equal(whole.layout.layer, 1001, 'above the title on 1000')
  assert.deepEqual([glow.type, glow.timeline, glow.attributes.effects_adjust_intensity], ['VIDEO_EFFECT', { 'start.ms': 3000, 'duration.ms': 2000 }, 0.4])
  assert.equal(glow.layout.layer, 1002)
  assert.equal(bw.layout.layer, 1002, 'the glow effect is later, so its layer is free here')
  assert.deepEqual(validate(draft), [])
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_filter', source: 'vimo://x', start_ms: 4000, duration_ms: 2000 }]), /after the end of the video/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_filter', source: 'vimo://x', intensity: 2 }]), /intensity/)
  const weaker = applyOperations(draft, [{ op: 'update', id: 'filter_0', intensity: 0.2 }, { op: 'update', id: 'effect_0', source: 'vimo://sparkle' }]).draft
  assert.equal(weaker.segments.find(s => s.id === 'filter_0').attributes.intensity, 0.2)
  assert.equal(weaker.segments.find(s => s.id === 'effect_0').attributes.source, 'vimo://sparkle')
  // Captions added later avoid layers the filters use, and an effect attached under a clip is accepted.
  const d = sampleDraft()
  d.segments.push({ id: 'fx', type: 'VIDEO_EFFECT', parent_id: 'clip_a', attributes: { source: 'vimo://fx' } })
  assert.deepEqual(validate(d), [])
  assert.match(summarize(d), /with effect fx/)
  const gone = applyOperations(d, [{ op: 'remove', id: 'clip_a' }])
  assert.ok(!gone.draft.segments.some(s => s.id === 'fx'), 'the effect goes with its clip')
})

test('text templates, text effects, vertical text and bubbles', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'add_text_template', source: 'vimo://tpl', texts: ['Big Sale', 'This weekend'], start_ms: 0, duration_ms: 3000, position_y: 0.5, scale: 0.8 },
    { op: 'update', id: 'title', text_effect: 'vimo://gold', vertical: true, bubble: 'vimo://cloud' },
  ])
  const t = draft.segments.find(s => s.type === 'TEXT_TEMPLATE')
  assert.deepEqual(t.attributes, { source: 'vimo://tpl', contents: ['Big Sale', 'This weekend'] })
  assert.deepEqual([t.layout.position_y, t.layout.scale_x, t.layout.scale_y], [0.5, 0.8, 0.8])
  const title = draft.segments.find(s => s.id === 'title').attributes
  assert.deepEqual([title.flower, title.type_setting, title.bubble], ['vimo://gold', 1, 'vimo://cloud'])
  assert.deepEqual(validate(draft), [])
  assert.match(summarize(draft), /texts \["Big Sale","This weekend"\]/)
  const renamed = applyOperations(draft, [{ op: 'update', id: t.id, texts: ['Huge Sale', 'Today'] }, { op: 'update', id: 'title', text_effect: null }]).draft
  assert.deepEqual(renamed.segments.find(s => s.id === t.id).attributes.contents, ['Huge Sale', 'Today'])
  assert.equal('flower' in renamed.segments.find(s => s.id === 'title').attributes, false)
  assert.throws(() => applyOperations(draft, [{ op: 'update', id: t.id, content: 'x' }]), /use texts/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_text_template', source: 'vimo://tpl', texts: [], start_ms: 0, duration_ms: 1 }]), /texts/)
})

test('captions carry word timings, and a caption template turns them into caption-template segments', () => {
  const { draft } = applyOperations(sampleDraft(), [{ op: 'add_captions', cues: [
    { start_ms: 1000, end_ms: 3000, text: 'Hello big world', words: [{ text: 'Hello', start_ms: 1000, end_ms: 1500 }, { text: 'big', start_ms: 1500, end_ms: 2000 }, { text: 'world', start_ms: 2000, end_ms: 3000 }] },
    { start_ms: 3000, end_ms: 4000, text: 'Bye' },
  ] }])
  const [one, two] = draft.segments.filter(s => s.id.startsWith('caption_'))
  assert.deepEqual(one.attributes.caption_timeline, [
    { text: 'Hello ', 'start.ms': 0, 'end.ms': 500 }, { text: 'big ', 'start.ms': 500, 'end.ms': 1000 }, { text: 'world', 'start.ms': 1000, 'end.ms': 2000 },
  ])
  assert.equal(one.attributes.caption_timeline.map(w => w.text).join(''), one.attributes.content)
  assert.deepEqual(two.attributes.caption_timeline, [{ text: 'Bye', 'start.ms': 0, 'end.ms': 1000 }])
  assert.equal(one.attributes.font, 'vimo://7317175475195875841', 'a default library font')
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'Hi there', words: [{ text: 'Hi', start_ms: 0, end_ms: 500 }, { text: 'you', start_ms: 500, end_ms: 1000 }] }] }]), /don't match/)
  // Rewriting the text rewrites the timings with it; a longer caption stretches a one-entry timing.
  const edited = applyOperations(draft, [{ op: 'update', id: one.id, content: 'Hi world' }, { op: 'place', id: two.id, duration_ms: 1500 }]).draft
  assert.deepEqual(edited.segments.find(s => s.id === one.id).attributes.caption_timeline, [{ text: 'Hi world', 'start.ms': 0, 'end.ms': 2000 }])
  assert.equal(edited.segments.find(s => s.id === two.id).attributes.caption_timeline[0]['end.ms'], 1500)
  assert.throws(() => applyOperations(draft, [{ op: 'place', id: one.id, duration_ms: 1200 }]), /update content first/)
  const tpl = applyOperations(sampleDraft(), [{ op: 'add_captions', template: 'vimo://karaoke', cues: [{ start_ms: 0, end_ms: 1000, text: 'Sing' }] }, { op: 'reset_caption_layers' }]).draft
  const sub = tpl.segments.find(s => s.type === 'SUBTITLE_TEMPLATE')
  assert.deepEqual(sub.attributes, { source: 'vimo://karaoke', content: 'Sing', subtitle_timeline: [{ text: 'Sing', 'start.ms': 0, 'end.ms': 1000 }] })
  assert.deepEqual(validate(tpl), [])
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_captions', template: 'vimo://k', font: 'vimo://1', cues: [{ start_ms: 0, end_ms: 1, text: 'x' }] }]), /brings its own look/)
})

test('style changes reach the per-letter style copies CapCut keeps, and text edits clip them', () => {
  const d = sampleDraft()
  d.segments[4].attributes.border_width = 0.06
  d.segments.push(
    { id: 'p1', type: 'PATCH', parent_id: 'title', attributes: { letter_start: 0, letter_end: 5, font: 'vimo://old', border_width: 0.06 } },
    { id: 'p2', type: 'PATCH', parent_id: 'title', attributes: { letter_start: 3, letter_end: 5, font_size: 13 } },
  )
  assert.deepEqual(validate(d), [])
  const { draft, changes } = applyOperations(d, [{ op: 'update', id: 'title', font: 'vimo://new', outline_width: 0.1, font_color: '#ff0000' }])
  const [p1, p2] = ['p1', 'p2'].map(id => draft.segments.find(s => s.id === id).attributes)
  assert.deepEqual([p1.font, p1.border_width, p1.font_color], ['vimo://new', 0.1, '#FF0000'])
  assert.deepEqual([p2.font, p2.border_width, p2.font_color], ['vimo://new', 0.1, '#FF0000'])
  assert.match(changes[0], /2 per-letter style copies/)
  const short = applyOperations(d, [{ op: 'update', id: 'title', content: 'Hi' }])
  assert.equal(short.draft.segments.find(s => s.id === 'p1').attributes.letter_end, 2)
  assert.ok(!short.draft.segments.some(s => s.id === 'p2'), 'a copy past the new text is dropped')
  assert.ok(!applyOperations(d, [{ op: 'remove', id: 'title' }]).draft.segments.some(s => s.type === 'PATCH'), 'copies go with their text')
})

test('blend, cutout and canvas size', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'update', id: 'clip_b', blend_mode: 'screen', blend_intensity: 0.7, cutout: true },
    { op: 'set_canvas', ratio: '16:9' },
  ])
  const b = draft.segments.find(s => s.id === 'clip_b').attributes
  // CapCut stores Screen as a library resource and the strength as the clip's opacity.
  assert.deepEqual([b.blend_mode, 'blend_intensity' in b, b.matting], ['vimo://6758325170760323597', false, true])
  assert.equal(draft.segments.find(s => s.id === 'clip_b').layout.alpha, 0.7)
  assert.deepEqual(draft.segments[0].attributes, { width: 1920, height: 1080, ratio_type: '16:9' })
  assert.match(summarize(draft), /Canvas 1920x1080 \(16:9\)/)
  assert.match(summarize(draft), /blend screen at 70% background removed/)
  const plain = applyOperations(draft, [{ op: 'update', id: 'clip_b', blend_mode: 'normal', cutout: false }, { op: 'set_canvas', width: 1000, height: 1000 }]).draft
  assert.deepEqual(['blend_mode', 'blend_intensity', 'matting'].filter(k => k in plain.segments[2].attributes), [])
  assert.equal(plain.segments[0].attributes.ratio_type, 'custom')
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'clip_b', blend_mode: 'multiply' }]), /blend_mode must be screen, normal, or/)
  // A mode applied in the editor can be reused by its source.
  assert.equal(applyOperations(sampleDraft(), [{ op: 'update', id: 'clip_b', blend_mode: 'vimo://123' }]).draft.segments[2].attributes.blend_mode, 'vimo://123')
  // CapCut turns cutout into an AI_MATTING segment under the clip; the summary shows it and cutout: false removes it.
  const readBack = sampleDraft()
  readBack.segments.push({ id: 'm1', type: 'AI_MATTING', parent_id: 'clip_b', attributes: {} })
  assert.match(summarize(readBack), /clip_b .* background removed/)
  assert.ok(!applyOperations(readBack, [{ op: 'update', id: 'clip_b', cutout: false }]).draft.segments.some(s => s.id === 'm1'))
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'set_canvas', ratio: '5:4' }]), /ratio must be one of/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'title', cutout: true }]), /only on video clips/)
  const bad = sampleDraft(); bad.segments[0].attributes.ratio_type = '5:4'
  assert.match(validate(bad).join(), /not one CapCut accepts/)
})

test('0.4.1: text effects reach style copies, and keys CapCut dropped from copies are restored', () => {
  const d = sampleDraft()
  d.segments[4].attributes.border_width = 0.08
  d.segments[4].attributes.border_color = '#000000'
  d.segments.push({ id: 'p1', type: 'PATCH', parent_id: 'title', attributes: { letter_start: 0, letter_end: 5, border_width: 0.02 } })
  const { draft, changes } = applyOperations(d, [{ op: 'update', id: 'title', text_effect: 'vimo://gold' }])
  const p1 = draft.segments.find(s => s.id === 'p1').attributes
  assert.equal(p1.flower, 'vimo://gold')
  assert.equal(p1.border_color, '#000000', 'a dropped key is filled back in')
  assert.equal(p1.border_width, 0.02, 'a value the copy has is left alone')
  assert.match(changes.join('\n'), /Restored .* 1 per-letter style copy/)
  const off = applyOperations(draft, [{ op: 'update', id: 'title', text_effect: null }]).draft
  assert.equal('flower' in off.segments.find(s => s.id === 'p1').attributes, false)
})

test('0.4.1: removing or trimming a main-track clip closes the gap and moves later items with it', () => {
  const d = sampleDraft()
  d.segments.push(
    { id: 'caption_9', type: 'TEXT', parent_id: 'draft', timeline: { 'start.ms': 3500, 'duration.ms': 1000 }, layout: { layer: 1 }, attributes: { content: 'Over clip b' } },
    { id: 'early', type: 'TEXT', parent_id: 'draft', timeline: { 'start.ms': 500, 'duration.ms': 1000 }, layout: { layer: 2 }, attributes: { content: 'Over clip a' } },
  )
  const { draft, changes } = applyOperations(d, [{ op: 'remove', id: 'clip_a' }])
  const at = id => draft.segments.find(s => s.id === id).timeline['start.ms']
  assert.equal(at('clip_b'), 0)
  assert.equal(at('caption_9'), 500, 'the caption over clip b moved with it')
  assert.equal(at('music'), 0, 'music that started earlier stays')
  assert.match(changes[0], /main track closed up/)
  assert.match(changes[0], /check them: title, early/)
  const textGone = applyOperations(sampleDraft(), [{ op: 'remove', id: 'title' }]).changes[0]
  assert.doesNotMatch(textGone, /gap/)
  const sped = applyOperations(d, [{ op: 'set_speed', id: 'clip_a', speed: 2 }]).draft
  assert.equal(sped.segments.find(s => s.id === 'caption_9').timeline['start.ms'], 2000)
})

test('0.4.1: duck keeps the track fade-out on a part long enough for it', () => {
  const d = sampleDraft()
  d.segments[3].attributes['fade_out.ms'] = 2000
  const { draft } = applyOperations(d, [{ op: 'duck', id: 'music', ranges: [{ start_ms: 1000, end_ms: 4350 }] }])
  const parts = draft.segments.filter(s => s.type === 'AUDIO').sort((a, b) => a.timeline['start.ms'] - b.timeline['start.ms'])
  assert.equal(parts.length, 2, 'the 650 ms tail after the speech folds into the quiet part')
  assert.equal(parts.at(-1).attributes['fade_out.ms'], 2000)
})

test('0.4.1: vertical canvases warn about safe zones and long template lines', () => {
  const d = sampleDraft()
  const { draft } = applyOperations(d, [
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'Safe' }] },
    { op: 'add_text', content: 'Low', start_ms: 0, duration_ms: 1000, position_y: -0.8 },
    { op: 'add_captions', template: 'vimo://k', cues: [{ start_ms: 2000, end_ms: 3000, text: 'This caption is far too long to fit on one line' }] },
  ])
  assert.equal(draft.segments.find(s => s.id === 'caption_0').layout.position_y, -0.45, 'captions sit above the Reels and TikTok bar')
  const text = summarize(draft)
  assert.match(text, /buttons and captions may cover it: text_0/)
  assert.match(text, /may run off the frame .*: caption_1/)
})
