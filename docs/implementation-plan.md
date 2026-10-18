# Implementation plan

Built backwards from the working report in `examples/report/`. The renderer, CSS and data shape stay; the agent's job is to produce `capture.json`, `checks.json` and `audit.json` for any product and task.

## 1. What each report part needs

| Report part | Data | Collected by | Reliability | Failure → behaviour |
|---|---|---|---|---|
| Header facts | Task, success, first value, start state, environment | User input + runtime | High | Missing task definition → agent asks before starting |
| Screenshots | PNG per state, CSS viewport, DPR, scroll | Code (Playwright) | High | Capture fails → step marked failed, audit cannot be `completed` |
| Annotation boxes | Element rects for chosen selectors | Code (DOM) | High when selector resolves | Unresolved → no box, report says so |
| Journey | Action, response, cumulative interactions | Code logs actions; model writes response text | Medium | Response text must describe only what the screenshot shows |
| Completion | Success condition check | Code where checkable (file written, URL, element present); model otherwise | Medium | Unverifiable → `partial` with reason |
| Measurements | Contrast, sizes, counts, defaults, tooltip text | Code (computed styles, DOM reads) | High | Not measured → not claimed |
| Findings | Observed / matters / hypothesis / recommendation | Model, against the protocol | Low to medium | Must pass the quality gates and a second model pass that checks each claim against its evidence |
| Summary, priorities | Synthesis of surviving findings | Model | Medium | Every line must cite a step or finding ID; validator rejects uncited lines |
| Limits | Product- and task-specific gaps | Model, from a checklist | Medium | Generic-only list → validator warns |

## 2. Pipeline

| # | Stage | Who |
|---|---|---|
| 1 | Task definition: task, success, first value, start URL, allowed actions | Model asks user, writes `task.json` |
| 2 | Session: launch Chrome with a persistent profile; if sign-in is needed, open headed and wait for the user | Code |
| 3 | Execute: model picks the next action from the accessibility tree and screenshot; code performs it and logs it | Model decides, code acts |
| 4 | Capture: screenshot + scroll + DPR for each meaningful state | Code |
| 5 | Targets: model names elements by selector or role/name; code resolves rects | Model names, code measures |
| 6 | Observation log: action, visible response, counts | Code + model |
| 7 | Measurements: contrast, sizes, defaults, tooltips, file outputs | Code (small library of checks the model can call) |
| 8 | Findings draft | Model |
| 9 | Finding validation: quality gates, evidence check, severity rule | Model second pass + code schema check |
| 10 | Assembly: `audit.json` with IDs and references | Code validates references |
| 11 | Render HTML | Code (`render.mjs`, unchanged) |
| 12 | PDF | Code (Chrome `page.pdf`) |

Code owns coordinates, dimensions, IDs, counts, contrast, file I/O and rendering. The model owns choosing actions, interpreting friction, writing findings and synthesis.

## 3. Browser

- **Playwright driving the user's installed Chrome** (`channel: 'chrome'`), as in the prototype. Gives files on disk, DOM geometry and deterministic screenshots, which the Claude Code browser tools do not write to disk.
- **Sign-in:** persistent profile at `~/.ux-audit/profile`. First run opens a visible window; the user signs in; later runs reuse the session. The agent never types credentials.
- **Native dialogs** (file save, OS pickers) are outside the page. The agent records that the dialog was invoked (a stub, as in the example) and the report states it.
- **Destructive or paid actions:** a deny-list of patterns (delete, remove, pay, purchase, subscribe, send, publish, invite) plus any confirm dialog → stop and ask the user in chat.
- **Personal data:** before saving each screenshot, mask elements matching user-provided selectors (email, name, account id); default masks for `input[type=email]`, `[autocomplete*=email]`.

## 4. Data model (as used by the renderer)

