# Harnessy app design system

This document defines the shared controls of the Harnessy app (`harnessy open`).
The source is in `packages/harnessy-local-host/src/portal/app/`. Use this document
before you add a control, a stylesheet or an overlay to the app.

## Direction

The app is a calm workspace for four tasks: read, decide, start work and check
progress. Keep text readable and keep actions easy to find. Keep the existing
palette, fonts and dark-first identity.

Do not use decorative gradients, cards inside cards or animation that delays a
control. Do not add a UI framework. The app uses React, plain CSS and the tokens
in `styles/tokens.css`.

Four decisions control the system:

1. **One control system.** All buttons, fields and selects use the same height
   token, `--control-h`. It is 36 px with a mouse and 44 px on a touch screen.
   A base reset removes browser button chrome, so each visible button must use a
   class from this system.
2. **One level of containment.** A page section is not a card inside a card.
   For example, a pinned brief section is marked by a rule at its start edge.
3. **Named layers.** Overlays use the layer tokens below. Only floating layers
   have a shadow.
4. **Recovery beside the problem.** Put the action that fixes an error or an
   empty state directly under its message. The floating Actions button keeps
   its own space at the end of the page, so it does not cover content.

## Tokens

All colours, sizes, layers and motion come from `styles/tokens.css`. A stylesheet
must not use a raw colour or an undefined custom property.
`test/app/design-system.test.ts` makes sure of this.

| Group | Tokens | Rule |
| --- | --- | --- |
| Colour | `--bg`, `--panel`, `--raised`, `--hairline`, `--text`, `--text-2`, `--muted`, tones and `-text` tones | Text tokens have 4.5:1 contrast or more on each surface in both themes (`tokens.test.ts`). Use a tone for dots, rules and borders. Use its `-text` token for text. |
| Spacing | `--space-1` 4 px, `--space-2` 8 px, `--space-3` 12 px, `--space-4` 16 px, `--space-6` 24 px | Use only these steps for new gaps and padding. |
| Controls | `--control-h`, `--control-h-sm`, `--control-pad-x`, `--control-gap`, `--icon-size`, `--select-arrow-space` | `--control-h-sm` is 30 px with a mouse and 44 px on a touch screen. |
| Radius | `--radius-control` 6 px, `--radius-panel` 10 px, `--radius-pill` | Controls use the control radius. Panels and sheets use the panel radius. |
| Layers | `--z-bar` 10, `--z-fab` 20, `--z-sheet` 40, `--z-overlay` 50, `--z-palette` 60, `--z-skip` 70 | The search palette is above all overlays. The skip link is above everything. |
| Elevation | `--scrim`, `--shadow-float` | Only the Actions button, drawers and sheets use `--shadow-float`. |
| Motion | `--motion-fast` 120 ms, `--motion-base` 180 ms, `--ease-out` | Motion shows a state change. `prefers-reduced-motion: reduce` stops all animation and transition. |
| Density | `--row`, `--list-row` | List rows are 40 px, or 32 px in compact density. Controls do not change with density. |
| Terminal | `--terminal-bg` | The terminal surface is dark in both themes to match xterm. |

## Buttons

| Class | Use | Example |
| --- | --- | --- |
| `button` | A secondary action. This is the default. | Work on this, Attach existing session |
| `button button-primary` | The main action of a region. Use one in each region. | Start agent, Generate today's brief |
| `button button-quiet` | A low-emphasis exit or utility. It has no border. | Keep draft and close, Rename |
| `button button-danger` | An action that ends work. | End session |
| `button-sm` | A dense row with a mouse. On a touch screen it stays 44 px. | Terminal keys |
| `icon-button` | An icon-only action. It must have an `aria-label`. | Read again, Close |

States:

- Hover changes the border. Pressed (`:active`) changes the fill.
- `aria-pressed="true"` or `aria-current` marks a selected toggle.
- `disabled` reduces opacity and blocks input.
- `aria-busy="true"` shows work in progress. Keep the label length close to the
  idle label, so the button does not change size. Guard the handler with a ref,
  so that a second click cannot start a second request.
- Each control shows the shared 2 px focus ring on `:focus-visible`.

