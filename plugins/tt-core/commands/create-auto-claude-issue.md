---
description: Create a GitHub issue with the auto-claude label for AI-driven work
allowed-tools: Bash, AskUserQuestion
---

Create a GitHub issue in the current repository with the `auto-claude` label, designed for work that will be planned and/or implemented by Claude Code.

## Steps

1. **Determine the target repo** by running:

   ```
   gh repo view --json nameWithOwner --jq '.nameWithOwner'
   ```

2. **Fetch existing labels** from the repo:

   ```
   gh label list --repo <repo> --json name --jq '.[].name'
   ```

3. **Gather information** using AskUserQuestion. Ask up to 4 questions at a time:
   - **Title**: What should the issue title be?
   - **Description**: Describe what needs to be done.
   - **Extra Labels** (optional, multi-select): Additional labels to apply? Use the labels fetched from the repo as options (exclude `auto-claude` since it's always added).

4. **Create the issue** using `gh issue create`:
   - Always include the `auto-claude` label
   - Add any extra labels the user selected
   - Prefix the title with the conventional type (`feat:`, `fix:`, `refactor:`, `research:`, `chore:`)
   - Format the body with clear sections

   ```
   gh issue create --repo <repo> \
     --title "<type prefix>: <title>" \
     --label "auto-claude,<extra labels>" \
     --body "$(cat <<'EOF'
   ## Summary

   <description>

   ## Type

   <type>

   ## Notes

   This issue was created via Claude Code `/auto-claude` command.
   EOF
   )"
   ```

   If issue creation fails because the `auto-claude` label doesn't exist, create it and retry:

   ```
   gh label create "auto-claude" --repo <repo> --description "Issue created or worked by Claude Code" --color "7C3AED"
   ```

   Then re-run the `gh issue create` command.

5. **Support batch creation**: If the user provides multiple issues (e.g. a list of bullets), create all issues in parallel using separate `gh issue create` calls. Choose the appropriate conventional prefix and labels for each based on the title and description.

6. **Report back** with all issue URLs, ideally in a table format.

$ARGUMENTS
