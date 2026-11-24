---
name: capcut-rough-cut
description: Create an AI rough cut with CapCut from video clips and images, such as cutting footage to a target length, assembling a highlight reel or restructuring a video's story. Use only when the user wants footage cut, assembled or restructured, not for adding captions or music to an unchanged video.
---

# AI rough cut with CapCut

Before the first CapCut account step in this conversation, check the sign-in with `capcut_get_profile` as the `capcut-connect` skill describes.

CapCut's editing agent builds a first cut from uploaded clips and images, sometimes asking for decisions along the way.

## Inputs

- **Media:** each clip or image must be uploaded with the `capcut-upload` skill first. Videos use their `vid` and images their ImageX `uri` as `resource_id`. Each needs a unique `file_name` with its extension. Supported formats: videos avi, flv, m4v, mkv, mov, mp4, webm; images jpg, jpeg, png, webp.
- **Instructions:** what to make, including target length, platform, style, story and pacing, in the user's words.

## Workflow

1. Call `capcut_ailab_start_edit` with `assets` (in the user's order) and `query`. Keep the returned editing `session_id`.
2. Call `capcut_ailab_poll_edit_progress` with `session_id` and `after_event_id: "0"`. After each response, use its `next_event_id` for the next poll. Poll until the task finishes or needs input, and pass on progress messages briefly.
3. **When the task asks for a decision** (an editing plan or a question):
   - Wait until that turn of the task has finished (`loop_turn_completed`), so you have the whole plan. Show the user CapCut's plan text exactly as written, in order, with the available options. Don't rewrite it as your own summary or a table.
   - Wait for their answer. Don't submit anything until the user actually replies.
   - Submit with `capcut_ailab_submit_plan_response`: `session_id`, `card_id` and `after_event_id` from the plan's `editing_plan_response` when the event has one, otherwise from the plan card's `context`. Pass the user's exact words (or the option they chose) as `response_text`. If the card carries a `state_capability`, pass it unchanged wherever the tool's fields accept it.
   - **Refresh first** when the plan is marked `requires_refresh: true`, has no `state_capability`, or the conversation was interrupted since it was shown: poll the same task again from `after_event_id: "0"`, find that same pending plan, and use the `next_event_id` from that poll as `after_event_id`. Never make up a cursor from the card's own event ID. If the plan is no longer pending, or a newer one replaced it, show the current plan and ask again. Never send the old answer to a different plan.
   - If the tool says the response was already submitted, or fails a state check, report it. Don't work around it. Then resume polling with the returned session and cursor.
4. **When a video is ready,** show the user its preview link, duration and any editor link. If the user asked for background music, check that the cut has it (the event or the draft has an audio track). If it doesn't, say so and add it afterwards with `capcut-draft`. Optionally call `video_preview` (match it by name: CapCut now serves it from `capcut`, and older setups from `capcut-cards`) with the event's `context` and `resources` unchanged to get the finished draft. Keep the editing `session_id`, the event ID and the draft for follow-up work.

Never submit the same plan response twice. If unsure whether a response went through, poll first.

Claude Code cannot display CapCut's interactive cards. If a tool result says to wait for the user to click a card or button, ignore that instruction: ask the question in the chat and submit the answer yourself. Never tell the user to click a card.

## Follow-up

- To restructure the story, start a new rough cut. It does not pick up later manual or caption edits.
- To add captions, music, text, transitions, filters or effects to the result, or to move, trim or remove clips, follow the `capcut-draft` skill, starting from this rough cut's `video_preview` draft.
- An editing `session_id` from this skill is not a draft `session_id`. Do not mix them up.
- If a CapCut call fails with a login error (for example `check login error`), stop and follow the `capcut-connect` skill. Do not retry or try other tools first.
