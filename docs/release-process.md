# Release Process

This document describes how releases are managed for the towles-tool project.

## Release Workflow

The project uses an automated release process triggered by git tags. Here's how it works:

### 1. Manual Release Process

To create a new release:

1. **Run the release command**:
   ```bash
   pnpm release
   ```
   This command:
   - Uses `bumpp` to increment the version in `package.json`
   - Creates a git commit with the version bump
   - Creates a git tag (e.g., `v0.0.7`)
   - Pushes the tag to GitHub

2. **GitHub Actions takes over**:
   - The tag push triggers the `.github/workflows/release.yml` workflow

### 2. Automated Release Workflow

When a tag starting with `v*` is pushed, the GitHub Actions workflow:

1. **Generates changelog** using `changelogithub`
2. **Publishes to npm**:
   - Runs `pnpm install`
   - Publishes with `pnpm publish --no-git-checks -r --access public`
   - Uses provenance for enhanced security

## Release History Pattern

Based on recent commits, the release pattern follows:
- Version bumps: `v0.0.4` → `v0.0.5` → `v0.0.6`
- Commit messages: `chore: release v{version}`

## Best Practices

1. **Review changes** - Check git status before running release commands
2. **Test before releasing** - Run `pnpm test` and `pnpm build` locally  
3. **Use semantic versioning** - The project follows semver conventions
