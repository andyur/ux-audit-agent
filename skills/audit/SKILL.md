---
name: audit
description: Task-based product audit of a live web product. Walks one user task in a real browser, captures every meaningful screen with DOM-measured element positions, and writes an evidence-backed HTML report (Keep / Cut / Change / Next, annotated findings, priorities as copyable issues, limits). Use when the user asks to audit, review or tear down a flow, onboarding, first-run experience or task in their product.
---

# /audit

You audit **one task** in **one product**, the way a senior product designer would, and produce a report a founder can act on. The report is only as good as its evidence: fewer, well-supported findings beat a long list.

The CLI is part of this plugin: `node <plugin root>/cli/ux-audit.mjs`, where the plugin root is two levels above this skill's base directory (`<base>/../../cli/ux-audit.mjs`). Below it is written as `ux-audit`. It needs Node 20+ and Chrome, Edge or Brave; on first run it installs its one dependency (Playwright, no browser download), which takes under a minute.

## 1. Define the task before opening anything

Ask the user, in one message, for whatever is missing:

- **Product URL** and the **task** in their words ("sign up and create a first project").
- **Success:** what must exist at the end for the task to count as done.
- **First value:** the moment the user first gets something useful.
- **Starting state:** first visit or signed in (see 2).

## 2. Browser and sign-in

You never create accounts, type passwords or pass 2FA. Pick the browser with the user before opening anything:

- **First visit:** `ux-audit start <url> --fresh`. A throwaway profile with no saved data; nothing to ask.
- **Signed in, in the user's own browser** (the default for signed-in tasks): `ux-audit start <url>`. The audit opens a new window in the user's Chrome, Edge or Brave, where they are already signed in. Before you run it, tell the user, in their language:

  > I'll open a new window in your browser and do the task there, so I can use the sign-in you already have. Your browser will ask once whether to allow a connection: click Allow. It lets this agent control the browser. I only use the window I open; I don't read your other tabs, passwords or history. While the audit runs, the browser shows a bar saying it is controlled by automated software; that is this connection, and it closes when the audit ends. If you'd rather not, I can use a separate window where you sign in to the product once.

  `start` opens the window in the browser profile the user used last and returns its name and the other profiles. Tell the user which profile it is; if the product is signed in elsewhere, run `start` again with `--browser-profile "<name>"` (the browser asks to Allow again). If the product shows a sign-in screen, ask the user to sign in in that window and tell you when done.

  If `start` says the browser does not let the audit connect, give the user its two options in plain words. To turn the connection on, they paste `chrome://inspect/#remote-debugging` into the address bar (Edge: `edge://`, Brave: `brave://`) and switch it on; they can switch it off after the audit. If they declined Allow, offer the separate window and do not ask again.
- **Signed in, separate window:** `ux-audit start <url> --separate`. A separate profile at `~/.ux-audit/profile` that never touches the user's own browser. Ask them to sign in there and tell you when done; later audits reuse it. Use this when the user prefers it, or uses Safari or Firefox (it needs Chrome, Edge or Brave installed; if none is, `start` says how to download Chromium, about 150 MB: ask before running it).

Say which one you used in `meta.startingState`. Stop and ask before any action that deletes, pays, subscribes, sends, publishes or invites.

## 3. Walk the task

```
ux-audit start <url> --out audit [--fresh | --separate]
ux-audit look [selector]                          # what is on the page: roles and names to build selectors from
ux-audit act click "[data-testid=create]"        # one user action per call; also hover, press, type, goto, drag
ux-audit act type "Project name" ; ux-audit act press Enter
ux-audit capture s2 --title "Create dialog" --action "Click Create" --response "Dialog asks for a name" \
  --target "name|Name field|input[name=name]" --target "cta|Create button|role=button[name=\"Create\"]"
ux-audit measure contrast ".hint" --as hintContrast
ux-audit stop                                     # closes the audit window and the connection
```

- Use `look` before acting on a new screen; scope it (`look 'role=dialog'`) when the page is long. Selectors: `role=button[name="Video"s]` for an exact name, `text=/left$/` for a pattern.
- To replace text already in a field: `act click` it, `act press ControlOrMeta+a`, then `act type`.
- If the connection drops mid-audit (the window was closed, or an hour passed without a command), run `start <current url> --continue` to keep the interaction count.
- Capture each **meaningful state** (new screen, dialog, error, result), not every click.
- Every element you might write about needs a `--target` at capture time. Positions come from the DOM; never estimate them from the screenshot.
- Use `measure` for any number you will quote (contrast, size, text). Do not compute in your head.
- If you get blocked, capture the blocking state and stop. Do not work around it.
- Always run `ux-audit stop` when the walk is done, also after a block: in the user's own browser it closes the audit window and the connection.

## 4. Judge against the protocol

Read `docs/audit-protocol.md`. For each candidate finding, it must pass every gate:

- Directly visible in a captured state, and the screenshot supports it.
- Specific to this product and this task.
- Affects completion, understanding, recovery or effort.
- The recommendation is concrete enough to act on.
- If a reasonable designer could disagree, say so in the finding.

Write each finding as **Observed** (what you saw or measured, exact UI text in quotes) / **Why it matters** / **Hypothesis** (marked as not observed) / **Recommendation** / **Evidence**. Never invent conversion, revenue, abandonment, feelings or user research. Zero findings is a valid result.

Severity: `blocker` (cannot finish), `significant` (costs real effort or risks work), `minor` (extra effort, easy recovery), `observation` (not friction here). Visual prominence never raises severity.

AI-product checks (only if the product acts for the user): plan visible before acting, approval, pause and cancel, proposed vs done, uncertainty, memory, cost, recovery from wrong actions.

## 5. Write `audit/data/audit.json`

Follow `examples/report/data/audit.json` exactly: `meta`, `journey` (in capture order; mark the first-value step with `firstValue: true` only if it was reached, and the step where a blocked task stopped with `status: "blocked"`), `summary` (keep / cut / change / next, every line with `refs`), `findings` (each with a `target` that points at a captured `--target` or a `checks` path), `recommendations` (lane `now` / `next` / `test`, with `checks`), `cannotSee` (product-specific), `diagnosis` (include only when a finding raises a question the interface cannot answer).

Leave a summary category empty when the evidence does not support it, with `cutNote` saying why.

## 6. Build and check

```
ux-audit render            # validates, then writes audit/index.html
ux-audit render --single   # also writes one shareable file with screenshots embedded
```

If the validator lists problems, fix the data; never remove a check to pass. Open the report, look at every marked screenshot, and confirm each mark sits on the element the finding is about.

Tell the user: what was tested, what was not, the status (completed / partial / blocked), and where the report is.

## 7. Offer a shareable link (optional)

After the report is built, offer once, in these words, and do nothing unless the user says yes:

> I can make a shareable link for this report so your team can open it in a browser. The report will be stored on ayurchenko.xyz for 30 days. Andriy Yurchenko, who built this agent, can see shared reports. You can also leave an email if you want him to take a look. Share it?

On yes:

```
ux-audit render --single
ux-audit share --consent [--email them@company.com]
```

Give the user the `url` to share, and the `manageUrl` once: opening it in their browser shows an owner bar on the report with the expiry date and a Delete link. If they later ask to remove it, run `ux-audit unshare`. Never upload without their yes, and never pass an email they did not give.
