# News

What changed in each version of Corral, newest first. The version is the one
in `package.json`.

## Development version

- **New repos get a space in one click.** A new **New in ~/repos** section
  in the sidebar lists git repos made in the last 14 days that herdr has
  never had a space for. **Add to herdr** makes the space, which then
  arrives in Uncategorized marked new; **×** hides a folder from the section
  for good. Set `CORRAL_REPOS` to watch a folder other than `~/repos`.

- **New herdr spaces show up by themselves.** The Mac page checks herdr every
  10 seconds while it is showing (and on ↻). A space made since the page
  loaded that lands in Uncategorized while you have groups is announced,
  with a note to drag it onto a group, and marked **new** until it is filed.
  A check that finds nothing added, closed, or renamed only updates the
  status dots, so open file trees are not reloaded.

- **Drop a screenshot on a window** on the Mac page to give it to Claude Code,
  as you would in Positron or Terminal.app. The browser never sees a dropped
  file's path, so the image is uploaded to Corral's data folder (where the
  phone's photos go) and that path is pasted into the window, which Claude
  Code attaches as `[Image #n]`. PNG, JPEG, HEIC, WebP, and GIF files are
  taken; other files are skipped with a note. A file dropped outside every
  window no longer replaces Corral with the file.

- The phone's **Chat** view shows Claude Code's status lines in full. Claude
  Code cuts each status line at the terminal's width, and the phone had sized
  the terminal to its own screen (about 50 columns), so long lines ended in
  `…`. While Chat is showing, the terminal is now kept at least 100 columns
  wide and the phone wraps the lines; **Terminal** still fits the phone.

## 0.4.0 (October 7, 2026)

### Chat or Terminal on the phone

- A window running Claude Code now opens on its **conversation**: your prompts
  and Claude's replies as chat bubbles, read from Claude Code's transcript
  without the tool calls in between, with a time over each of your prompts.
  It refreshes every 3 seconds, follows new messages while you are at the
  bottom, and stays put while you scroll back.
- Claude Code's **status lines** (whatever it draws under its input box, such
  as a status line command's output and the mode) sit under the conversation.
- **Terminal** switches to the full terminal and **Chat** switches back. The
  phone remembers the choice. The terminal stays connected under the
  conversation, so the keys, the message box, and the photo button work in
  both views. A plain shell opens in the terminal.
- The prompts include ones typed on the Mac, slash commands (shown as
  `/model opus`), photos, and messages sent while Claude was working.
- **Changes** and **Scrollback as text** moved into a ⋯ menu in the window's
  header, which leaves room for the window's name.

### Tests

- `npm test` runs 637 Node tests and 14 pytest tests and fails below 100%
  line, branch, and function coverage of `server.js`, `public/*.js`, and the
  scripts in `scripts/`, or when a file in scope is not loaded by any test.
  `npm run coverage:gaps` lists any gap with its source line.
- The server runs against a throwaway home folder with tmux, `ps`, herdr, and
  the macOS helpers replaced by fakes; the pages run in jsdom.
- The pages' scripts moved, unchanged, out of the HTML into `public/app.js`
  (the Mac) and `public/m.js` (the phone), and `server.js` starts nothing when
  a test loads it.

### Fixes

- On the phone, tapping a notification while Changes or the scrollback was
  open left that view on top of the window it opened.
- On the Mac, a window that took more than about 3 seconds to start could end
  up in the bottom bar while holding the keyboard. It now comes out of the
  bottom bar.
- `scripts/herdr-sort-spaces` runs only when executed, not when imported.

## 0.3.0 (October 7, 2026)

Remote control from the phone, for Claude Code in particular.

- **Allow and Deny.** A window stopped at a Claude Code permission prompt goes
  to the top of the phone list, marked Needs permission, with what Claude
  wants to run and a button for each answer. Each answer names the prompt it
  is for, so it never lands on a newer one.
- **Notifications.** Web Push from the Mac when a permission prompt opens or a
  turn ends, even with Corral closed, by default only while the Mac is idle.
  Each window can be muted. Android and desktop browsers show Allow and Deny
  on the notification. On an iPhone this needs Corral on the Home Screen.
- **Photos.** The camera button sends a picture to the Mac and pastes its path
  into Claude Code, which attaches it. Photos are deleted after 14 days.
- **Changes.** A read-only view of the project's uncommitted git changes, with
  **Ask Claude to commit these**.
- **Cards.** A working window shows how long it has worked and a Stop button.
  Each card shows Claude Code's permission mode, and a ⋯ menu has Last reply,
  Next mode, Mute, Rename, and Close. Press and hold a card for the last reply.
- **Quick replies** above the message box, and a swipe across a terminal to
  move to the next window.
- **Conversation in History.** The first version of the conversation view,
  inside History, with the scrollback under a Screen tab.
- **Keep the Mac awake** while any window is working or waiting on a prompt
  (idle sleep only; a closed lid still sleeps).
- **On the Mac.** Allow and Deny under a window's title bar, a red chip in the
  bottom bar, optional desktop notifications, and windows renamed or closed
  elsewhere follow along.
- **One window per space.** A second click on a space, on the Mac or the
  phone, brings its open window forward instead of starting another.

## 0.2.0 (October 7, 2026)

Corral on your phone and other devices, through Tailscale.

- **Tailscale access.** Requests through `tailscale serve` are accepted only
  for this Mac's tailnet address and an allowed Tailscale login; Corral still
  listens on 127.0.0.1 only.
- **The phone page** at `/m`: every window sorted by whose turn it is, with
  Claude Code's status; a terminal with the keys a phone lacks and a message
  box that works with dictation; a **Use suggestion** key; starting Claude
  Code in any project; Restore. It can be added to the Home Screen.
- **Phone list:** sticky group headers and a jump bar, and no second window
  for a space that is already open.
- **Each device gets its own tmux client** per window, so a window takes the
  size of whichever device typed last.
- **Windows started elsewhere** show up in the Mac's bottom bar without taking
  the keyboard.
- **Open with.** Clicking a file in a space's tree opens it in a Mac app,
  chosen from the apps macOS offers, asking until a default is set.
- The project site gained a sticky top bar with section links and a remote
  control section with phone screenshots.

## 0.1.0 (October 6, 2026)

The first version: a local browser workspace for herdr spaces.

- Real terminals (node-pty and xterm.js, kept alive in tmux) for every herdr
  space, with Claude Code a click away.
- Layouts with drag to swap, and a resizable bottom bar for minimized windows.
- Categories for the sidebar, with multi-select, right-click, drop on rows,
  and Undo.
- Read-only file trees, and a ledger of inactive projects with Reopen.
- Restore after a restart: Corral backs up the open windows with the Claude
  Code conversation in each, and reopens them, resuming each conversation.
- Copying from tmux to the clipboard, and Option-drag for a browser selection.
- Loopback only, with Host and Origin checks on every request.
- A project site for GitHub Pages, with icons and a link preview.
