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

Requirements: Node 20 or newer and Google Chrome. On first run the agent installs its one dependency, Playwright, which drives your Chrome; no separate browser is downloaded. Tested on macOS. On Linux or Windows, set `UX_AUDIT_CHROME` to your Chrome binary if it is not found.

## Use

```
/audit
```

The agent asks for the product URL, the task, what counts as success, the moment of first value, and whether to start from a first visit or a signed-in state. The report is written to `audit/index.html` in your working folder; `ux-audit render --single` also writes one shareable file with every screenshot embedded.

## What it will not do

- Create accounts, type passwords or pass 2FA. If the task needs an account, it opens Chrome and you sign in yourself.
- Delete, pay, subscribe, send, publish or invite without asking you first.
- Invent conversion, revenue or user research. Findings without evidence are refused by the validator.

## Privacy

Everything runs on your machine and your Claude account. Screenshots, data and the report stay in your folder. Nothing is sent to the author. The report links to the author's site; those links carry a `utm_source` tag and nothing else.

## How it is built

- `skills/audit/SKILL.md`: the audit protocol the agent follows.
- `cli/ux-audit.mjs`: browser steps (start, act, capture, measure, render, stop).
- `render/`: the validator and the report renderer. Fonts: Inter and Geist Mono, SIL OFL 1.1.
- `docs/`: protocol, report design and implementation notes.

## License

[PolyForm Shield 1.0.0](LICENSE.md). You may use and change it, including at work and on your company's products. You may not use it to build a product or service that competes with the author's, such as a rebranded audit tool or audit service.

Made by [Andriy Yurchenko](https://ayurchenko.xyz), product designer.
