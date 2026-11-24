---
name: capcut-motion
description: Make animated explainers, motion graphics, kinetic text, animated titles and intros, data and product animations as HTML with HyperFrames, render them on the user's computer and assemble them into an editable CapCut draft (or one MP4). Use when the user wants to explain how something works, show a process or numbers in motion, make an animated title, intro or outro, or asks for an HTML, coded or HyperFrames video. Not for cutting real footage (capcut-rough-cut, capcut-draft) or AI video-model clips (capcut-generate).
---

# Motion videos with HyperFrames

Claude writes each shot as an HTML page animated with GSAP, renders it to MP4 with HyperFrames (HeyGen's open-source renderer, Apache 2.0) on this computer, then uploads the shots and puts them in a CapCut draft. Music, captions and voice stay as normal CapCut tracks, so the user can keep editing them. Animation is baked into each shot, so it survives CapCut's cloud drafts, which drop keyframes.

Before the first CapCut account step in this conversation, check the sign-in with `capcut_get_profile` as the `capcut-connect` skill describes. Make sure the `capcut-connect` skill's setup check has passed before running scripts.

## When to use which skill

| The user wants | Use |
| --- | --- |
| An animated explanation, a process or steps, numbers or charts moving, kinetic text, an animated title, intro, outro or logo sting, a product or UI walkthrough built from graphics | This skill |
| Their own footage cut, captioned or polished | `capcut-rough-cut`, `capcut-draft` |
| A realistic scene from a video model ("a drone shot over a city") | `capcut-generate` |
| A slide deck | `capcut-slides` |

Shots can mix: an authored title, then real footage, then an animated chart. Real footage and AI images or clips can also go inside an HTML shot as ingredients.

## Requirements

- **Node.js 22 or later** and **ffmpeg** (with ffprobe). promptcut's other features need only Node.js 20.
- **First-time setup** downloads the HyperFrames CLI (about 80 packages from npm) and a headless Chrome for rendering (about 150 MB). Tell the user and ask before the first setup: `node "${CLAUDE_PLUGIN_ROOT}/scripts/motion.mjs" setup`. It prints `"ready": true` when Node.js, ffmpeg, ffprobe and Chrome all pass. Later runs reuse it.
- An internet connection while rendering, for GSAP and any web fonts the pages load.

Run every HyperFrames command through promptcut's runner, from the project folder: `node "${CLAUDE_PLUGIN_ROOT}/scripts/motion.mjs" hf <command> [args]`. It pins HyperFrames 0.8.185 and turns off update checks, skill installs and usage tracking. It refuses cloud rendering, publishing and deploys; never work around that with `npx`. HyperFrames' own reference for this version: `motion.mjs hf docs data-attributes`, `... docs compositions`, `... docs gsap`, `... docs troubleshooting`.

## 1. Brief (keep it short)

Reuse what the user already said. Ask only what blocks a sensible plan, at most two questions. Decide:

- **Goal and audience**, and the one thing the viewer should understand or feel.
- **Length and shape:** 9:16 (Reels, TikTok, Shorts, 1080x1920), 16:9 (YouTube, presentations, 1920x1080) or 1:1 (1080x1080).
- **Text-led or voice-led.** Text-led is the default. For voice, use a recording the user supplies; don't invent narration audio.
- **Music:** from CapCut's library, added later in the draft.
- **Facts:** use only what the user gave or what you can check. Mark anything unverified, and never invent statistics, prices or quotes.

For anything over one shot, show a shot list in the chat and wait for an OK on the direction:

| # | Shot id | Seconds | On screen | Motion | Text |
| --- | --- | --- | --- | --- | --- |

Plan for reading time: about 3 words a second for short lines, and at least 1.5 seconds for any line. Then build without asking again unless something changes the direction.

## 2. Project and authoring

Keep one folder per film: `videos/<slug>/` with `plan.json`, `source/` (the HyperFrames project) and `exports/` (rendered shots).

1. `cd videos/<slug>` and run `motion.mjs hf init source --non-interactive --example blank --resolution portrait` (or `landscape` or `square`). Then work inside `source/`.
2. Write **one composition per shot** in `source/compositions/<shot-id>.html`, each a complete page at the film's canvas size. Shots are rendered separately, then joined in CapCut. The rules every composition follows:
   - A root element with `data-composition-id` (use the shot id), `data-width`, `data-height`, `data-start="0"` and `data-duration` (seconds).
   - Timed elements get `class="clip"` with their own `data-start` and `data-duration`.
   - Animate with GSAP: create the timeline `{ paused: true }`, set times with the position argument (`tl.to(el, vars, 1.2)`), and register it as `window.__timelines["<composition id>"] = tl`. The renderer seeks it frame by frame.
   - Keep it deterministic: no `Math.random()` without a fixed seed, no clocks, no `setTimeout` or `requestAnimationFrame` loops driving the picture, no data fetched while rendering. Put images, video and fonts in `source/assets/` and reference them by relative path.
   - Text stays readable: at least 48 px on 1080-wide canvases, strong contrast, inside the safe zone (on 9:16, keep text out of the bottom fifth, the top tenth and the right edge, where Reels and TikTok put their buttons).
   Then mount every shot, in order, in `source/index.html`, so the whole film can be checked and previewed on one timeline. Replace the example content inside its root with one host per shot, and set the root's `data-duration` to the film's total length:

   ```html
   <div id="shot-intro" class="clip" data-composition-id="intro" data-composition-src="compositions/intro.html" data-start="0" data-duration="2"></div>
   <div id="shot-steps" class="clip" data-composition-id="steps" data-composition-src="compositions/steps.html" data-start="2" data-duration="6"></div>
   ```

   Each host needs its own `id`, the shot's `data-composition-id`, and start and length in seconds on the film's timeline. Keep the root's own paused timeline registered under its id (`main` in the blank example).
3. Design with intent: one clear idea per shot, a consistent palette and one or two typefaces, motion that shows the change being explained (a value growing, a step connecting to the next), not decoration. Build later shots on what the viewer has already seen.
4. **Ingredients:** AI images or clips come from `capcut-generate` (credits are quoted and confirmed there); download them with `scripts/download-media.mjs` into `source/assets/`. The user's photos and footage can go in as `<img>` or `<video>` (`data-media-start` trims video, `data-volume` sets its sound).

## 3. Check one key shot first

Before building everything, finish the most important shot, then from `source/`:

1. `motion.mjs hf check --json`: fix every error it reports.
2. `motion.mjs hf snapshot --composition <shot-id> --frames 4 --json`, or `--at <seconds>` on the film's timeline for exact moments (when text has fully arrived, mid-motion, the end). Open the PNGs it lists and look at them: text fits and is readable, nothing is cut off or overlapping, the motion moment shows what you intended.
3. Fix and repeat, then build the remaining shots the same way.

## 4. Render

For each shot, from `source/`: `motion.mjs hf render --composition compositions/<shot-id>.html --output ../exports/<shot-id>.mp4 --quality delivery`. Run renders one at a time, keep the process attached and wait for it; don't start a second render of the same shot because one is slow. A file left by a failed render isn't a result.

Then `motion.mjs probe exports/*.mp4`. Every shot must match the canvas size and frame rate, with the length you planned. Use each shot's `duration_ms` from probe in the plan. Snapshot or watch any shot whose length or size is off before going on.

## 5. Assemble the CapCut draft

1. Upload all shots in one batch with `capcut-upload` (they're videos, so each returns a `vid`).
2. Write `plan.json`:

   ```json
   {
     "shots": [
       { "id": "intro", "vid": "<vid>", "duration_ms": 2000, "transition": { "source": "vimo://<id>", "duration_ms": 400 } },
       { "id": "steps", "vid": "<vid>", "duration_ms": 6000 }
     ],
     "music": { "source": "sid://<id>", "volume": 0.5, "fade_out_ms": 1500 },
     "captions": { "cues": [{ "start_ms": 0, "end_ms": 1800, "text": "..." }], "font": "vimo://<id>" }
   }
   ```

   `transition` is optional, from a shot into the next (search transitions with `capcut-materials`); hard cuts usually suit authored graphics best. `music` comes from `capcut-materials`. Add `captions` only for spoken voice, not for text already drawn in the shots. Set `has_audio: true` on a shot that should keep its own sound; silent renders are muted.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/motion.mjs" ops --plan plan.json --out ops.json` writes the draft operations: shots on the main track in order with their ids, then transitions, music and captions.
4. Follow the `capcut-draft` skill from "An uploaded video with no draft": `stdraft.mjs new` with the film's canvas size, `apply` with `ops.json`, check the summary, start a draft session and save. Give the user the web editor link, and tell them once that the draft name resets on each save.

Tell the user what's editable: in CapCut they can reorder, trim, swap or remove shots, and change music, captions and transitions. The animation and text inside a shot are part of its video; changing them means editing the HTML and rendering that shot again.

## 6. Changes later

- **Change inside a shot:** edit its HTML, check, snapshot, render it again to `exports/<shot-id>.mp4`, upload it, then `update` that segment's `source` with the new `vid`. If its length changed, `place` its `duration_ms` (later clips and items move with it).
- **Order, timing, music or captions:** use `capcut-draft` operations on the latest snapshot, keeping the user's own edits.
- Keep `plan.json` and the shot ids in step with the draft.

## One MP4 instead of a draft

If the user wants a single file (or isn't signed in to CapCut): from `source/`, render the whole film from its root timeline, `motion.mjs hf render --output ../exports/film.mp4 --quality delivery`. Rendered shots can also be joined with ffmpeg's concat demuxer (`ffmpeg -f concat -safe 0 -i list.txt -c copy film.mp4`), since shots from one project share codec, size and frame rate. Add music only from a file the user supplies (CapCut library music can't be downloaded): `ffmpeg -i film.mp4 -i music.mp3 -map 0:v -map 1:a -c:v copy -af "afade=t=out:st=<end-2>:d=2" -shortest final.mp4`. Probe the result and watch it before handing it over.

## Errors

| Problem | What to do |
| --- | --- |
| `Motion videos need Node.js 22 or later` | Offer to update Node.js (Windows `winget upgrade OpenJS.NodeJS.LTS`, macOS `brew upgrade node`), then run setup again. |
| `ffmpeg is missing` | Install it (Windows `winget install Gyan.FFmpeg`, macOS `brew install ffmpeg`). |
| `HyperFrames isn't set up yet` | Run `motion.mjs setup` (ask first, it downloads). |
| `check` errors, blank or black frames | Read the message; check the composition id matches `window.__timelines`, the timeline is paused, assets are relative paths, and `motion.mjs hf docs troubleshooting`. |
| Render fails or stalls | Keep the shot and source. Try `--workers 1`, then report which shot and stage failed. Don't switch HyperFrames versions or render in the cloud. |
| Upload or draft errors | Follow `capcut-upload` and `capcut-draft`. Rendered shots stay in `exports/`, so nothing needs rendering again. |
