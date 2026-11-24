#!/usr/bin/env node
// Motion videos with HyperFrames (HeyGen's open-source HTML-to-video renderer, Apache 2.0), for the
// capcut-motion skill.
//
//   node motion.mjs setup                      Install the pinned HyperFrames CLI and its Chrome, then check
//                                              Node.js, ffmpeg, ffprobe and Chrome. Downloads on first use only.
//   node motion.mjs hf <command> [args...]     Run a local HyperFrames command (init, check, snapshot, render, ...)
//                                              from the current folder, with update checks, skill installs and
//                                              usage tracking turned off.
//   node motion.mjs probe <file>...            Print width, height, fps, frames, length and audio of rendered files.
//   node motion.mjs ops --plan plan.json --out ops.json
//                                              Turn a shot plan into capcut-draft operations for a new draft.
//
// HyperFrames is pinned to one tested release so the CLI and promptcut's guidance match. Rendering runs on this
// computer; nothing is sent to HeyGen's cloud.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const HYPERFRAMES_VERSION = '0.8.185'
const ENTRY = path.join('node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')

// Commands that work on local files. Cloud rendering, publishing, deploys, desktop-app hand-offs, skill installs
// and upgrades are left out on purpose.
export const LOCAL_COMMANDS = new Set([
  'init', 'add', 'catalog', 'lint', 'check', 'validate', 'inspect', 'snapshot', 'keyframes', 'preview', 'render',
  'info', 'compositions', 'timeline', 'history', 'audio', 'beats', 'media-treatment', 'normalize-audio', 'compare',
  'docs', 'doctor', 'browser', '--version', '--help',
])

export function runtimeDir(env = process.env) {
  return path.resolve(env.PROMPTCUT_HYPERFRAMES_DIR || path.join(os.homedir(), '.cache', 'promptcut', `hyperframes-${HYPERFRAMES_VERSION}`))
}

function quietEnv() {
  return { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1' }
}

function installed(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'hyperframes', 'package.json'), 'utf8'))
    return manifest.version === HYPERFRAMES_VERSION && fs.existsSync(path.join(dir, ENTRY))
  } catch {
    return false
  }
}

function run(command, args, { capture = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: quietEnv(), stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true })
    let out = ''
    let err = ''
    if (capture) {
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { err = (err + d).slice(-4000) })
    }
    const stop = signal => () => child.kill(signal)
    const onInt = stop('SIGINT'), onTerm = stop('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      if (code === 0) resolve(out)
      else reject(new Error(`${path.basename(command)} ${args[0] ?? ''} failed (${signal || code})${err ? `: ${err.trim()}` : ''}`))
    })
  })
}

function requireNode22() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Motion videos need Node.js 22 or later; this is ${process.versions.node}.`)
}

function hasTool(name) {
  const r = spawnSync(name, ['-version'], { stdio: 'ignore', windowsHide: true })
  return !r.error && r.status === 0
}

async function setup() {
  requireNode22()
  for (const tool of ['ffmpeg', 'ffprobe']) if (!hasTool(tool)) throw new Error(`${tool} is missing. Install ffmpeg (it includes ffprobe), then run setup again.`)
  const dir = runtimeDir()
  if (!installed(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const stage = fs.mkdtempSync(path.join(path.dirname(dir), '.hyperframes-install-'))
    try {
      const args = ['install', '--prefix', stage, '--no-audit', '--no-fund', '--save-exact', `hyperframes@${HYPERFRAMES_VERSION}`]
      if (process.platform === 'win32') {
        const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        await run(process.execPath, [npm, ...args])
      } else {
        await run('npm', args)
      }
      if (!installed(stage)) throw new Error(`Installing hyperframes@${HYPERFRAMES_VERSION} didn't produce its CLI`)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.renameSync(stage, dir)
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
    }
  }
  const cli = path.join(dir, ENTRY)
  await run(process.execPath, [cli, 'browser', 'ensure'])
  const doctor = JSON.parse(await run(process.execPath, [cli, 'doctor', '--json'], { capture: true }))
  const needed = ['Node.js', 'FFmpeg', 'FFprobe', 'Chrome']
  const checks = needed.map(name => doctor.checks?.find(c => c.name === name) ?? { name, ok: false, detail: 'not checked' })
  const failed = checks.filter(c => !c.ok)
  if (failed.length) throw new Error(failed.map(c => `${c.name}: ${c.detail}`).join('; '))
  console.log(JSON.stringify({ ready: true, version: HYPERFRAMES_VERSION, runtime: dir, checks }))
}

const NOTE = `# promptcut motion video

This HyperFrames project is driven by promptcut's capcut-motion skill. Run HyperFrames through
promptcut's scripts/motion.mjs ("node motion.mjs hf <command>"), not npx or a global install. Don't install or
update skills, render in the cloud or publish. Keep element ids stable, and check and snapshot changed shots
before rendering.
`