```
capture.json  { product, url, capturedAt, browser, viewport{width,height}, dpr, interactions, steps[] }
  step        { id, title, action, response, screenshot{file, cssWidth, cssHeight, dpr, scroll{x,y}},
                targets[{id, label, box{x,y,width,height}|null, source:'dom'|'missing'}], interactionsSoFar }
checks.json   { <named measurements>, checkedAt }
audit.json    { meta{product,url,task,taskDetail,success,firstValue,startingState,environment,auditType,status,statusNote},
                journey[{step,status,firstValue?,response?,findings[]}],
                summary{keep[],cut[],cutNote,change[],next[]}  // item {text, refs[]}
                findings[{id,title,step,severity,consequence?,target{source,step|path,id,label},related[],
                          observed,matters,hypothesis,recommendation,evidence,confidence,disagreement?}],
                recommendations[{priority,refs[],change,benefit,validate}],
                cannotSee[], diagnosis{include,text,link} }
```

Additions needed for the agent: `task.json`; `status` values `completed | partial | blocked | insufficient`; `step.status = failed` with `error`; a `schema.json` and a validator that fails the render on dangling references or uncited summary lines.

## 5. MVP scope

In: one task, one browser flow, persistent sign-in, screenshots, DOM-grounded marks, 0 to 5 validated findings, Keep/Cut/Change/Next, HTML + PDF, one public example (this one, regenerated by the agent).

Out: multiple flows, crawling, monitoring, analytics integrations, scores, dashboards, team features, cloud, mobile apps, Codex support (checked after MVP).

## 6. Packaging

A Claude Code plugin from the GitHub repo: one skill (`/audit`) with the protocol and instructions, plus a small Node CLI the skill calls through Bash (`ux-audit start | act | capture | measure | render`). Install: add the repo as a plugin marketplace and install the plugin; the CLI's dependencies install on first run. Playwright uses the user's Chrome, so no browser download.

## 7. Milestones

| # | Objective | Tasks | Artifact | Accept when | Risk |
|---|---|---|---|---|---|
| M1 | CLI from the prototype | Turn `capture/*.mjs` into `act`, `capture`, `measure`; keep `render` | `cli/` with 4 commands | Example report regenerates from CLI calls only | Action API too narrow for real apps |
| M2 | Model-driven run | Skill instructions: task definition, action loop, target naming | `/audit` skill | Agent completes the Excalidraw task unaided and writes `capture.json` | Model loses track in long flows |
| M3 | Findings with gates | Protocol in the skill, second-pass validator, schema check | `audit.json` from the agent | Output on Excalidraw matches or beats the hand-checked example; no unsupported claims | Generic findings slip through |
| M4 | Signed-in products | Persistent profile, masking, destructive-action stop | Audit of a signed-in SaaS flow | Runs on 2 products with accounts; no credentials or PII in output | Session expiry, 2FA prompts |
| M5 | Publish | README, install test on a clean machine, article, regenerated example | Public repo + article | Fresh install to report in under 10 minutes | Install friction |

Next concrete step: M1, starting with `act` and `capture` built from `capture/excalidraw.mjs`.

## Status (14.10.2026)

- **M1 done, first version:** `cli/ux-audit.mjs` with `start` (`--fresh`, `--headed`, persistent profile), `act`, `capture` (DOM targets), `measure` (contrast, text), `render` (`--single`), `stop`. Tested end to end on Excalidraw: 2880 × 1800 screenshots at 2×, DOM boxes, contrast 1.98:1 reproduced.
- **M2 written, not yet run:** `skills/audit/SKILL.md`. Next check: Claude runs a full audit from the skill alone, including writing `audit.json`, and the validator passes.
- **Done alongside:** `render/validate.mjs` blocks reports with unreferenced summary lines, findings without evidence, unmeasured targets or dangling refs. Footer credits the agent and author; author links carry `utm_source=ux-audit-agent&utm_medium=report&utm_campaign=<product>`. `--single` writes one shareable HTML (about 3 MB for 8 screenshots).
- **Waiting on Andriy:** a signed-in AI-agent product for the second example (he signs in once in the `--headed` window).
