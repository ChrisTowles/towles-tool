---
description: Analyze codebase architecture for agent-friendliness and structural quality, then suggest improvements
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Agent(*)
---

Analyze codebase architecture for agent-friendliness and structural quality.

$ARGUMENTS

## Process

### 1. Explore
Use `Agent` with `subagent_type=Explore` to analyze:

- **Scattered concepts** — features that require navigating many files to understand
- **Tight coupling** — modules that can't be tested or changed independently
- **Missing boundaries** — no clear interfaces between subsystems
- **Impure functions** — side effects mixed into business logic
- **Test gaps** — untested critical paths or integration points
- **Large files** — files doing too much (>300 lines is a smell)

### 2. Diagnose

For each issue found, classify:
- **Impact**: How much does this hurt comprehension and AI collaboration?
- **Effort**: How hard is the fix?
- **Risk**: What could break?

Prioritize: high impact + low effort first.

### 3. Present

`AskUserQuestion` with multiSelect: 10-15 specific improvements, each with problem, affected files, proposed fix, and effort estimate (small/medium/large).

### 4. Output

For selected improvements, ask preference: plan in `docs/plans/YYYY-MM-DD-architecture-improvements.md` or GitHub issues.

## Philosophy

> "If you have a garbage code base, the AI will produce garbage within that code base."

Focus on changes that make the codebase easier for both humans and AI agents to navigate:
- Larger, self-contained modules over many tiny scattered files
- Thin interfaces between modules
- Pure functions extracted from side-effectful code
- Co-located tests next to implementation
