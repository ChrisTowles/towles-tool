---
description: Analyze codebase architecture for agent-friendliness and structural quality, then suggest improvements
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Agent(*)
---

Analyze codebase architecture for agent-friendliness and structural quality. Diagnose first, then present options — never start refactoring immediately.

$ARGUMENTS

## Process

### 1. Analyze

First analyze what the user described. If a codebase description is provided, diagnose from the description directly. Use `Agent` with `subagent_type=Explore` only when you need to examine actual files.

Look for these anti-patterns:

- **Scattered concepts** — features requiring many files to understand
- **Tight coupling** — modules that can't be tested or changed independently
- **Missing boundaries** — no clear interfaces between subsystems
- **Impure functions** — side effects mixed into business logic
- **God classes/objects** — classes doing too much, imported everywhere
- **Circular dependencies** — modules that import each other
- **Inconsistent patterns** — mixed error handling, logging, or data access approaches
- **Test gaps** — untested critical paths or no test boundaries
- **Large files** — files doing too much (>300 lines is a smell)

If the architecture is already well-structured, acknowledge that explicitly. Do not invent problems — only report real issues. A clean codebase should get fewer, more nuanced suggestions.

### 2. Diagnose

For each issue found, classify:

- **Impact**: How much does this hurt comprehension and AI agent collaboration?
- **Effort**: How hard is the fix? (small/medium/large)
- **Risk**: What could break?

Prioritize: high impact + low effort first. Explain why certain fixes should come before others — which changes unlock further improvements.

### 3. Present

Present 5-15 specific improvements (scaled to how many real issues exist), each with:

- Concrete problem description (not just "needs refactoring")
- Specific proposed fix with concrete patterns or approaches
- Affected areas
- Effort estimate (small/medium/large)

Do not include code snippets or code blocks — describe changes in plain language. The goal is diagnosis and options, not implementation.

Use `AskUserQuestion` with multiSelect so the user can choose which to pursue. Never start implementing without user selection.

### 4. Output

For selected improvements, ask preference: plan in `docs/plans/YYYY-MM-DD-architecture-improvements.md` or GitHub issues.

## Philosophy

> "If you have a garbage code base, the AI will produce garbage within that code base."

Focus on changes that make the codebase easier for both humans and AI agents to navigate:

- Larger, self-contained modules over many tiny scattered files
- Thin interfaces between modules
- Pure functions extracted from side-effectful code
- Co-located tests next to implementation
- Standardized patterns (error handling, logging, data access) across the codebase
- Incremental migration over big-bang rewrites
