# Designing an artifact's presentation

How to make an artifact look genuinely designed, in a way any agent — Claude,
Codex, or anything else — can reproduce. Read this plus
[frontend-design.md](frontend-design.md) (Anthropic's design method, vendored
under Apache 2.0) before writing a per-artifact `styles.css`.

## Template is the floor, not the look

The bundled template (ivory field, serif display, coral accent) is a deliberate
generic: safe for a quick internal artifact nobody will judge visually. It is
also, almost exactly, the look frontend-design.md calls out as AI-default
number one — warm cream, high-contrast serif, terracotta accent. So treat it
as the quality floor. **Any artifact that is meant to impress gets its own
`styles.css`**, designed for its subject; `build-artifact.mjs` prefers the
artifact directory's copy over the bundled one, and the validator's
byte-compare keeps it honest.

## Process

Follow frontend-design.md's method, adapted to this pipeline:

1. **Ground it in the subject.** Name the artifact's subject, audience, and
   the page's single job. The subject's own world — its materials, tools,
   vernacular — is where distinctive choices come from. A config-inventory
   artifact can read like a systems manifest; a launch plan like a countdown;
   a finance review like a ledger.
2. **Plan tokens before CSS.** A palette of 4–6 named hex values, type roles
   (characterful display used with restraint, quiet body, utility mono),
   a one-sentence layout concept, and **one signature element** the page will
   be remembered by.
3. **Critique against the defaults.** If the plan is cream+serif+terracotta,
   near-black+one-acid-accent, or hairline-broadsheet-zero-radius, that is a
   default, not a choice — revise unless the subject genuinely calls for it.
4. **Implement in the artifact's local `styles.css`, then rebuild** and view
   it (light, dark, 390px, print) before showing anyone.

## Hard constraints (the pipeline enforces most of these)

- **CSS only.** The markup is generated and fixed; design happens entirely in
  `styles.css`. Do not edit `index.html` — the validator rejects it.
- **Self-contained.** No remote fonts, images, or scripts (validator fails
  them; the Pages CSP additionally allows only `font-src 'self'` and
  `img-src 'self' data:`). Typography comes from system stacks — the serif,
  sans, and mono families that ship with macOS/Windows/Android are the
  palette; choose and pair them deliberately.
- **Both themes.** All color through custom properties defined in `:root` and
  `[data-theme="dark"]`, with `color-scheme` set in each. Never hardcode a
  color in a component rule.
- **Quality floor, non-negotiable:** responsive from 320px up; visible
  `:focus-visible` states; `prefers-reduced-motion` respected; a print
  stylesheet that un-inverts any dark panel and force-shows tasks hidden by
  filters (`.task[hidden]`); body text contrast ≥ 4.5:1, including accent
  colors used as text.
- **Keep the enhancement contract:** `[data-copy]` and `[data-copy-block]`
  stay hidden until `body[data-enhanced="true"]`, `.task.is-interactive`
  affordances appear only when the script adds the class, and `.skip-link`,
  `.toast`, `.manual-copy` remain functional.
- **Comment mode styles itself.** The script injects the `.notes-*` rules
  (pill, outlines, bottom sheets, print hiding) and themes them from your
  tokens: `--surface-solid`, `--ink`, `--muted`, `--line`, `--accent`,
  `--bg`, `--danger`, `--warning`, `--shadow`, `--font-sans`, `--font-mono`.
  Define those in both themes and the controls match the page; nothing to add
  to `styles.css`. Don't restyle `[data-anchor]` elements outside comment
  mode.

## Stylable hooks

The generated markup exposes, top to bottom: `.site-header`, `.brand`,
`.brand-mark`, `.header-actions`, `.quiet-button`, `.copy-button`,
`.button-label`; `.hero`, `.eyebrow-row`, `.eyebrow`, `.status-pill`, `h1`,
`.hero-summary`, `.meta-row`, `.progress-block` (`.progress-heading`,
`.progress-track`); `.highlights` > `.highlight` (`.highlight-label`,
`.highlight-value`); `.section-nav` (`.nav-label`); `.sections` >
`.content-section` (`.section-heading`, `.section-kicker`, `h2`,
`.section-body`, `.bullet-list`); phases: `.filter-group`/`.filter`,
`.phase-list` > `.phase-card` (`.phase-number`, `.phase-topline`,
`.phase-summary`, `.phase-status[data-status]`, `.task-list` > `.task`
with `.task-mark`/`.task-title`/`.task-detail`, states `.is-done`/`.is-open`);
`.copy-block-list` > `.copy-block` (`.copy-block-head`, `.copy-block-label`,
`pre`); `.architecture-flow` > `.architecture-node` (`.node-index`);
`.split-section`, `.stack-list` > `.stack-card` (`.rationale`, `.mitigation`,
`.risk-title-row`, `.risk-severity[data-severity]`); `.action-section`
(`.section-description`, `.action-list`); `footer` (`.footer-links`);
`.empty-state`; charts (inside a section, after `.section-body`):
`.viz.viz-<type>` (`.viz-title`, `.viz-plot` > `.viz-svg.viz-w340|560|760`
or `.viz-fluid`, `.viz-legend`/`.viz-legend-inline` with `.viz-swatch`,
`.viz-legend-label`, `.viz-num`, `.viz-quiet`; `.viz-caption`, `.viz-table`),
SVG classes `.viz-mark` plus a color class (`.viz-s1`…`.viz-s8`, `.viz-part`,
`.viz-up`, `.viz-down`, `.viz-total`), `.viz-label`, `.viz-strong`,
`.viz-value`, `.viz-axis`, `.viz-connector`. Sections that lack data are omitted from the markup entirely —
design for the sections this artifact actually has.

Counters are pure CSS (`.phase-number::before`, and section indices if you
want them on `h2::before`), so numbering is a styling decision — drop it when
order carries no meaning, per frontend-design.md.

## Charts in a bespoke stylesheet

Charts are drawn at build time; their look is entirely in CSS. A bespoke
`styles.css` for an artifact with `charts` must carry the template's whole
`/* ---- charts` block (through `/* ---- end charts */`) and define
`--s1`…`--s8`, `--viz-up`, `--viz-down` and `--viz-total` in both themes —
restyle freely, but keep the container queries: each text-bearing chart ships
three SVGs (340, 560, 760 units wide) and those rules show only the one
nearest the plot's real width, which is what keeps chart text readable on a
phone. Without them all three show stacked (the validator warns). Series
colors fill marks only; chart text uses text tokens.

## Keeping it maintainable

Start from the bundled `styles.css` so the responsive, print, and enhancement
scaffolding carries over, then change tokens, type, and the component rules
your design plan calls for. State the design plan (palette, type roles,
signature element) in a comment at the top of the file — the next agent to
touch the artifact should be able to continue the design, not guess at it.
