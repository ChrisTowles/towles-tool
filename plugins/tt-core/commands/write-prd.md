---
description: Transform a conversation or idea into a structured PRD with user stories
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Bash(git *)
---

Create a Product Requirements Document from the current conversation or a provided description.

$ARGUMENTS

## Process

1. **Gather context first** — ALWAYS ask 3-5 clarifying questions BEFORE writing any PRD content. Never skip this step, even if the idea seems detailed. Do NOT output any PRD sections (Problem Statement, Goals, User Stories, Technical Design, etc.) until you have gathered answers.
2. **What to ask about** — Your questions MUST cover these areas:
   - **Users**: Who are the target users/personas?
   - **Scope & non-goals**: What is explicitly in scope and out of scope? What should we NOT build?
   - **Success criteria**: How do we know this is done? What are measurable acceptance criteria?
   - **Technical specifics**: What APIs, libraries, services, or integrations are involved? What are the technical constraints?
   - **Current state**: What exists today? What is the current workflow or system?
3. **Draft the PRD** — Only after receiving answers, draft using the template below.
4. **Present for review** — Show draft, ask for feedback via `AskUserQuestion`.
5. **Output** — Ask preference: save to `docs/plans/YYYY-MM-DD-<feature-name>.md` or create as GitHub issue.

## PRD Template

```markdown
# [Feature Name]

## Problem Statement

What problem does this solve? Who has this problem?

## Goals

- Goal 1
- Goal 2

## Non-Goals

- Explicitly out of scope

## User Stories

- As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- [ ] Criterion 1 (specific and testable)
- [ ] Criterion 2

## Technical Design

### Architecture

How this fits into the existing system.

### API / Interface

Public-facing contracts.

## Open Questions

- Anything unresolved
```

## Rules

- **Questions first, always** — Your first response must be clarifying questions, never a PRD draft. Do not output headings like "## Problem Statement", "## Technical Design", "## User Stories", etc. until you have the user's answers.
- User stories are mandatory — every feature must map to at least one. Use "As a [user], I want [action] so that [outcome]" format.
- Acceptance Criteria section is mandatory — list specific, testable criteria (not "works well"). Write these BEFORE Technical Design.
- Reference existing code paths when relevant.
- Keep it concise — PRD should be 1-3 pages, not a novel.
