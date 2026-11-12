---
name: capcut-materials
description: Find CapCut music, sound effects, fonts, text effects, text templates, video effects, face effects, transitions and filters. Use when the user wants background music, a sound effect, a font or a visual effect from CapCut's library, either to browse or to add to a draft.
---

# Search CapCut materials

Call `search_capcut_material` with:

- `type` (required): one of `music`, `sound_effect`, `font`, `text_effect`, `text_template`, `video_effect`, `face_effect`, `transition`, `filter`
- `prompt` (required): a short description of what the user wants, such as "upbeat lo-fi for a product demo"
- `top_n`: 1 to 20, default 5

## How the search behaves

Only some types search by `prompt`:

| Searches by prompt | Returns a fixed curated list |
| --- | --- |
| `music`, `sound_effect` and `video_effect`, in every region | `font`, `text_effect`, `text_template`, `face_effect`, `transition` and `filter` |

For curated types, the prompt does not change the results. Tell the user plainly that CapCut returned its curated list rather than results matched to their request.

Music used to be curated for US accounts, and CapCut now searches it by prompt in every region. Treat music results as matched to the request. Only if they clearly ignore it (unrelated titles, one artist, no descriptions) say that CapCut seems to have returned a general list, and offer a different wording.

## Present results

Show a numbered list with each item's title, the description CapCut returned, duration for audio, and a preview link when one is returned. Keep each item's `resource_id` and any `stdraft_uri` in the conversation for later use. Music results may come with only a title, an author and a duration, and no description; if so, say that you chose by title and offer the preview links so the user can listen first. Pass the `stdraft_uri` on unchanged: music and sound effects usually come as `sid://...`, fonts and visual materials as `vimo://...`.

Describe only what the result says. Never guess a track's mood, tempo or sound from its title, and never rank items by how well they fit when the results carry no descriptive information. If you can't tell which items fit, say so and suggest the user listen to them in CapCut.

Do not invent materials. If nothing fits, say so and suggest a different description.

## Adding materials to a video

Every type can be added to a draft with the `capcut-draft` skill, using each item's `stdraft_uri` unchanged:

| Type | Draft operation |
| --- | --- |
| `music`, `sound_effect` | `add_audio` (`kind` `music` or `sound`) |
| `font` | `font` on text and captions |
| `text_effect` | `text_effect` on text and captions |
| `text_template` | `add_text_template` |
| `transition` | `add_transition` |
| `filter` | `add_filter` |
| `video_effect`, `face_effect` | `add_effect` (a face effect is an ordinary video effect in a draft) |

These were added in promptcut 0.4.0 and haven't all been checked in a real draft yet.
