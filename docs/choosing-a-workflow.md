# Choosing a workflow: promptcut or local project mode

There are two ways to have Claude Code edit videos for CapCut:

1. **promptcut (cloud mode):** this plugin. Claude works through CapCut's hosted MCP server, under your CapCut account. Media is uploaded to CapCut, and edits are saved to cloud drafts in your CapCut account, which appear in every CapCut app signed in to that account: the web editor, the desktop apps and the mobile app.
2. **Local project mode:** no plugin and no CapCut account connection. Claude writes the CapCut desktop app's own project file on your computer, using local tools such as ffmpeg and a speech-to-text model, while CapCut is closed. You then open the project in CapCut.

Both have been used on real projects. This guide explains how each works, what they share, where they differ, and when to pick which.

## How each one works

### promptcut (cloud mode)

```
Claude Code ── promptcut skills ── CapCut MCP server (your account)
                     │                    ├── AI generation, templates, materials, captions, rough cuts
                     │                    └── cloud drafts ──> web, desktop and mobile apps
                     └── local scripts: upload, draft editor, subtitle export, downloads
```

1. Claude uploads your footage to CapCut (`capcut-upload`).
2. CapCut's services do the heavy lifting: AI rough cuts, speech recognition, image and video generation, template and material search.
3. Claude reads the cloud draft as an STDraft document, edits it locally (`scripts/stdraft.mjs`), and saves it back. CapCut validates every save and rejects broken drafts.
4. You review and export in the CapCut web editor or the desktop app.

### Local project mode

```
Claude Code ── ffmpeg / ffprobe ──> clip facts, contact sheets, silence, audio peaks
            ── speech-to-text (for example whisper.cpp) ──> word timings
            ── Python build script ──> CapCut desktop project file (draft_content.json)
                                         └── open in CapCut desktop ──> review and export
```

1. Claude inspects the raw footage on disk: durations, rotation, contact sheets of frames, loudness, and a word-level transcript of any speech.
2. It proposes an edit plan (shots, in and out points, text, effects) and waits for your approval.
3. It writes the project file directly, using structures copied from **your own existing CapCut projects**, so the format matches the CapCut version you have installed.
4. It checks that every reference resolves and nothing overlaps, renders a rough ffmpeg preview, and you open the project in CapCut to confirm.

CapCut stores desktop projects in its `Projects/com.lveditor.draft` folder: under `%LOCALAPPDATA%\CapCut\User Data` on Windows, and under `~/Movies/CapCut/User Data` on macOS by default. promptcut does not include tooling for this mode. It is a pattern you ask Claude Code to follow.

## What both can do

- Plan an edit from a plain-language request and ask before building it
- Cut raw footage into a sequence of shots on the main track
- Add text overlays and captions with chosen timing and position
- Add music and sound effects
- Trim, move and remove clips, text and audio
- Produce a project you finish and export in CapCut
- Re-run edits after feedback without starting from scratch

## Differences

| | promptcut (cloud mode) | Local project mode |
| --- | --- | --- |
| **Where edits land** | CapCut cloud draft (any CapCut app on your account) | CapCut desktop project on one computer |
| **Setup** | Install the plugin, sign in to CapCut once | CapCut desktop, ffmpeg, Python, optionally a speech-to-text model; at least one existing CapCut project to copy structures from |
| **CapCut account** | Required, and its region must match your connection | Not needed for editing |
| **Uploads** | Footage is uploaded to CapCut | Nothing leaves your computer |
| **CapCut open while editing?** | Yes, fine. Your own saves win and Claude re-applies its edit on the newer version. | **No.** CapCut must be closed, or it can overwrite Claude's changes with its own copy. |
| **AI features** | CapCut AI: rough cuts, image and video generation, auto captions, template and material search | None from CapCut. Analysis uses local tools and Claude's own judgment. |
| **Cost** | Some features spend CapCut credits (always quoted first, except rough cuts) | No CapCut credits |
| **Cut precision** | CapCut's AI rough cut, or clip-level edits by Claude | Frame and word-level cuts from transcripts and silence detection (repeats, false starts, long pauses) |
| **Effects and grading** | Text, captions, audio, clips and overlays, transitions, CapCut filters, video and face effects, text templates. No keyframes or color adjustment yet. | Anything the desktop format can express that Claude can learn from your existing projects: keyframes (for example a dolly zoom), per-clip color adjustments, multiple audio tracks |
| **Fonts and media** | CapCut library fonts and materials (`vimo://` IDs) | Fonts, sound effects and media already on your computer |
| **Validation** | CapCut validates every save and rejects invalid drafts | No validation until you open the project. A wrong value can load but look wrong. |
| **Preview** | Open the web editor link | Rough ffmpeg preview, then open CapCut |
| **Stability** | Uses CapCut's published MCP tools | Depends on an undocumented file format that can change with any CapCut update |
| **Platforms** | Any computer that runs Claude Code | The computer where CapCut desktop is installed |
| **Collaboration** | Cloud draft, available on any device signed in to the account | Local files on one machine |

