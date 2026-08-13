---
name: keep-it-simple
description: Use when starting any implementation, adding a dependency, or deciding how much to build — before writing code, choosing a library, or expanding scope. Applies to every feature, fix and refactor.
---

# Keep it simple

## Overview

The simplest thing that works is the best thing that works. Every line, file,
dependency and abstraction you add is something that can break, needs testing
and must be understood later. This skill keeps implementations minimal,
focused and maintainable.

## Principles

1. **YAGNI — You Aren't Gonna Need It.** Build for what exists today, not for
   what you imagine might come. A feature that "might be useful later" is
   speculative work: it ships untested, unneeded and in the way.
2. **No over-engineering.** The simplest solution that meets the requirement is
   the right one. No abstraction before a second use case, no config knob
   before a user asks, no "flexible" design for a fixed problem.
3. **Right files.** Put code where the reader would look for it. Follow the
   project's existing structure and patterns — a new file for a one-function
   change, or a change that sprawls across files, are both smells.
4. **Only strictly necessary dependencies.** A dependency is a maintenance
   contract. Before adding one: can the standard library do it? Can a few
   lines of code? Is the dependency already in the tree? Ask before adding.
5. **Optimize where you can.** Prefer the efficient, idiomatic approach from
   the start — but only where it costs nothing. Don't micro-optimize
   speculative hot paths; do avoid obviously wasteful code.
6. **Great UI/UX.** The user's experience is part of the implementation, not
   an afterthought. Clear messages, sensible defaults, graceful failure. A
   feature that works but confuses the user is a broken feature.

## Red flags — STOP and simplify

- "I'll add this now, it might be useful later"
- "Let me make it configurable, just in case"
- "This needs an abstraction"
- "I'll just add this small dependency"
- "Let me build the generic version"
- "While I'm here, I'll also…"

**All of these mean: stop, and build the simplest thing that works.**

## Common rationalizations

| Excuse | Reality |
|---|---|
| "It's just a few lines" | Every line is a line to test and maintain. |
| "We'll need it soon" | Soon is not now. Build it when it's needed. |
| "It's more flexible this way" | Flexibility you don't use is complexity you pay for. |
| "The library does it all" | The library also brings its own bugs and updates. |
| "It's a small dependency" | Small dependencies grow. |
| "The user might want this" | The user asked for what they asked for. |

## Common mistakes

- **Premature abstraction.** One use case is not a pattern. Wait for the second.
- **Config for everything.** A setting nobody asked for is a support ticket.
- **Copy-paste over a helper.** Two copies are fine; three is a function.
- **Over-optimizing.** Profile first, optimize second. The slow path is usually
  not where you think.
- **Ignoring UX.** A technically correct feature that's confusing to use is
  not done.