Icons in a button are 16 px with an 8 px gap to the label. Do not use a tooltip
as the only name of a control. A touch screen cannot show it.

## Fields and selects

- Put the label above the control: `<label className="field">`.
- Put a description below the control: `field-hint`.
- Put an error directly below the control or form it is about:
  `<p className="form-error" role="alert">`.
- Use `input`, `textarea` and `select` with the same height and border.
- Wrap each `<select>` in `<span className="select">`. The wrapper draws the
  arrow and keeps `--select-arrow-space` (40 px) clear at the inline end. A long
  option text ends before the arrow. The arrow shape is physical, so it points
  down in both text directions.

## Overlays

| Overlay | Behaviour |
| --- | --- |
| Quick Actions drawer | Opens from the Actions button. It is a right-side drawer on a wide screen and a bottom sheet below 760 px. Focus moves to the first body control, or to the first field in the composer. Tab stays inside. Escape, Close and a backdrop click close it. Focus goes back to the Actions button. Closing keeps the composer draft for the same brief section. |
| Detail sheet | Below 1100 px, list details open as a bottom sheet (`--z-sheet`). |
| Search palette | Cmd-K or Ctrl-K. It is above all other overlays. |

Do not open two drawers at the same time. Closing a view must not end work.
Closing the drawer or the Terminal view detaches the viewer. Only End session
stops a process, and it asks for confirmation first.

## Layout

- The page gutter is 28 px on a wide screen and 16 px on a phone.
- The page keeps `--fab-clearance` free at the end of its content, so the Actions
  button never covers the last row, a form or a terminal control.
- Use `card` for a self-contained summary. Do not put a card in a card.
- Text wraps (`overflow-wrap: anywhere`). A long URL or label must not widen the
  page. A command chip scrolls inside itself.
- Status is always a dot and a word. Colour is never the only signal.

## Accessibility and touch

The target is WCAG 2.2 AA. Automatic checks do not prove compliance. A manual
review with a screen reader is still necessary.

- On a touch screen (`pointer: coarse`), each control is 44 × 44 CSS px or larger.
  Dense rows are an exception only with a mouse.
- Hover must not be necessary to complete a task.
- Each icon-only control has an accessible name.
- Dialogs use `role="dialog"`, `aria-modal` and `aria-labelledby`.

## Multilingual readiness

- Use logical CSS properties (`margin-inline-start`, `inset-inline-end`) for
  layout. The skip link is the only exception. It uses `left: -9999px` to hide,
  because a logical value causes horizontal scroll in right-to-left pages.
- Commands, code, paths and identifiers (`code`, `kbd`, `.mono`, `.command-text`)
  keep left-to-right direction and isolate their text.
- The terminal surface is always left-to-right. Do not mirror terminal bytes.
- Keep original Unicode input, including tone marks. The brief snapshot that a
  task carries keeps the exact text.

## Showcase

The showcase shows each shared control in its states, with switches for theme,
density and text direction. It uses the real classes and components.

1. Run `npx vite --config src/portal/app/vite.config.ts --port 5199` in
   `packages/harnessy-local-host`.
2. Open `http://localhost:5199/showcase/`.

The production build emits only the app's `index.html`. The showcase is not
packaged or installed. `test/app/showcase.test.tsx` renders it.

## Verification

| Check | Location |
| --- | --- |
| Tokens defined, no raw colours, every button has a class, 44 px touch controls | `test/app/design-system.test.ts` |
| Palette contrast in both themes | `test/app/tokens.test.ts` |
| Drawer focus, Escape, backdrop, draft, single launch, launch errors, device pairing | `test/app/quick-actions.test.tsx` |
| Same-tab native sign-in keeps the route and opens no new tab | `test/app/browser-signin-button.test.tsx` |
| Terminal state words, input ownership, takeover, resume, rename, detach on close, reconnect, End session confirmation | `test/app/terminal.test.tsx` |
| Brief section to agent composer, recovery beside a failed brief | `test/app/today.test.tsx` |
| Per-file coverage floors for each screen and component | `vitest.config.ts`, `test/coverage-floors.test.ts` |

## Audit, 3 November 2026

The audit used an isolated portal with fixture data at 360, 390, 768, 1024 and
1440 CSS px, in both themes.

