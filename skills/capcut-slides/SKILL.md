---
name: capcut-slides
description: Make presentation slide decks as HTML files that open in any browser, present them with speaker notes, export them to PDF, PNG or PowerPoint (PPTX), and turn a deck into a CapCut video draft with music and captions. Use when the user asks for slides, a deck, a presentation, a pitch deck or a PPT, wants to edit or export one, or wants a slideshow video made from slides.
---

# Make slide decks and slideshow videos

Before running any `${CLAUDE_PLUGIN_ROOT}/scripts/` command, make sure the `capcut-connect` skill's setup check has passed in this conversation. A deck needs no CapCut account. Only AI images and the video step use CapCut.

`S` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/slides.mjs"`. Every command prints one JSON object.

## 1. Agree on the brief

For a new deck, settle these before writing anything, asking once and only about what the user hasn't said:

- **Slide count.** Covers and closing slides count.
- **Aspect ratio.** `16:9` (default) or `4:3`. These are the only two.
- **Language of the slide text.** Default: the language the user is writing in.
- **Purpose, audience and style.** Ask only when it would change the result, and let the user say "you decide".

Skip the questions for a complete brief, a small edit, or when the user says to just go ahead.

## 2. Content before design

1. Read every file, note and link the user gave. Keep a short list of the facts, numbers, dates and quotes you may use, with where each came from. Say which sources you could not open.
2. **Never invent facts, numbers, quotes, customer names or sources.** Without a source, write qualitative copy. Use sample figures only when the user asks for examples, and label them on the slide as examples.
3. Write the outline: one line per slide with its main message, in order. Show it to the user and continue, unless they asked to approve it first.
4. Pick a visual direction: two colors plus a neutral, at most two Google Fonts families, and a layout for each slide that fits its message (a big number, a comparison, a quote, a photo, a list). Vary layouts where the content differs. Don't decorate for its own sake.

If the sources can't fill the requested count, tighten the content first. If that still doesn't work, ask whether to make fewer slides or add sources. Never pad.

## 3. Write the deck

Create the file with the viewer built in:

`S new --out decks/<subject>/<subject>.html --title "<deck title>" --ratio 16:9 --lang <language tag>`

Use a short lowercase-hyphenated `<subject>`. Never overwrite another deck. For a second style, write `<subject>-<style>.html` beside it. Then replace the starter slide by editing the file. Rules:

- **Structure.** Every slide is `<section class="pc-slide <your-class>" data-notes="<speaker notes>">` placed directly inside `<div class="pc-deck" data-ratio="16:9">`. Nothing goes outside `pc-deck` in `<body>`. Write real speaker notes for every slide: what to say, not a copy of the slide.
- **Fixed canvas.** 16:9 slides are 1280 x 720 px and 4:3 slides are 1024 x 768 px. Size everything in px. Never use `vw`, `vh` or media queries. Never set width or height on `.pc-slide`.
- **Scoped CSS.** Start every selector with `.pc-slide` or your own class. Never style `body`, `html`, `section` or `*` directly, because those also hit the viewer's controls.
- **Static HTML and CSS only.** Don't add scripts, buttons or navigation. The built-in viewer provides paging, fullscreen, overview, presenter view and export. The Tailwind browser CDN (`https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4`) is allowed. Use inline SVG for icons.
- **Animation (optional).** Add `data-animate="fade-up"` to an element (also `fade`, `fade-down`, `fade-left`, `fade-right`, `zoom-in` or `blur-in`), plus `data-delay="150"` in ms for a stagger. Content must stay visible without animation, so never set `opacity: 0` or hide elements yourself. For your own effect, write `@keyframes` and a rule like `.pc-play .my-effect { animation: ... }`. The viewer adds `pc-play` when the slide appears.
- **Video timing (optional).** `data-seconds="6"` on a slide sets how long it shows in a slideshow video.
- **Long decks.** For more than about 12 slides, write 6 to 10 slides per edit. Insert each batch before the `<!-- next-slide -->` marker, and remove the marker after the last batch.

### Images

- **User's files.** Copy them into `decks/<subject>/assets/` and reference them as `./assets/<file>`. Never point at files elsewhere on disk.
- **AI images (optional, costs CapCut credits).** Use the `capcut-generate` skill, including its credit quote and the user's approval. Generate backgrounds and illustrations without any text in them, because the slide's HTML holds all text. Save the results into `assets/` with `download-media.mjs --out decks/<subject>/assets`. Leave a clear area where the text will go.
- Prefer a real photo, product image or diagram when the subject needs one. Typographic or data-only slides are fine without images.

## 4. Check before showing

1. `S check --file <deck> --render`. Fix every `errors` item. Treat each `render.problems` line as a pointer to look at: text past the slide edge or cut off is almost always a real bug, and overlapping text usually is. `loadTimedOut` or a font in `fonts.failed` means the fonts or images didn't load in time, often because the computer is offline.
3. `S export --file <deck> --format sheet` writes contact sheets with four slides per image to a temporary folder. Open each sheet in turn and look for broken layouts, unreadable text, weak hierarchy, empty-looking slides and images that don't fit. Open a single slide (`--format png`) only when a sheet leaves you unsure.
3. Check the facts against your source list, and check the slide count, ratio and language against the brief.

