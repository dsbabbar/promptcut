---
name: capcut-connect
description: Connect Claude Code to a CapCut account, check that Node.js and ffmpeg are installed, and fix CapCut connection problems. Use when CapCut tools are missing, return an authentication error, the user asks how to log in or out of CapCut or how to set promptcut up, the CapCut login page shows an error, or a promptcut script cannot run because node or ffmpeg is missing.
---

# Connect to CapCut

promptcut uses two MCP servers hosted by CapCut:

| Server | Purpose | Login |
| --- | --- | --- |
| `capcut` | Account tools: search, generation, captions, rough cuts, uploads, drafts | OAuth with the user's CapCut account |
| `capcut-cards` | Display helpers such as template galleries | None |

Tools appear in Claude Code as `mcp__plugin_promptcut_capcut__<tool>` and `mcp__plugin_promptcut_capcut-cards__<tool>`. Match tools by the part after the last `__` so the workflow also works when a user added the servers by hand (for example `mcp__capcut__<tool>`).

## Setup check

promptcut's helper scripts need **Node.js 20 or later**. Uploads, draft editing, subtitle files and saving results all use it; searches and generation do not. **ffmpeg** (which includes ffprobe) is optional: it is used to detect portrait phone videos and to recover missed captions in mixed-language videos.

promptcut's plugin hook checks for both when a session starts and adds a note to the conversation only when something is missing. Otherwise, run this check once per conversation, the first time a workflow needs a script or ffmpeg, or when the user asks to set promptcut up:

1. Run `node --version`. It must print `v20` or higher.
2. Only when ffmpeg would help the current request, run `ffprobe -version`.

If something is missing or too old, tell the user what it is needed for and offer two choices: you install it for them, or you show them the steps. Wait for their answer.

| System | Node.js | ffmpeg |
| --- | --- | --- |
| Windows | `winget install OpenJS.NodeJS.LTS` | `winget install Gyan.FFmpeg` |
| macOS (Homebrew) | `brew install node` | `brew install ffmpeg` |
| Linux | The current LTS from https://nodejs.org or your distribution's `nodejs` package, if it is version 20 or later | `sudo apt install ffmpeg` or your distribution's equivalent |

- **If the user wants you to install it:** run the command for their system (Claude Code asks them to approve it). If the package manager itself is missing (for example Homebrew on a Mac), say so and link its install page instead of installing it yourself. After installing, tell them to restart Claude Code so the new program is found, then check the version again in the new session.
- **If the user wants the steps:** give the command for their system, explain where to run it (a new terminal window) and that they need to restart Claude Code afterwards.
- **If the user declines:** for Node.js, explain which features won't work. For ffmpeg, continue without the steps that need it, and mention they can set the environment variable `PROMPTCUT_SKIP_FFMPEG_CHECK=1` to stop the reminder.

Never install software without the user's agreement.

## Check the connection

CapCut's server lists its tools even when the user is signed out, and some tools (such as material search) answer without an account, so a visible tool or a search result does not prove the user is signed in. Never use a generation, upload or draft tool to test a connection.

To check the sign-in, call `capcut_get_profile` with empty arguments. It is free, changes nothing, and returns the signed-in account's nickname.

- **It returns a nickname:** the user is signed in. Mention the nickname when it helps, for example when the user asks which account is connected or just switched accounts.
- **It returns a login error or asks for authorization:** the user is signed out or the sign-in expired. Go to [Log in](#log-in).
- **It fails for another reason, or the tool isn't available:** don't treat that as signed out and don't ask the user to sign in again. Treat the first account call of the workflow as the check instead.

Run this check when the user asks to sign in, to check the connection or which account is connected, and before the first account step of a workflow that spends credits or takes a while (generation, AI rough cuts, uploads, captions, drafts). Once per conversation is enough unless a later call returns a login error.

## Stop at the first login error

CapCut sign-ins expire, often overnight. A tool result is a login error when it says the user is not logged in, a token is invalid or expired, a CapCut tool call is unauthorized (HTTP 401), or it contains text such as `check login error` or `get user workspace failed`.

A 401 or 403 from the upload storage step inside `scripts/capcut-upload.mjs` is not a login error: it means the short-lived upload ticket or storage key expired. Follow the `capcut-upload` skill and request a new ticket instead. Never ask the user to sign in again because of an upload storage error.

On the first login error:

1. Stop calling CapCut tools. Do not retry the call, try other CapCut tools or switch to another workflow to get around it.
2. Tell the user in one or two sentences that their CapCut sign-in has expired, and give them the [Log in](#log-in) steps for the app they are using. If you don't know which app, give both.
3. Wait for the user to say they have reconnected. In the desktop app, they may need to start a new session.
4. Then retry the step that failed once, and continue the original request. If it fails with a login error again, say so and stop.

## Log in

Claude cannot complete the login itself. Tell the user to:

- **Claude desktop app:** type `/mcp` (it opens **Settings → Connectors**), search for **promptcut**, open its **Connectors** tab, click **capcut** and connect it. Approve opening www.capcut.com, sign in in the browser, then click **Done**. Also add **capcut-cards**, which needs no sign-in. Then start a new session.
- **Terminal:** run `/mcp`, select **capcut** (it may show as `plugin:promptcut:capcut`) and choose **Authenticate**. Sign in to CapCut in the browser window that opens, then return to Claude Code.

## Switch to a different CapCut account

The sign-in page uses whichever CapCut account the browser is signed in to, so sign out there first. Tell the user to:

1. Open www.capcut.com in their browser, sign out, and sign in with the account they want.
2. Disconnect promptcut from the current account:
   - **Claude desktop app:** type `/mcp`, search for **promptcut**, open its **Connectors** tab, click **capcut** and disconnect it.
   - **Terminal:** run `/mcp`, select **capcut** and choose **Clear authentication**.
3. Connect again with the [Log in](#log-in) steps, then start a new session.

Uploads, drafts and generated media belong to the account they were made with. After switching, earlier `vid`s, `uri`s and draft sessions from this conversation won't work: say so, and start from the new account.

The login only works when Claude Code runs on the user's own computer. CapCut accepts local callback addresses only, so cloud sessions and the claude.ai website cannot finish it.

## Fix common problems

| Symptom | Cause and fix |
| --- | --- |
| `unknown client` or `invalid_request` on the login page | Region mismatch. A US internet connection needs a US-registered CapCut account and a non-US connection needs a non-US account. Sign out at capcut.com, sign in with a matching account, then authenticate again. |
| Browser shows "connection refused" on a `localhost` page | The login wait expired or a firewall blocked the local callback. Run **Authenticate** again and allow the local connection if the firewall asks. |
| HTTP 502 or Bad Gateway with no tool result | CapCut's service is temporarily down. Wait and retry later. Do not log out. |
| Each CapCut tool is listed twice | The servers were also added by hand. Remove the manual copies with `claude mcp remove capcut` and `claude mcp remove capcut-cards`. |
| A CapCut tool says `check login error`, `get user workspace failed`, not logged in or unauthorized | The CapCut sign-in has expired. Follow [Stop at the first login error](#stop-at-the-first-login-error). |
| Tools still missing after login | Start a new session. In a terminal, you can also run `/mcp` and choose **Reconnect** for capcut. |

## Safety

- Never ask the user to paste passwords, cookies, tokens or authorization codes into the chat.
- Never read, print or edit stored OAuth credentials.
- After a successful login, return to the user's original request.
