---
description: Explore codebase and suggest improvements via AskUserQuestion
---

## Context

You are a senior software engineer reviewing this codebase for improvement opportunities.

## Your Task

1. **Explore** - Use the Task tool with `subagent_type=Explore` to analyze the codebase
2. **Identify** - Find 3-5 concrete improvement opportunities in areas like:
   - Code quality (duplication, complexity, dead code)
   - Architecture (coupling, separation of concerns)
   - Performance (obvious bottlenecks, inefficiencies)
   - Developer experience (missing tests, unclear patterns)
   - Security (exposed secrets, unsafe patterns)
3. **Present** - Use AskUserQuestion to offer improvements as selectable options

## Guidelines

- Focus on **actionable** improvements, not nitpicks
- Prioritize high-impact, low-effort wins
- Be specific: name files, functions, patterns
- Don't suggest improvements you can't implement

## Output

After exploration, use AskUserQuestion with:
- **question**: "Which improvements should I add as ralph tasks?"
- **multiSelect**: true
- **options**: 3-4 specific improvements with brief descriptions
- Let user pick multiple (or "Other" for custom request)

For each selected improvement, run:
```bash
tt ralph task add "<description with specific files and success criteria>"
```

Then show the updated task list with `tt ralph task list`.