| Screen or component | Observed problem | User impact | Correction | Verification |
| --- | --- | --- | --- | --- |
| Quick Actions drawer | It used `var(--surface)`, which no theme defined. The panel fell back to a dark colour, and the text stayed dark in the light theme. Buttons had browser chrome. | The brief-to-agent path was almost unreadable in the light theme. | The drawer and bottom sheet use tokens, fields, selects and button classes. | Browser, both themes; `design-system.test.ts` |
| Actions button | The background was transparent, and the button covered content and controls on phones. | Content was hidden. The button looked broken. | A solid raised pill with a shadow. The page keeps clearance for it. | No covered content at five widths |
| Quick Actions focus | Focus was lost after the menu, the composer and then Escape, because the opener had unmounted. | Keyboard users lost their place. | The Actions button stays mounted. Focus goes back to it. | `quick-actions.test.tsx` |
| Agent launch | A fast second submit sent a second launch. | A duplicate agent task. | A ref guard and `aria-busy`. | `quick-actions.test.tsx` |
| Composer draft | Reopening the composer cleared the typed instructions. | Lost work after an accidental close. | The draft stays for the same brief section. | `quick-actions.test.tsx` |
| Today: Work on this | Full-width buttons with browser chrome. | Heavy, inconsistent actions. | Small secondary buttons at the start edge. | Screenshots |
| Today: pinned sections | Cards inside the brief card. | Visual noise and less room for text. | One card with marked sections. | Screenshots |
| Today: failed brief | The error was in the article, and Generate was at the end of the side column. | The recovery action was far from the problem. | Generate is directly below the reason. The side card shows only when a brief is shown. | `today.test.tsx` |
| Terminal controls | Browser-default buttons and selects with raw colours, a hand-drawn arrow, and a state shown as plain text. | Weak hierarchy. Ending a session looked the same as detaching. | Shared classes. End session is the only danger action. Status is a dot and a word, with the input owner. | `terminal.test.tsx`, screenshots |
| Control heights | 34, 38, 40, 48 and 52 px buttons. Below 44 px on phones. | Uneven rhythm and small touch targets. | `--control-h` 36 px, or 44 px on touch. | `design-system.test.ts` |
| Layers | The search palette (20) was below the Actions button (35) and the detail sheet (40). | The search could open under other layers. | Named layer tokens. | Source review |
| Right-to-left | Physical properties, a mirrored chevron and commands that flip direction. | Broken layout in a right-to-left locale. | Logical properties and left-to-right technical text. | Showcase screenshots |

## Known limits

- Rename and End session use the browser's `prompt` and `confirm` dialogs.
- The search palette, the detail sheet and the cockpit (`harnessy web`) keep
  their earlier styles. The cockpit is a separate application.
- Contrast was checked for tokens. A full manual screen-reader review was not
  done.
- Right-to-left was checked in the showcase with English text. No translated
  catalogue exists yet.
- At 761 to 900 px, the top bar beside the sidebar has two rows. The view
  toggles move to the second row. From 900 px, and at phone width, the bar has
  one row. Below 1100 px the search button shows only its icon and keeps the
  accessible name "Search or copy".

## Meeting review boundary

Meeting review is server-rendered in
`packages/harnessy-core/src/jarvis/meeting-publication/review.ts`. It has a separate
session and a Content Security Policy that permits only the hashed stylesheet.
Keep this security boundary when changing its presentation.

The review palette follows this app in both system themes. The contract test
`packages/harnessy-core/test/meeting-publication-review-design.test.ts` detects
palette drift. The review does not import the React app. It does not yet receive
a manually selected portal theme across the service boundary.

Queue sections, including connection status in every health state, must use the
same width, gutters and padding. Keep connection recovery beside its status.
Use compact headings, 10 px panel corners, 6 px control corners and no static
card shadows. Controls must reach 44 px on touch screens. Keep the destination
preview distinct from the application controls.

The isolated reconnect browser gate also checks queue alignment and padding,
meeting detail overflow, and return navigation at 1440, 390 and 320 CSS px.
It uses synthetic consent and makes no real provider writes. Inspect the full
queue, note, connection details and reconnect pages before installation.
