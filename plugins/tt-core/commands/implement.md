---
title: implement
description: "Implement the plan from the spec file"
allowed-tools: Read(*), Write(*), Edit(*), Bash(*), Task(*), TodoWrite(*)
---

<instruction>
Execute implementation plan from spec file, step by step.

1. **Find plan**: Check `.current-plan` for task path, or ask user
2. **Read plan**: Load `{task-path}/plan.md`
3. **Create todos**: Add each plan step to TodoWrite for tracking
4. **Execute**: For each step:
   - Use Task agents (`subagent_type=Explore`) to understand relevant code
   - Implement the requirement
   - Run verification (tests, typecheck)
   - Mark todo complete before moving on
</instruction>

<constraints>
- Never skip verification steps
- Complete one step fully before starting next
- If step fails verification, fix before proceeding
</constraints>

<output_format>
For each step:
1. Announce which step you're starting
2. Confirm step complete or explain blocker
</output_format>