## Pros and cons

### promptcut (cloud mode)

**Pros**
- CapCut's AI services: rough cuts, generation, speech recognition, templates, materials
- Safe saves: CapCut validates drafts, and version checks protect your own edits
- Works with CapCut open, and the result syncs to every CapCut app signed in to your account
- No dependence on CapCut's local file format
- Credit costs are shown before paid generation

**Cons**
- Needs a CapCut account, sign-in and uploads
- Editing covers text, captions, audio and main-track clips only for now
- Rough cuts and some features use credits
- Recognition limits apply (for example, short phrases in a second language can be missed)

### Local project mode

**Pros**
- Very fine control: word-level cuts, keyframes, per-clip color, sound effects aligned to the cut
- Uses your own fonts, sound effect library and media, with no uploads
- No CapCut account connection and no credits
- Claude can reuse your house style from earlier projects

**Cons**
- CapCut must be closed whenever Claude writes, and you must re-open it to see changes
- The format is undocumented and version-specific. A CapCut update can break the approach until Claude re-learns it from a newer project.
- No validation until you open the project, so values on the wrong scale can produce a bad result (for example, a heavy-handed first color grade)
- Higher risk of a corrupted project. Always keep a backup.
- No CapCut AI features
- Only works on the computer with CapCut desktop installed

## When to use which

| Situation | Best fit |
| --- | --- |
| You have rough footage and want a quick AI first cut | promptcut (AI rough cut) |
| You need images or short clips generated from an idea | promptcut (generation) |
| You want template ideas, trending music or CapCut fonts | promptcut (templates, materials) |
| Captions or subtitles for a talking video | promptcut (auto captions, SRT export) |
| You want to keep editing while Claude works, or on another device | promptcut (cloud drafts) |
| A polished, repeatable format such as listing tours or product walkthroughs, with precise cuts, keyframed moves, color grading and a sound effect library | Local project mode |
| Footage must not leave your computer | Local project mode |
| Removing repeats, false starts and long pauses word by word from a talking-head clip | Local project mode |
| You don't have, or don't want to connect, a CapCut account | Local project mode |

### Combining them

The two modes can share inputs and outputs:
- Use promptcut for the ideas and assets (templates, music choices, generated B-roll, captions as SRT files), then build the precise edit in local project mode.
- Use promptcut for an AI rough cut and captions, then finish effects and color by hand in the CapCut desktop app.

Moving one project between the two automatically (for example, editing a cloud draft's local copy) has not been tested. Treat cloud drafts and local projects as separate.

## Safety checklist for local project mode

- Close CapCut completely before Claude writes, and confirm it isn't running.
- Back up the project folder before every write.
- Have Claude copy structures from an existing project made with your current CapCut version, rather than writing the format from memory.
- Use absolute paths for media, and keep any duplicate copies of the project file inside the project folder in sync.
- Check value scales on one clip before applying settings to all clips. CapCut's panel scale may differ from the stored value.
- Open the project in CapCut and play it through before exporting.
- Keep the build script, so changes can be rebuilt quickly. Note that a full rebuild overwrites edits you made by hand in CapCut, so re-apply them or tell Claude to update the script first.

This mode edits files that belong to the CapCut desktop app. It is unofficial and not supported by CapCut. Use it at your own risk and follow CapCut's Terms of Service.