Fix what you find and check again. If a check can't run (for example, no browser was found), say that the deck is unchecked.

## 5. Deliver

Run `S open --file <deck>` to open the deck in the user's browser, then give its path. Tell the user once how to use it:

| Key | Action |
| --- | --- |
| Arrows, Space | Next or previous slide |
| F | Fullscreen |
| O | Overview of all slides |
| P | Presenter window with notes, next slide and timer (stays in sync with the main window) |

Export only when the user asks for a file:

| Want | Command | Notes |
| --- | --- | --- |
| PDF | `S export --file <deck> --format pdf` | One page per slide. Good for sending and printing. |
| PowerPoint | `S export --file <deck> --format pptx` | Each slide is a picture with speaker notes. Say clearly that the text can't be edited in PowerPoint. |
| Images | `S export --file <deck> --format png` | One PNG per slide at 2x. Add `--scale 1` for smaller files. |

Exports go next to the deck unless `--out` is given, and replace an earlier export with the same name. They need Chrome, Edge, Chromium or Brave. If none is found, tell the user to install Google Chrome or set `PROMPTCUT_BROWSER` to their browser's program file.

### Editing a delivered deck

Edit only what was asked, in the same file, keeping the user's own changes. Run step 4 again on the changed slides, then reload the browser tab. Use `S check --file <deck> --fix-runtime` only when `check` reports an old viewer runtime.

## 6. Turn a deck into a CapCut video (optional)

Only when the user asks for a video or slideshow. This makes a CapCut cloud draft with one still image per slide. The user then adds transitions and exports the video in CapCut. Saving a draft costs no credits.

Before the first CapCut account step in this conversation, check the sign-in with `capcut_get_profile` as the `capcut-connect` skill describes.

1. Ask how long each slide should show (default 4 seconds, or `data-seconds` per slide) and whether they want background music.
2. **Always ask about captions, every time you make a slideshow video**, as its own multiple-choice question, even if the notes look short or a previous video used captions. Skip it only when the user already chose in this same request. Offer exactly these options:
   - **Yes, shortened:** one short line per slide, written from that slide's speaker notes. Leave out text meant only for the presenter, such as reminders or asides.
   - **Yes, word for word:** each slide's full speaker notes as they are.
   - **No captions:** just the slides.
   Both caption options use a smaller size, placed a little above the bottom edge so they don't cover the slide. If the deck has no speaker notes, say so and offer only "No captions" or captions the user writes.
   For **shortened** captions, write the lines, show them to the user as a numbered list (one per slide, or "none"), and wait for their OK before building the draft. Save them as a JSON array with one entry per slide, a string or `null`, to `<tmp>/captions.json`.
3. `S export --file <deck> --format png --scale video --out <tmp>/video-slides` renders 1080-pixel-tall slides (1920 x 1080 for 16:9).
4. Upload every PNG in one batch with the `capcut-upload` skill. Save the upload script's JSON output to `<tmp>/uploads.json`.
5. If the user chose captions, pick a font as the `capcut-draft` skill describes. Then run:
   `S video-plan --file <deck> --uploads <tmp>/uploads.json --out <tmp>/ops.json [--seconds 4] [--notes-as-captions | --captions <tmp>/captions.json] [--font vimo://<id>]`
   Use `--notes-as-captions` for word for word and `--captions` for shortened. This writes `add_image` operations (and `add_captions`) for the draft. Its `width` and `height` give the draft size.
   For slides that didn't come from a promptcut deck (for example images or a PDF the user exported from another app), write the same operations by hand: one `add_image` per slide, then one `add_captions` with `position_y: -0.7` and `font_size: 10`.
6. For music, find a track with the `capcut-materials` skill and add an `add_audio` operation with `fade_out_ms: 1500` to the end of `ops.json`.
7. Follow the `capcut-draft` skill from "Get the starting document". Create the document with `node "${CLAUDE_PLUGIN_ROOT}/scripts/stdraft.mjs" new --width <width> --height <height>`, apply `ops.json`, call `start_stdraft_session`, then save with an empty `base_package_id`.
8. Give the user the web editor link. Tell them to add transitions there if they want them and export the video from the editor, and give them the draft name and copy notes from the `capcut-draft` skill's "After a successful save" step.

If the save fails with `STDRAFT_INVALID` on the image clips, report the validation details to the user. Don't fall back to other tools.

## Limits

- PPTX slides are pictures, not editable PowerPoint text. For editable slides, the user can edit the HTML deck with you.
- Decks use web fonts from Google Fonts, so presenting offline falls back to system fonts unless the fonts are installed.
- There is no point-and-click editor. Changes are made by asking Claude.
