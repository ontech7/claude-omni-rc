---
name: editing-the-landing-page
description: How to change index.html, the GitHub Pages landing page of claude-omni-rc, without breaking it. Use this skill for ANY edit to index.html or assets/*.svg — copy tweaks, a new section, restyling, a new screenshot/terminal mock, changing the install command, updating the nav or footer — and also when the user says "the site", "the landing", "the page", "the hero", or the Italian equivalents ("il sito", "la landing", "la pagina", "l'hero", "cambia la home"), or asks to promote a new feature on the homepage. The page has no build step and no reviewer, so mistakes ship straight to production; read this before touching the file.
---

# Editing the landing page

`index.html` **is** the deployed site: GitHub Pages serves it from `main` at
<https://ontech7.github.io/claude-omni-rc/> (`.nojekyll` disables Jekyll
processing). There is no build, no bundler, no framework, no staging. A merged
commit is a live deploy, and nothing in CI looks at this file — `npm run
typecheck` and `npm test` will stay green on a page that renders as a blank
screen. That is the whole reason this skill exists: you are the only check.

## The invariants that keep the page cheap to own

These are not stylistic preferences — each one is load-bearing:

- **One self-contained file.** All CSS lives in the single `<style>` block in
  `<head>`, all JS in the single `<script>` before `</body>`. No external
  stylesheets, no CDN scripts, no web fonts, no analytics, no trackers. The
  only external references are the local `assets/*.svg` files. This is what
  makes the page load instantly and survive with zero maintenance — don't
  trade that away for a convenience.
- **Light-only, deliberately.** `:root` sets `color-scheme: light` so the
  browser doesn't auto-darken it under a dark OS. Don't add a
  `prefers-color-scheme` block or a theme toggle unless the user explicitly
  asks for a dark mode — a half-added one produces unreadable text on the
  parts you forgot.
- **Colors come from the tokens**, never hardcoded: `--ink`, `--muted`,
  `--faint`, `--fill`, plus the font stacks `--rounded` and `--mono`. A new
  hex value in the middle of a rule is how the page slowly stops looking like
  one design.
- **Vanilla ES5-flavoured JS in an IIFE.** The existing script uses `var`,
  `function`, and feature-detects (`navigator.clipboard` with a
  `document.execCommand` fallback). Match it. This script runs in whatever
  browser a stranger clicked the link with; it is not a place for optional
  chaining or a framework.
- **Every dynamic-looking element degrades.** The copy buttons work without
  the Clipboard API; the wordmark has a `.sr-only` text fallback; every
  decorative `<svg>` carries `aria-hidden="true"` and every icon link an
  `aria-label`.

## The page's structure

Read the relevant part before editing rather than guessing — the file is ~660
lines, with the CSS grouped by `/* ---------- section ---------- */` comments
in the same order as the markup:

`<header>` nav → `<main class="hero">` (wordmark, `h1`, install `.cmd`, AI-prompt
`.cmd`) → `#how-it-works` → `#on-your-phone` → `#session-types` → models →
`<footer>` → `<script>`.

New sections follow the existing shape — `<section class="section" id="...">`
with a `<header>` containing `h2` + `p.lede`. Keep the CSS for a new section as
a new commented block in the same relative position as the markup, so the two
halves of the file stay readable side by side.

## Content must match what the software actually does

The landing page is the first thing a stranger reads, and it makes promises the
daemon has to keep. Before writing a claim, verify it in the code — the command
list in `bot/telegram.ts` (`setMyCommands` and the `bot.command(...)`
registrations), the flags in `parseNewFlags`, the defaults in `src/config.ts`,
the install flow in `install.sh`. A landing page that advertises a flag that was
renamed is worse than one that says nothing.

Four things in particular are copied across files and drift silently. When you
change one on the page, change it everywhere:

| On the page | Also lives in |
|---|---|
| the install command in `#install-cmd` | `README.md` (Install), `AI-GUIDE.md` (Install) |
| the AI prompt in `#ai-prompt` | `AI-GUIDE.md` (it's the prompt that file answers) |
| any bot command or flag mentioned in prose | `bot/telegram.ts`, `README.md` (Usage), `AI-GUIDE.md` (Command reference) |
| the security framing (default-deny, armed switch, `--auto` opt-in) | `README.md` (Security), `SECURITY.md` |

Never soften the security framing to make the page friendlier. "Whoever can
message your bot while remote control is armed can run code as your user" is a
true statement about an unsandboxed tool, and the page saying so is what makes
the project trustworthy.

## Assets

`assets/` holds SVGs only: `wordmark-{light,dark}.svg`,
`wordmark-mobile-{light,dark}.svg`, `mark-{light,dark}.svg`, `favicon.svg`.
The hero uses `<picture>` with a `(max-width: 760px)` source to swap in the
mobile wordmark. If you add an asset, add it as an SVG and keep the
light/dark pair complete even though only the light one is used today — the
dark variants exist for READMEs and external embeds. `scripts/gen-logo.py`
regenerates the logo family; prefer regenerating over hand-editing paths.

## Verify before committing

An unverified HTML edit is a guess. Do at least this:

1. **Look at it.** Serve the repo root (`python3 -m http.server 8000`) and open
   the page in the pre-installed Chromium via Playwright. Screenshot it at a
   desktop width **and** at 375px — the layout has breakpoints at 760, 700,
   620, 560, and the nav hides `.optional` links below 560. Most landing-page
   regressions are only visible at one of those widths.
2. **Click both copy buttons** and confirm the checkmark swap (`.copied`)
   fires. They're wired by `id` at the bottom of the script — a renamed or
   duplicated `id` breaks them silently, with no console error worth noticing.
3. **Check the console** for errors, and confirm no request goes to a host
   other than your local server (a stray external URL is the invariant that
   most often gets broken by a copy-paste).
4. **Follow every link you touched.** The footer and nav point at GitHub URLs
   that are easy to typo.

If you genuinely cannot render the page in this environment, say so explicitly
in your summary rather than reporting the change as verified — the user can
then look themselves, which is a fine outcome. Silently claiming success is not.

## Committing

The landing page is user-visible but not part of the product's behaviour, so it
does not need a `CHANGELOG.md` entry unless the change announces a feature. Use
a `chore:` or `docs:` commit for pure copy/styling work (`chore: update
index.html` is the established message for a plain refresh), and `feat:` only
when the page is announcing something new that also shipped in code.
