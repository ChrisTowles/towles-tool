---
title: plan
description: "Interview user and create implementation plan"
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Task(*)
---

Interview user, research codebase, create a structured implementation plan.

## Phase 1: Inquire

If not provided, ask user for initial target or goal they want to achieve.

## Phase 2: Research

Use Task agents (`subagent_type=Explore`) to:

- Find relevant files, patterns, conventions
- Understand existing architecture
- Identify dependencies and conflicts
- Gather context for implementation

## Phase 3: Interview

Use `AskUserQuestion` to gather details about:

- Technical implementation requirements
- UI & UX considerations
- Concerns and tradeoffs
- Edge cases

Ask non-obvious questions. Continue until requirements are clear (3-7 questions typically).

## Phase 4: Plan

Based on interview + research, design implementation as ordered tasks.

Each task must have:

- **Clear completion criteria** - How does Claude know it's done?
- **Verifiable success** - Tests pass, typecheck passes
- **Single responsibility** - One focused outcome
- **Self-contained context** - References specific files/patterns

Task template:

```
[Imperative description]

Context:
- Files: [specific paths to modify]
- Patterns: [reference existing code]

Success Criteria:
- [ ] [Specific outcome]
- [ ] Tests pass
- [ ] Types pass
```

## Phase 5: Present

Present the plan to user with:

1. Brief summary of approach
2. Mermaid diagram showing task dependencies
3. Numbered task list with descriptions

Use `AskUserQuestion` to confirm or adjust before implementation.

## FINAL STEP: Save Plan

Write PRD to `docs/plans/{YYYY}-{MM}-{DD}-{plan-goal}.md`

Then run `tt ralph plan "${plan-file}"` to create a Ralph task for tracking.
