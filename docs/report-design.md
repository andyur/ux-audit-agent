# Report design

The report is the product. It has to read like a careful consultancy deliverable and hold up when a founder checks every claim against the screenshot.

## Information architecture

| # | Section | Purpose |
|---|---|---|
| Header | Product, task, result, audit type, success, first value, starting state, environment, counts | What was tested and how far it got, before any opinion |
| 1 | Summary: Keep / Cut / Change / Next | The decision page. Every line links to a step or finding. Empty categories say so instead of being filled |
| 2 | Journey | Each captured state: thumbnail, action, system response, cumulative interactions, findings. First value is marked |
| 3 | Findings | Per finding: zoomed evidence, full-screen context, related states, then Observed / Why it matters / Hypothesis / Recommendation / Evidence |
| 4 | Priorities | Change, benefit to the user, what to check before building. No business-impact numbers |
| 5 | Severity | The four levels, so readers can judge the ranking |
| 6 | Limits | What this audit cannot see, specific to the product and task. Optional Product Diagnosis note only when a finding raises a question the interface cannot answer |

## Visual system

Direction from Sana (sanalabs.com, sana.ai), checked against their computed styles on 14.10.2026.

- **Type.** Inter for everything, embedded as a variable WOFF2 (OFL). No monospace anywhere; step numbers use tabular figures. Headings weight 450 with tight tracking (-0.03em at section size).
- **Scale.** 12 / 13 / 14 / 16 / 20 px, display sizes with `clamp()`. Spacing on a 4 px base (4 to 96).
- **Colour.** White sheet, blue-black ink rgb(10 18 23) with 62% and 42% tints, hairlines at 10%. Grey panels #f3f3f1. One signal colour (#ff5a1f) reserved for annotations. Green only for "first value" and the completed status.
- **Structure.** Rounded grey panels (16 to 24 px radius) hold the facts, the four summary blocks and each finding; white inner panels hold the finding text. Pills for severity, step references and the single action (black). No uppercase labels, no section numbers, no shadows.

## Annotations

- Geometry comes from `getBoundingClientRect()` in CSS px of the captured viewport. The screenshot is taken at 2× density but stored with its CSS size, so the transform is `percent = cssValue / viewportCss * 100`. Page scroll is recorded per step (it is zero in the example; canvas apps scroll internally).
- Marks are HTML elements over an unedited `<img>`. The original screenshot stays as evidence.
- **Box:** 2 px signal-colour outline with a soft signal-colour halo, readable on light and dark UIs. **Pin:** numbered disc placed outside the element (left, or right for elements in the left tenth of the frame) so it never covers the text it points at.
- Solid marks = the element a finding is about. Dashed marks with a hollow pin = related context.
- **Zoom:** each finding leads with a full-width crop of at least 760 × 420 CSS px centred on the element, rendered with CSS (scaled image in a clipped frame), so small UI stays legible. Full-screen context and related states follow in a row below.
- If an element is not found in the DOM, no box is drawn and the report says so. No coordinates are guessed from the image.

## Output format

HTML is the primary output (decided 14.10.2026): easier to iterate, screenshots can be large, links work. PDF is optional (`node render/render.mjs --pdf`) and is revisited once the HTML design settles.

## Print (optional PDF)

A4, 14 mm margins. Cover page with the header; summary, findings, priorities and limits each start a new page; a finding never splits from its evidence (`break-inside: avoid`). Backgrounds and marks print with `print-color-adjust: exact`. Link targets print after the Product Diagnosis link. Checked by rasterising the PDF.

## Data the report needs

`capture.json` (steps, screenshots, viewport, DPR, scroll, target geometry, interaction counts), `checks.json` (extra measurements), `audit.json` (meta, journey status, summary, findings with target references, recommendations, limits, diagnosis flag). `render/render.mjs` builds the HTML from these and nothing else.
