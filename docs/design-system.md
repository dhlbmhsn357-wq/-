# Ayyam Design System (P6)

A real, in-code design system — not a spec document. It lives in three files and a living showcase:

| File | Purpose |
|------|---------|
| `css/tokens.css` | The single source of truth: colour, typography, spacing, radius, shadow, motion. Light + Dark. |
| `css/components.css` | Reusable, token-driven components (`ds-*`) with full states + focus rings. |
| `design-system.html` | Living showcase / visual QA reference — open it to see every token and component in both themes. |

Load order (already wired in `index.html`): **tokens.css → components.css → app.css**.

## Visual direction
Modern Arabic · calm · premium · warm · quietly spiritual. Not childish, not a corporate dashboard, and its own voice (not Awwab). Gold (`--color-primary`) is the identity accent; `Aref Ruqaa` carries the identity/headings, `Cairo` the interface.

## Using tokens
Always consume **semantic** tokens; never hard-code hex/px in a component without a documented reason.

```css
.my-thing{
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-md) var(--space-lg);
  box-shadow: var(--shadow-sm);
  transition: background var(--motion-fast) var(--ease-standard);
}
```

### Colour (semantic)
`--color-bg`, `--color-surface`, `--color-elevated`, `--color-primary` (+`-hover`/`-pressed`), `--color-on-primary`, `--color-secondary`, `--color-accent`, `--color-text`, `--color-text-secondary`, `--color-muted`, `--color-border` (+`-strong`), `--color-success`, `--color-warning`, `--color-danger`, `--color-overdue`, `--color-excused`, `--color-replaced`, `--color-focus`, `--color-scrim`, and prayer accents `--color-fajr|dhuhr|asr|maghrib|isha`.

### Typography
Fonts: `--font-display`, `--font-ui`. Scale: `--text-display|h1|h2|h3|body-lg|body|small|caption|button` each with a matching `--lh-*`. Weights: `--fw-regular|medium|semibold|bold|extrabold`. Helper classes: `.ds-display .ds-h1 .ds-h2 .ds-h3 .ds-body-lg .ds-body .ds-small .ds-caption`.

### Spacing / Radius / Shadow / Motion
- Spacing: `--space-xs|sm|md|lg|xl|2xl|3xl|4xl` = 4/8/12/16/20/24/32/40.
- Radius: `--radius-sm|md|lg|xl|pill`.
- Shadow (subtle only): `--shadow-sm|md|lg`.
- Motion: `--motion-fast|normal|slow` + `--ease-standard|out`. Reduced motion is honoured globally.

## Components
Prefix `ds-`. Each interactive one has default / hover (web) / pressed / focus-visible / disabled, a ≥44px touch target, and RTL layout:
`ds-btn` (`-primary|-secondary|-ghost|-danger`, `-block`, `-sm`), `ds-icon-btn`, `ds-field`/`ds-label`/`ds-input` (+`.is-error`, `[aria-invalid]`) / `ds-input-wrap`+`ds-reveal` (password) / `ds-select`, `ds-chip`, `ds-badge`, `ds-pill` (`-success|-warning|-danger|-overdue|-excused|-replaced`), `ds-card`(+`-elevated`), `ds-task`, `ds-scrim`+`ds-sheet`, `ds-dialog`, `ds-toast`, `ds-empty`, `ds-tabs`/`ds-tab`, `ds-progress`, `ds-skeleton`/`ds-spinner`.

## Theming
Dark is the default (`:root`). Light is `html[data-theme="day"]`. When the app hasn't chosen a theme yet, the OS `prefers-color-scheme` is respected. Toggle by setting `data-theme` to `day`/`night` on `<html>` (the app already does this from prefs).

## Accessibility
- Keyboard focus ring on every focusable element (`:focus-visible`, `--color-focus`).
- Touch targets ≥ 44px on interactive components.
- Colours chosen for readable contrast in both themes; don't trade readability for looks.
- Use real `<label for>` / `aria-*`; `ds-input.is-error` pairs with `aria-invalid="true"` + `.ds-error`.

## Scope note
P6 builds the system and applies it to the showcase + shared primitives (Auth/Onboarding pick up the refined tokens automatically). Full screen redesigns (Today/Calendar/Insights/Settings) are **P7**.
