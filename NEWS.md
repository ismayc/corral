# News

What changed in each version of Corral, newest first. The version is the one
in `package.json`.

## Development version

- **A notice when a space opens a plain shell.** On the Mac page, a
  click on a space that opens a shell instead of Claude Code says so, and
  names the "A space opens" setting behind it. The browser no longer brings
  back an old value for that setting when it reloads the page; the saved
  choice decides.
- **A link to your tailnet's page list.** When `~/.config/tailnet-hub/url`
  holds an `http://` or `https://` address, the Mac page's top bar and the
  phone page's header show an "All tailnet pages" link to it, in the same
  tab. Without the file, or with anything else in it, they show nothing.
- **Opening a space from a search clears the search.** On the Mac page,
  clicking a space you found with "Find a space" empties the box, so the
  sidebar shows the full list again, and the keyboard stays in the window
  that opens. The x and Esc still clear the search and keep you in the box.
- **Shortcuts in the Mac page's top bar.** A Shortcuts button lists the
  keys and clicks that work on the page: erasing what you typed, Claude
  Code's own keys, the mouse in a window, and the sidebar. A click
  outside it, or Esc, closes it.
- **Cmd-Backspace erases the line on the Mac.** In a window on the Mac
  page, Cmd-Backspace erases back to the start of the line (it sends
  Ctrl-U, as Positron and VS Code do) instead of one letter.
  Option-Backspace still erases one word at a time.
