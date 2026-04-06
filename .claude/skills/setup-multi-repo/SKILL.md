---
name: setup-multi-repo
description: "Set up a multi-clone repo folder structure with a primary clone and 5 slot clones for parallel Claude Code agent work. Use when the user says 'set up multi-repo', 'setup slots', 'create repo slots', or wants to create the same folder pattern used for towles-tool-repos."
user_invocable: true
---

# Setup Multi-Repo Folder Structure

Create a parent directory containing a `-primary` clone and 5 `-slot-N` clones of the same
GitHub repo. This pattern supports running multiple Claude Code agents in parallel, each in
its own isolated working copy.

## Structure

```
~/code/p/<name>-repos/
  <name>-primary/     # Main working copy
  <name>-slot-1/      # Agent slot 1
  <name>-slot-2/      # Agent slot 2
  <name>-slot-3/      # Agent slot 3
  <name>-slot-4/      # Agent slot 4
  <name>-slot-5/      # Agent slot 5
```

## Steps

1. Ask the user for:
   - The GitHub repo URL (e.g., `https://github.com/ChrisTowles/blog.git`)
   - The short name to use for the folder/clones (e.g., `blog`)
   - The parent directory (default: `~/code/p/`)

2. Create the parent directory:

   ```bash
   mkdir -p ~/code/p/<name>-repos
   ```

3. Clone primary:

   ```bash
   cd ~/code/p/<name>-repos
   git clone <repo-url> <name>-primary
   ```

4. Clone 5 slots:

   ```bash
   for i in 1 2 3 4 5; do
     git clone <repo-url> "<name>-slot-$i"
   done
   ```

5. Verify the structure:
   ```bash
   ls -la ~/code/p/<name>-repos/
   ```

## Example

For the blog repo:

```bash
mkdir -p ~/code/p/blog-repos
cd ~/code/p/blog-repos
git clone https://github.com/ChrisTowles/blog.git blog-primary
for i in 1 2 3 4 5; do
  git clone https://github.com/ChrisTowles/blog.git "blog-slot-$i"
done
```

## Notes

- Each slot is a fully independent git clone (not a worktree) so agents can freely switch branches
- The `-primary` clone is for manual/primary development work
- Slot clones are managed by the agentboard system in towles-tool
- If the repo already has a standalone clone (e.g., `~/code/p/blog`), consider removing it after migration
