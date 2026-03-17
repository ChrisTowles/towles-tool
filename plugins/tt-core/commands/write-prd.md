---
description: Transform a conversation or idea into a structured PRD with user stories
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Bash(git *)
---

Create a Product Requirements Document from the current conversation or provided description.

$ARGUMENTS

## Process

1. **Gather context first** — ALWAYS ask 3-5 clarifying questions BEFORE writing any PRD. Never skip this step. Do NOT output PRD sections until you have answers.
2. **What to ask about**:
   - **Users**: Target users/personas?
   - **Scope & non-goals**: What's in/out of scope?
   - **Success criteria**: Measurable acceptance criteria?
   - **Technical specifics**: APIs, libraries, constraints?
   - **Current state**: What exists today?
3. **Draft the PRD** — Only after receiving answers, use template below.
4. **Present for review** — Show draft, get feedback via `AskUserQuestion`.
5. **Output** — Ask preference: save to `docs/plans/YYYY-MM-DD-<feature-name>.md` or GitHub issue.

## PRD Template

```markdown
# [Feature Name]

## Problem Statement
What problem does this solve? Who has it?

## Goals
- Goal 1

## Non-Goals
- Explicitly out of scope

## User Stories
- As a [user], I want [action] so that [outcome]

## Acceptance Criteria
- [ ] Criterion 1 (specific and testable)

## Technical Design

### Architecture
How this fits into the existing system.

### API / Interface
Public-facing contracts.

## Open Questions
- Anything unresolved
```

## Rules

- **Questions first, always** — First response must be clarifying questions, never a PRD draft.
- User stories are mandatory — every feature maps to at least one. Use "As a [user], I want [action] so that [outcome]" format.
- Acceptance Criteria section is mandatory — list specific, testable criteria. Write BEFORE Technical Design.
- Reference existing code paths when relevant.
- Keep it concise — 1-3 pages, not a novel.