- **New project on the Mac.** A New project button in the top bar asks
  for a folder name, then makes the folder in the repos folder with a git
  repo and a herdr space (the phone's `POST /api/projects/create`), and
  opens a window there as "A space opens" says. A name that is taken or
  not allowed says why and keeps the box open to fix it.
- **Your last prompt at the top of each window.** On the Mac page, a line
  under each window's title bar shows the last prompt you typed there, and
  on the phone a line under the window's header does the same, in Chat and
  Terminal alike. It stays in place while the terminal scrolls; a click or
  tap lists every prompt you sent in that conversation, oldest first, with
  when you sent it (the most recent 500, from the last 64 MB of the
  transcript, through `GET /api/sessions/:id/prompts`). A skill or a command of your own (`/wrap-up`)
  counts, Claude Code's own commands (`/model`, `/clear`) do not, and a
  message sent while Claude was working counts. Its × hides it on that browser:
  Prompts in the Mac toolbar, or the phone's ··· menu, shows it again. The
  server reads it from the end of the window's transcript, then only from
  what was added since.
- **The phone answers Claude's questions.** When Claude Code asks with its
  question dialog (its session file says `input needed`), the card and the
  bar under the window show the question, a button per answer with its
  description, a box for an answer of your own, Next on a question that
  takes several answers, the review screen's Submit, and Cancel. Each answer
  names the question it was shown for, so it is refused once Claude asks
  something else. In Chat, the bar now shows what a permission prompt or
  question asks, since the terminal is covered, and the dialog's own lines
  are no longer shown as status lines.
- **The phone approves plans.** A plan from plan mode asks with a
  permission prompt that has no "Esc to cancel" line, so the phone showed
  no answers for it. Its answers now show, with Read the plan, which opens
  the whole plan from its file in `~/.claude/plans`. "Tell Claude what to
  change" closes the dialog and leaves Claude in plan mode, for the changes
  to go in as a message: Claude Code's own box for them once approved the
  plan instead in a test.
- **A tapped notification opens its own window.** The tap was passed to the
  open phone page by a single message, which an iPhone can drop while the
  page is asleep, so the page woke on the window it showed last. The tap is
  now also left in Cache Storage, and the page opens that window when it
  comes back (ignoring a tap older than two minutes).
- **Auto-compacted windows get their own section, just above Parked.** A
  window whose conversation Claude Code compacted on its own (a
  `compact_boundary` with trigger `auto` in its transcript), and that has
  finished with nothing typed since, is listed under Auto-compacted windows
  on the Mac and on the phone. A manual `/compact` does not count, and
  typing anything moves the window back.
- **Links in a window open after you confirm.** Clicking a link on the Mac
  or tapping one on the phone shows the address with Open in browser and
  Cancel, and Open uses that device's browser. This covers the links Claude
  Code marks (OSC 8, which tmux now passes on, so a long address wrapped
  onto two lines opens whole), plain http(s) text in any window, and the
  links in phone Chat, which used to open at once.
- **Scrolling works again on the Mac once Corral has run a while.** A Mac
  page gets a window's last 256 KB of output when it connects. tmux turns
  mouse reporting on only once, when its client attaches, so after enough
  output that was no longer in the replay: the page never turned mouse
  reporting on, and the wheel scrolled its own empty scrollback instead of
  reaching Claude Code. The server now keeps the terminal modes set by the
  output it trims and sends them ahead of the replay.

- **Any file dropped on a Mac window pastes its path.** The browser never
  sees a dropped file's path, only its name, size, and modified time, so the
  server finds the file from those: in Downloads, Desktop, Documents, or the
  home folder first, then through Spotlight, taking only a file whose size
  and time both match. Its path is pasted, escaped the way Terminal.app
  pastes a dropped file, and nothing is copied. An image that cannot be
  found (dragged from a screenshot's thumbnail, say) is still uploaded and
  its copy's path pasted; any other file that cannot be found is named in a
  message. Only the Mac's own page can ask where a file is.

- **Slash commands autocomplete on the phone.** Typing `/` at the start of
  the message box lists the window's skills and commands, narrowed as you
  type, with names that start with what you typed first. A tap fills in the
  name and a space, ready for arguments, without sending. The list comes from
  the Mac: skills and commands in the project's `.claude` folder (and the
  folders above it), the user's own in `~/.claude`, enabled plugins' (as
  `plugin:name`), and the built-in commands most useful from a phone. Skills
  turned off in `skillOverrides`, or marked `user-invocable: false`, are left
  out.

- **The phone says why it cannot open Corral.** A request that comes in
  through the tailnet address but is refused now gets a page saying what is
  wrong and what to do, instead of a bare `{"error":"bad host"}`: Tailscale on
  the Mac is logged out, turned off, or not running; Corral has not found its
  tailnet address yet; the address is out of date (with a link to the right
  one); or the request had no allowed Tailscale login. While the fix is on the
  Mac, the page reloads itself every 30 seconds, so it opens once Tailscale is
  back. API calls get the same explanation as their error, and the server log
  notes each change in Tailscale's state. Requests for any other host still
  get only "bad host".

- **`/clear` parks a window.** A window whose last typed command was `/clear`
  moves to a Parked windows section: below Open windows on the Mac, and last
  on the phone, after Shells, with its own chip and no count in the page
  title. It stays easy to find for coming back to, without mixing in with the
  windows still holding work. The server reads this from Claude Code's
  transcript, where a cleared conversation starts with the `/clear` command,
  and rereads a transcript only when its size or time changes. Typing in the
  window moves it back.

- **Windows that need you most recently come first.** On the phone, each
  group of the list (Waiting for you, Working, Shells) and the herdr spaces
  in the Start sheet are ordered by when the window's Claude last changed
  status, newest on top; on the Mac, the sidebar's Open windows section is.
  tmux's activity time was no use for this: an idle Claude still redraws its
  screen, so every Claude window looked active within the last minute. Plain
  shells, which have no Claude status, go by their last output. A window
  asking for permission no longer jumps ahead of newer "Your turn" windows.

- **A Dock icon that starts the server.** `scripts/install-launcher.sh`
  builds `~/Applications/Corral.app`, which starts the herdr server and the
  Corral server when they are not running, waits for Corral, and opens the
  page. It replaces the
  Chrome web app's icon in the Dock (same icon, same position), so a click
  after a Mac restart works instead of showing a page that cannot connect.

- **Trusting a folder takes one tap on the phone.** When Claude Code opens in
  a folder it has not seen, it asks whether to trust it, with "No, exit"
  selected. The phone terminal now shows a "Yes, I trust this folder" button
  above the keys. It presses ↓ only when ❯ is on No (↓ wraps, and number keys
  do nothing in this dialog), and Enter only once the screen shows ❯ on Yes.
  The phone reads the dialog from its own terminal, since Claude Code writes
  no session file until the folder is trusted.

- **A window can start with an opening prompt.** `POST /api/sessions` takes
  a `prompt` (one line, up to 4000 characters) and starts Claude Code with it
  on its command line. When the space already has a window, the prompt is
  typed into the Claude Code running there instead, unless that window has
  no Claude Code or Claude is waiting on a prompt or dialog of its own, which
  answers 409 and says why. This is for tools that hand Corral a task, such
  as mail-triager's "Open in Corral with Claude" Mail action; the page itself
  still starts windows with no prompt.

- **A window handed a task comes into view.** A window started with a
  prompt, or one whose Claude Code had a prompt typed into it, opens in a
  zone on the Mac's page and takes the keyboard, coming out of the bottom bar
  if it was there. Windows started elsewhere with no prompt still wait in the
  bottom bar. A note says which window got the task.

- **Start something can make a new project.** Type a name in its search box
  that is not a project yet, and a **New folder** row appears at the bottom.
  Tapping it makes the folder in `~/repos` (or `CORRAL_REPOS`), starts a git
  repo there, and gives it a herdr space, then starts the kind you picked
  (Claude Code, Last session, or Shell) in it. Spaces in the name become dashes; a
  name that is taken, or has other characters, is refused. If herdr cannot
  make the space, the folder is kept and the window starts there anyway.

- **Claude's replies in phone Chat are drawn as Markdown**: headings, bold
  and italic text, inline code and code blocks, lists (nested ones too),
  quotes, rules, links, and tables. A wide table or code block scrolls
  sideways inside its bubble. Your own prompts stay as you typed them. The
  reply is built as page elements, never as HTML, so nothing in it can add
  markup or run a script.

- The **focused window** on the Mac page now has a solid purple title bar
  (and a purple border) in place of the thin lavender line across its top,
  so the window your typing goes to is plain at a glance. The site's
  workspace and layout screenshots are retaken to match.

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
