---
title: improve
description: "Explore codebase and suggest improvements"
allowed-tools: AskUserQuestion(*), Task(*), Read(*), Glob(*), Grep(*)
---

Explore codebase, identify improvements, present as selectable options.

## Phase 1: Explore

Use Task agents (`subagent_type=Explore`) to analyze:

- Code quality (duplication, complexity, dead code)
- Architecture (coupling, separation of concerns)
- Performance (obvious bottlenecks, inefficiencies)
- Developer experience (missing tests, unclear patterns)
- Security (exposed secrets, unsafe patterns)

## Phase 2: Identify

Find 15-20 concrete improvement opportunities.

Each improvement must be:

- **Actionable** - Not a nitpick, something that can be implemented
- **Specific** - Names files, functions, patterns
- **High-impact** - Prioritize low-effort wins
- **Verifiable** - Has clear success criteria

## Phase 3: Present

Use `AskUserQuestion` with:

- **question**: "Which improvements should I implement?"
- **multiSelect**: true
- **options**: 15-20 specific improvements with brief descriptions

After selection, confirm approach and begin implementation.

## FINAL STEP: Save Plan

Write PRD to `docs/plans/{YYYY}-{MM}-{DD}-{plan-goal}.md`

Then run `tt ralph add "${plan-file}"` to create a Ralph task for tracking.
