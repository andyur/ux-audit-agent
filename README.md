# ux-audit-agent

A task audit of a live web product, run from Claude Code. You name one task ("sign up and create a first project"); the agent walks it in your own Chrome, captures every meaningful screen with element positions measured from the DOM, and writes an HTML report a founder can act on.

The report has:

- **Summary:** what to keep, cut, change and do next, each line pointing to its evidence.
- **Journey:** every captured state with the action taken and the product's response.
- **Findings:** zoomed evidence with marks placed from the DOM, then observed, why it matters, hypothesis, recommendation and evidence.
- **Priorities:** Now, Next and Test first, each a task you can copy into Linear, Jira or GitHub.
- **Limits:** what this audit cannot see.

An example report for Excalidraw is in [`examples/report/`](examples/report/). Open `index.html` locally.

## Install

In Claude Code:

```
/plugin marketplace add andyur/ux-audit-agent
/plugin install ux-audit-agent@andyur
```

Requirements: Node 20 or newer and Chrome, Edge or Brave. On first run the agent installs its one dependency, Playwright, which drives your browser; no separate browser is downloaded. Tested on macOS with Chrome.

## Which browser it uses

- **Your own browser, signed in (default).** The agent opens a new window in your Chrome, Edge or Brave, in the profile you used last, so the product is already signed in. Your browser asks once per audit to allow the connection, and shows a bar saying it is controlled by automated software while the audit runs. The agent works only in the window it opened and closes it at the end. This needs remote debugging switched on once at `chrome://inspect/#remote-debugging` (version 144 or newer); the agent tells you if it is off.
- **A separate window.** If you would rather not connect your browser, or you use Safari or Firefox, the agent opens a separate Chrome, Edge or Brave profile where you sign in to the product once. With none of those installed, it can download Chromium (about 150 MB) if you agree.
- **First visit.** For signup and onboarding audits it uses a throwaway profile with no saved data.

## Use

```
/audit
```

The agent asks for the product URL, the task, what counts as success, the moment of first value, and whether to start from a first visit or a signed-in state. The report is written to `audit/index.html` in your working folder; `ux-audit render --single` also writes one shareable file with every screenshot embedded.

## Shareable link (optional)

After a report is built, the agent can offer a link your team can open in a browser. Nothing is uploaded unless you say yes. The single-file report is stored on `r.ayurchenko.xyz` for 30 days, then deleted automatically; the author can see shared reports. The link opens the report in a sandbox, without tracking scripts. To remove it earlier, ask Claude to run `ux-audit unshare`, or open the manage link once and use Delete link on the report.

## What it will not do

- Create accounts, type passwords or pass 2FA. If the task needs an account, you sign in yourself.
- Read your other tabs, passwords, cookies or history in your own browser.
- Delete, pay, subscribe, send, publish or invite without asking you first.
- Invent conversion, revenue or user research. Findings without evidence are refused by the validator.

## Privacy

Everything runs on your machine and your Claude account. Screenshots, data and the report stay in your folder. Nothing is sent to the author unless you choose to share a link (see above). The report links to the author's site; those links carry a `utm_source` tag and nothing else.

## How it is built

- `skills/audit/SKILL.md`: the audit protocol the agent follows.
- `cli/ux-audit.mjs`: browser steps (start, act, capture, measure, render, stop).
- `render/`: the validator and the report renderer. Fonts: Inter and Geist Mono, SIL OFL 1.1.
- `docs/`: protocol, report design and implementation notes.

## License

[PolyForm Shield 1.0.0](LICENSE.md). You may use and change it, including at work and on your company's products. You may not use it to build a product or service that competes with the author's, such as a rebranded audit tool or audit service.

Made by [Andriy Yurchenko](https://ayurchenko.xyz), product designer.
