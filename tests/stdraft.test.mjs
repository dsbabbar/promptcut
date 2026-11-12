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
  assert.deepEqual(added.timeline, { 'start.ms': 5000, 'duration.ms': 2000 })
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
  assert.deepEqual(images[1].timeline, { 'start.ms': 4000, 'duration.ms': 2500 })
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
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'clip_a', shadow: true }]), /only on TEXT/)
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
