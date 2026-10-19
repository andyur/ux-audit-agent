# Audit protocol

One task, one workflow, observed in a real browser. The audit answers: can a person finish this task, how much does it take to get value, and where does the product make it harder than it needs to be. It does not judge the product as a whole.

## 1. Define the task before touching the product

| Field | Example (Linear) |
|---|---|
| Task | Create a first issue, then find it again from My issues or Inbox |
| Success | The new issue is found again from My issues or Inbox |
| First value | The issue just created shows up in a list of my work |
| Starting state | The user's own Chrome, signed in to a workspace with one team |

The agent never signs up or enters passwords. If the task needs an account, the user signs in first and the audit starts from that state, which the report states.

## 2. What is measured, and kept apart

| Measure | Meaning | Source |
|---|---|---|
| Interactions | Clicks, drags, key presses, typed strings | Execution log (code) |
| Decisions | Points where the user must choose between options | Analysis |
| States | Distinct screens or dialogs captured | Execution log |
| First value | The step where the defined value first exists | Task definition + observation |
| Completion | Whether the success condition was met, and how it was verified | Observation |

Machine time is recorded but never reported as user time.

## 3. Evaluation dimensions

- **A. Completion.** Clear start and end, blocks, recovery from interruptions.
- **B. Path to value.** Which steps are essential, which add friction, which shortcuts exist and how they are surfaced.
- **C. Clarity and feedback.** What to do next on each screen, what happens after important actions, loading/empty/success/failure states.
- **D. Errors and recovery.** Prevention, actionable messages, undo, destructive actions, resuming.
- **E. AI-native behaviour (only when the product acts on the user's behalf).** Plan visible before consequential actions, approval, pause and cancel, proposed vs done, uncertainty, memory, cost, recovery from wrong actions. Products without AI actions are not penalised for lacking these.

## 4. Evidence standard

Every finding has: ID, specific title, step, observed behaviour, screenshot, affected element, why it matters to the task, severity, recommendation, evidence and confidence. The report separates four layers and labels them:

1. **Observed.** Seen or measured. Quotes UI text exactly. Numbers come from code (DOM, computed styles, counts).
2. **Why it matters.** What the observation means for this task.
3. **Hypothesis.** What may happen to real users. Always marked as not observed.
4. **Recommendation.** A specific change, plus what to check before building it.

Never invented: conversion or revenue impact, abandonment, user feelings, research results, internal decisions.

## 5. Severity

| Level | Rule |
|---|---|
| Blocks the task | Cannot be finished on the tested path, or only by a route most users would not find |
| Slows or risks the task | Finishable, but costs real effort, causes errors, or risks the user's work within the flow |
| Minor friction | Finished with extra effort or searching; easy recovery |
| Observation | Not friction in this flow. A separate flag marks high consequence if it happens |

Visual prominence does not raise severity. Likelihood within the tested flow and recoverability do.

## 6. Quality gates (a finding is dropped if any answer is no)

- Directly observable in a captured state?
- Specific to this product and this task?
- Supported by the screenshot it is shown with?
- Affects completion, understanding, recovery or effort?
- Recommendation concrete enough to act on?
- If a reasonable designer could disagree, does the finding say so?

Zero findings is a valid result. The example audit has three because three survived.

## 7. Audit states

`completed` (success condition met and verified), `partial` (some of the task done; report says where it stopped), `blocked` (could not proceed; report shows the blocking state), `insufficient` (captures failed or evidence too thin; no findings published). Verification methods that differ from a real user's path (for example, a recorder replacing a native dialog) are stated in the header.