async function hf(args) {
  requireNode22()
  const [command] = args
  if (!LOCAL_COMMANDS.has(command)) {
    throw new Error(`"${command ?? ''}" isn't one of the local HyperFrames commands promptcut runs: ${[...LOCAL_COMMANDS].join(', ')}`)
  }
  const dir = runtimeDir()
  if (!installed(dir)) throw new Error('HyperFrames isn\'t set up yet. Run "node motion.mjs setup" first.')
  // init must create a new folder; replace the agent notes it writes with promptcut's, and only those.
  let fresh = null
  if (command === 'init' && !args.includes('--help')) {
    const name = args.slice(1).find(a => !a.startsWith('-'))
    if (!name) throw new Error('init needs the name of a new project folder')
    fresh = path.resolve(name)
    if (fs.existsSync(fresh)) throw new Error(`${fresh} already exists; init only creates a new folder`)
  }
  await run(process.execPath, [path.join(dir, ENTRY), ...args])
  if (fresh) for (const file of ['AGENTS.md', 'CLAUDE.md']) fs.writeFileSync(path.join(fresh, file), NOTE)
}

// ------------------------------------------------------------------ probe

function parseRate(rate) {
  const [n, d] = String(rate ?? '0/1').split('/').map(Number)
  return d ? n / d : n
}

export function summarizeProbe(file, probe) {
  const video = probe.streams?.find(s => s.codec_type === 'video')
  if (!video) return { file, error: 'no video stream' }
  const fps = Math.round(parseRate(video.avg_frame_rate || video.r_frame_rate) * 1000) / 1000
  const seconds = Number(probe.format?.duration ?? video.duration ?? 0)
  const frames = Number(video.nb_frames) || Math.round(seconds * fps)
  // Shot length on the timeline, from whole frames so cuts land on frame boundaries.
  const duration_ms = fps ? Math.round((frames / fps) * 1000) : Math.round(seconds * 1000)
  return { file, width: video.width, height: video.height, fps, frames, duration_ms, has_audio: probe.streams.some(s => s.codec_type === 'audio') }
}

function probe(files) {
  if (!files.length) throw new Error('probe needs at least one file')
  return files.map(file => {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', windowsHide: true })
    if (r.error || r.status !== 0) return { file, error: (r.stderr || r.error?.message || 'ffprobe failed').trim() }
    return summarizeProbe(file, JSON.parse(r.stdout))
  })
}

// ------------------------------------------------------------------ ops

// plan: {shots: [{id, vid, duration_ms, transition?: {source, duration_ms?}}], music?: {source, volume?,
// fade_out_ms?, source_start_ms?}, captions?: {cues, style?, font?, position_y?}}
// Shots go on the main track in order, with their chosen ids; a transition goes from a shot into the next one.
export function planToOps(plan) {
  if (!plan || !Array.isArray(plan.shots) || plan.shots.length === 0) throw new Error('plan.shots must list at least one shot')
  const ops = []
  const ids = new Set()
  plan.shots.forEach((shot, i) => {
    const label = `shot ${i + 1}`
    if (typeof shot.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(shot.id)) throw new Error(`${label} needs an id of letters, digits, _ or -`)
    if (ids.has(shot.id)) throw new Error(`${label}: id "${shot.id}" is used twice`)
    ids.add(shot.id)
    const vid = String(shot.vid ?? '').replace(/^vid:\/\//, '')
    if (!vid) throw new Error(`${label} (${shot.id}) has no uploaded vid`)
    if (!Number.isInteger(shot.duration_ms) || shot.duration_ms <= 0) throw new Error(`${label} (${shot.id}) needs duration_ms from probe`)
    ops.push({ op: 'add_video', id: shot.id, source: `vid://${vid}`, source_end_ms: shot.duration_ms, volume: shot.has_audio ? (shot.volume ?? 1) : 0 })
  })
  plan.shots.forEach((shot, i) => {
    if (!shot.transition) return
    if (i === plan.shots.length - 1) throw new Error(`The last shot (${shot.id}) has no next shot to transition into`)
    const t = { op: 'add_transition', id: shot.id, source: shot.transition.source }
    if (shot.transition.duration_ms !== undefined) t.duration_ms = shot.transition.duration_ms
    ops.push(t)
  })
  if (plan.music) {
    const m = { op: 'add_audio', kind: 'music', source: plan.music.source, start_ms: 0, volume: plan.music.volume ?? 0.6, loop: true }
    for (const key of ['fade_in_ms', 'fade_out_ms', 'source_start_ms', 'duration_ms']) if (plan.music[key] !== undefined) m[key] = plan.music[key]
    ops.push(m)
  }
  if (plan.captions?.cues?.length) {
    const c = { op: 'add_captions', cues: plan.captions.cues }
    for (const key of ['style', 'font', 'font_size', 'position_y']) if (plan.captions[key] !== undefined) c[key] = plan.captions[key]
    ops.push(c, { op: 'reset_caption_layers' })
  }
  return ops
}

// ------------------------------------------------------------------ CLI

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'setup') return setup()
  if (command === 'hf') return hf(rest)
  if (command === 'probe') return console.log(JSON.stringify(probe(rest)))
  if (command === 'ops') {
    const arg = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
    const planFile = arg('--plan'), out = arg('--out')
    if (!planFile || !out) throw new Error('ops needs --plan <plan.json> and --out <ops.json>')
    const ops = planToOps(JSON.parse(fs.readFileSync(planFile, 'utf8').replace(/^﻿/, '')))
    fs.writeFileSync(out, JSON.stringify(ops, null, 2))
    return console.log(JSON.stringify({ success: true, out, operations: ops.length }))
  }
  console.log('Usage:\n  motion.mjs setup\n  motion.mjs hf <command> [args...]\n  motion.mjs probe <file>...\n  motion.mjs ops --plan plan.json --out ops.json')
  process.exitCode = command ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
