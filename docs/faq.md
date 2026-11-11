# Frequently asked questions

## About promptcut

### Is promptcut an official CapCut product?

No. promptcut is an independent, community-built plugin. It is not affiliated with, endorsed by or supported by CapCut or ByteDance. CapCut is a trademark of its owner and is named only to describe what promptcut connects to.

### How is it different from the official CapCut x Codex plugin?

Both connect an AI assistant to CapCut's hosted MCP server, so the CapCut features underneath are the same. The differences:

- promptcut runs in **Claude Code**. The official plugin runs in OpenAI Codex.
- All of promptcut's skills and scripts are original. None of the official plugin's files are used.
- CapCut's interactive cards don't display in Claude Code, so promptcut asks questions and shows results in the chat instead, including credit quotes.

### Is promptcut a plugin, a skill or an MCP server?

A **plugin**. It bundles 9 skills, 5 helper scripts, a setup hook and the addresses of CapCut's MCP servers. The MCP servers belong to CapCut and run on CapCut's servers; promptcut doesn't include its own. See [What's inside promptcut](whats-inside.md).

### Was promptcut called claudecut?

Yes. It was renamed so its name doesn't use another company's brand. If you installed `claudecut`, remove it (in the desktop app's **Settings → Plugins**, or with `claude plugin uninstall claudecut@claudecut` in a terminal), then install promptcut as in [How do I install it?](#how-do-i-install-it), and sign in to CapCut again with `/mcp`.

### Is it free?

The plugin is free and open source under the MIT license. You need:

- Claude Code, which requires a Claude plan
- a CapCut account

Some CapCut features spend CapCut credits or need a CapCut subscription (see [Credits and cost](#credits-and-cost)).

### Does promptcut see my password or collect data?

No. You sign in on CapCut's own login page, and Claude Code stores the login token on your computer. promptcut has no server and collects nothing. Your prompts and media go to CapCut under CapCut's [Privacy Policy](https://www.capcut.com/clause/privacy).

## Setup

### Which computers does it work on?

| Platform | Status |
| --- | --- |
| Windows | Tested end to end with a real CapCut account |
| macOS | Tested end to end with a real CapCut account (Claude desktop app) |
| Linux | Automated tests pass; not yet tested end to end |

You need Claude Code 2.1.292 or later and Node.js 20 or later. ffmpeg is optional: promptcut uses it to detect portrait phone videos and for captions on mixed-language videos.

### Does installing the plugin install everything?

Installing the plugin sets up all skills, the CapCut server connection and the helper scripts, which have no npm dependencies. It can't install system software, and Claude Code has no install-time hook, so Node.js and the optional ffmpeg are installed separately. When a chat starts, promptcut checks for them. If something is missing, Claude tells you and offers to install it for you (you approve the command) or to show you the steps. Restart Claude Code after installing. You can also ask "Check my promptcut setup" at any time, and set `PROMPTCUT_SKIP_FFMPEG_CHECK=1` to stop reminders about the optional ffmpeg.

### How do I install it?

If you have Claude Code for the terminal, the quickest way is to ask Claude. In a local Claude Code session, paste: `Install the promptcut plugin by running: claude plugin install promptcut --marketplace dsbabbar/promptcut`. Approve the command, start a new session, and sign in to CapCut as described below. With only the Claude desktop app, the `claude` command doesn't exist, so use the desktop app steps below.

Or install it yourself, from either app:

- **Claude desktop app:** type `/plugin` in a Code session (or open **Settings → Plugins**), click **+ Add → Add marketplace → Add from a repository**, enter `dsbabbar/promptcut` and click **Sync**. Then on **Discover**, open the arrow next to **Add** on **Promptcut** and choose **Install for me**.
- **Terminal:** run `claude plugin install promptcut --marketplace dsbabbar/promptcut`. Inside a terminal session, type `/plugin install promptcut --marketplace dsbabbar/promptcut` and choose **Install for you (user scope)**.

Then sign in to CapCut once. In the desktop app, type `/mcp`, search for **promptcut**, open its **Connectors** tab, and connect **capcut** (sign in in the browser, then click **Done**) and **capcut-cards**. In a terminal session, type `/mcp`, select **capcut** and choose **Authenticate**. Both apps share the install, so promptcut is available in every new local session, in the terminal and in the desktop app's **Code** tab with **Local → This computer**.

### Can I use it on claude.ai or in a cloud session?

No. CapCut's login only accepts a callback address on your own computer, so it has to run in Claude Code on your machine: in a terminal, or in the Claude desktop app's **Code** tab with the environment set to **Local → This computer**. Cloud environments, Chat and Cowork don't work.

### Can I use it from my phone?

Yes, by remote-controlling Claude Code on your computer. In the Claude desktop app or a terminal session, type `/rc`, then open that session from the Claude mobile app under **Code**. The computer must stay on, and your media must be on the computer. See [Use it from your phone](../README.md#use-it-from-your-phone).

### How do I update or remove it?

Updates don't arrive on their own, because auto-update is off for marketplaces you add yourself. Refresh the marketplace first, then update the plugin:

- **Terminal:** run `claude plugin marketplace update promptcut`, then `claude plugin update promptcut@promptcut`.
- **Desktop app:** go to **Settings → Plugins → + Add → Manage marketplaces**, open the **⋯** menu next to **promptcut** and choose **Check for updates**. Then open **Promptcut** and click **Update**. If **Update** is greyed out, the marketplace hasn't been checked for updates yet.

If the update warns that `.in_use` files will be overwritten, that's safe: they only mark open sessions, not your changes. Start a new session afterwards to use the new version.

To remove promptcut, run `claude plugin uninstall promptcut@promptcut`, or use the **⋯** menu next to promptcut in **Settings → Plugins**.

## Signing in

### The CapCut login page says "unknown client" or "invalid_request"

This usually means a region mismatch. A US internet connection needs a US-registered CapCut account, and a non-US connection needs a non-US account. Sign out at capcut.com, sign in with a matching account, then run **Authenticate** again.

### How do I switch to a different CapCut account?

The sign-in uses whichever CapCut account your browser is signed in to, so:

1. Go to www.capcut.com in your browser, sign out, and sign in with the other account.
2. Disconnect promptcut:
   - **Desktop app:** type `/mcp`, search for **promptcut**, open its **Connectors** tab, click **capcut** and disconnect it.
   - **Terminal:** type `/mcp`, select **capcut** and choose **Clear authentication**.
3. Connect again as in [How do I install it?](#how-do-i-install-it), then start a new session.

Uploads and drafts belong to the account they were made with, so files uploaded with the old account need to be uploaded again.

### The browser shows "connection refused" on a localhost page after signing in

The login wait expired or a firewall blocked the local callback. Run **Authenticate** again, and allow the local connection if your firewall asks.

### Claude says "check login error" or that my CapCut sign-in expired

CapCut sign-ins expire, often overnight. promptcut stops at the first login error and asks you to reconnect, rather than trying other tools. Reconnect, then tell Claude you're done:

- **Desktop app:** type `/mcp`, search for **promptcut**, open its **Connectors** tab and connect **capcut** again. Then start a new session.
- **Terminal:** type `/mcp`, select **capcut** and choose **Authenticate**.

promptcut checks your sign-in with CapCut before longer jobs (generation, rough cuts, uploads, captions and drafts), so an expired sign-in shows up before any work starts. You can also ask "Am I signed in to CapCut?" at any time: Claude tells you which account is connected.

### Every CapCut tool appears twice

You also added CapCut's servers by hand. Remove the manual copies with `claude mcp remove capcut` and `claude mcp remove capcut-cards`.

### Why does Claude Code ask permission before uploading?

Uploading uses CapCut's `capcut_asset_upload_credential` tool, which issues short-lived upload keys, so Claude Code checks with you first. Approve it when asked, or allow it permanently with `/permissions`. promptcut keeps the keys inside its upload script and never prints them.

## Credits and cost

### Which features cost CapCut credits?

| Free | Can cost credits |
| --- | --- |
| Template search, material search, uploads, saving files, draft editing, subtitle export | Image and video generation, AI rough cuts, and possibly captions depending on your plan |

### Will promptcut spend credits without asking?

Not for image or video generation. promptcut shows CapCut's exact quote and waits for your yes, and it never resubmits a request, so you aren't charged twice. If a generation fails, CapCut normally refunds it. **AI rough cuts are the exception:** CapCut doesn't provide a quote before they start.

### Why do generated images have an "AI" label?

CapCut adds an "AI" watermark to some generated media. promptcut does not remove it.

## Editing

### Where do my edits go?

To a CapCut **cloud draft** in your account. You get a link to the CapCut web editor, and the draft also appears in every CapCut app where you are signed in with the same account: the desktop apps on Windows and Mac, and the mobile app. It appears as "Untitled", because CapCut's draft tools can't set a name. Rename it in any CapCut app; the new name syncs everywhere. Saving a draft doesn't export a video, so export from CapCut when you're happy with it.

### Can I edit in CapCut while Claude is editing?

Yes. Your own edits always win. If you save in any CapCut app (web, desktop or mobile) while Claude is working, Claude's save is rejected, and it re-applies its change on top of your newer version. Having the draft open in the desktop app can save new versions on its own, which is normal.

### What can promptcut change in a draft?

Text, captions, music, sound effects and main-track video clips, including volume, fades, moving, trimming and removing. Filters, transitions, video effects, text templates, stickers and picture-in-picture aren't supported yet. Add those in the CapCut editor.

### Why does my text wrap differently in the web editor and the desktop app?

Each app substitutes its own default font when text has none, and the fonts have different widths. promptcut sets a CapCut library font on text it adds so both apps match. If the desktop app has saved a local font into the draft, ask Claude to set a library font again.

### Why does an emoji look grey or plain?

CapCut's editor sometimes renders emoji as monochrome symbols. The character itself is saved correctly.

### Can I continue a draft in a new chat?

Each chat starts fresh and doesn't remember earlier uploads or drafts. Give full file paths, or describe the draft you want to work on.

## Captions

### Captions missed part of my video. Why?

CapCut transcribes mainly one language per pass. In mixed-language videos it can skip the second language, especially short phrases. promptcut tries each language and, when ffmpeg is available, re-checks the untranscribed parts on their own. If speech still has no captions, promptcut tells you which time ranges are missing. It never fills gaps with its own translation unless you ask for one, and it labels any translation as such.

### Can I get subtitle files?

Yes. Ask for SRT or WebVTT, and promptcut saves one file per language, plus a combined file for mixed-language videos.

## Media

### Which files can I upload?

Videos and audio up to 1 GiB, and images up to 20 MiB, in common formats (mp4, mov, mkv, webm, mp3, wav, m4a, jpg, png, webp, heic and more). Give Claude the full path. It asks rather than searching your drives.

### My phone video comes out sideways or the wrong shape

Phone videos are often stored landscape with a rotation flag. promptcut checks the flag with ffmpeg when it's installed. If the shape still looks wrong, tell Claude the video is portrait.

### Where are my generated files?

Result links from CapCut are temporary. Ask Claude to save results, and they're downloaded to a `capcut-output` folder in your current directory.

## Choosing an approach

### Should I use promptcut or let Claude edit CapCut's local project files?

promptcut is best for CapCut's AI features, safe cloud drafts and working from any device. Editing local project files gives finer control (word-level cuts, keyframes, color, your own sound effect library) but needs CapCut closed while Claude writes and depends on an undocumented format. See [Choosing a workflow](choosing-a-workflow.md).

## Help

### Something isn't working. Where do I report it?

Open an issue at [github.com/dsbabbar/promptcut/issues](https://github.com/dsbabbar/promptcut/issues). Include what you asked, what Claude printed and the error text. Never include passwords, tokens, cookies or upload tickets.
