# Known issues

These are problems on CapCut's side that promptcut can't fix, with what to do about each. They were found while using promptcut with a real CapCut account. For what promptcut itself doesn't support yet, see [Known limitations](../README.md#known-limitations).

If you find a new one, [open an issue](https://github.com/dsbabbar/promptcut/issues) with what you did, what you saw and any error text.

## Drafts

### Every save resets the draft's name

**What happens:** each time Claude saves a draft, CapCut resets its name. The CapCut desktop app shows "Untitled", and the web editor shows the date and time of that save, such as `202611111913`. If you rename the draft, Claude's next save resets it again.

**Why:** CapCut's draft tools don't accept a name, so promptcut can't set one or keep yours.

**What to do:** rename the draft only after Claude's last change.

### Opening a draft only in the desktop app can create copies

**What happens:** a draft opened only in the CapCut desktop app gets a numbered name, the lowest number free, such as "(4)". When you close it there, the desktop app can save a separate copy with that name, or with the name you gave it. Those copies don't receive Claude's later changes. The real draft is unaffected.

**What to do:**
- Open a new draft with the web editor link Claude gives you before opening it in the desktop app. Opened on the web first, it keeps one name and no copy is made.
- Before deleting a numbered copy, check that the real draft (the one the web link opens) has everything.

### Captions end up on two tracks

**What happens:** promptcut puts all captions on one layer, but CapCut usually shows the first caption on a track of its own and the rest together on a second track.

**Why:** CapCut's conversion seems to split off the first caption on a layer. promptcut already puts captions back on one layer before every save, which keeps it to two tracks rather than one track per caption.

**What to do:** in the editor, drag the first caption onto the shared track if you want one track.

### Animation over time is dropped

**What happens:** a slow zoom on a photo, a fade-in on a title, or anything else that changes over time disappears when Claude saves the draft. The save succeeds, but the animation is gone.

**Why:** these use keyframes, and CapCut's cloud drafts currently drop every keyframe on save.

**What to do:** add zooms, fades and other movement in the CapCut editor, using the Animation panel or keyframes. promptcut lowers music under speech without keyframes, so that still works.

### Text boxes don't show

**What happens:** a background box behind text, such as a dark box behind a title, is saved but CapCut doesn't draw it.

**What to do:** add the box in the CapCut editor (Text → Background), or use an outline and shadow instead, which do show.

### Text styling can fade after later saves

**What happens:** a title's outline and shadow get thinner after Claude saves the draft a few more times, and a text effect (word art) can disappear. Seen in a real test of 0.4.0.

**Why:** CapCut keeps per-letter style copies for text, treats them as the truth, and drops the outline, shadow and text effect from them over repeated saves.

**What to do:** nothing in most cases. Since 0.4.1, promptcut fills those values back in from the text before every save. If a style still fades, ask Claude to restyle the text, or fix it in the editor after Claude's last change.

### Word timings don't show in the editor

**What happens:** promptcut saves word-by-word timings with captions, but CapCut's editor doesn't show them.

**What to do:** nothing. The captions themselves are correct.

### Each text gets its own track

**What happens:** CapCut puts every title or label on a track of its own, even when promptcut puts them on one layer.

**What to do:** nothing. It's how CapCut lays out text.

### Text templates can lose their text

**What happens:** after several more saves, a text template can show "Text is no longer available", or its text can change to a plain serif font instead of the template's look.

**What to do:** add text templates in the last edit round, or re-add the template (ask Claude to remove it and add it again).

### Sound effects are relabelled as music

**What happens:** after a later save, a sound effect may be labelled as music in CapCut. It still plays the same.

### Blend modes other than Screen

**What happens:** promptcut can set the Screen blend mode, but not others by name.

**Why:** CapCut stores blend modes as library resources, and only Screen's is known.

**What to do:** set the mode once on any clip in the CapCut editor (Overlay, Darken or Brighten). Claude can then copy it to other clips.

### Background removal shows only in the desktop app

**What happens:** a clip with its background removed (cutout) looks unchanged in the CapCut web editor's preview.

**What to do:** check it in the CapCut desktop app, where it shows. Automatic background removal is a CapCut Pro feature.

### The desktop app asks to download or link media

**What happens:** opening a promptcut draft in the CapCut desktop app can ask "Download the latest version before editing?", and then ask you to link a missing media file that isn't one of yours (often a generated cutout). Closing the draft can save a separate local copy.

**What to do:** choose to download and edit. Cancel the link prompt; everything still opens. Delete the local copy only after checking that the cloud draft (the one the web link opens) has everything.

### Drafts with Pro features may not open on the phone

**What happens:** a draft that uses Pro features, such as bubbles or automatic background removal, may fail to download in the CapCut phone app, with no error.

**What to do:** open it on the web or in the desktop app, or check that your CapCut Pro membership is active.

### A deleted draft can't be saved to

**What happens:** if you delete a draft in CapCut while Claude is still working on it, the next save fails with `save cloud draft failed` and `ret=2005`.

**What to do:** nothing. Claude starts a new draft and saves your changes there.

### Emoji look plain

**What happens:** emoji in draft text may show as plain, grey symbols in CapCut's editor. The character itself is saved correctly.

## Media

### Uploaded files land loose in Media

**What happens:** files promptcut uploads appear loose in CapCut's Media panel. There's no way to put them in a folder.

## Signing in

### Sign-ins expire, often overnight

**What happens:** CapCut tools fail with `check login error` or `get user workspace failed`.

**What to do:** reconnect CapCut. In the desktop app, type `/mcp`, search for **promptcut**, open its **Connectors** tab and connect **capcut**. In a terminal, use `/mcp`, then **capcut**, then **Authenticate**. Then start a new session. An open session keeps using the expired sign-in. promptcut checks your sign-in before longer jobs, so this shows up before any work starts.
