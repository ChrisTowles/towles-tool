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
   - The workflow runs automatically on `ubuntu-latest`

### 2. Automated Release Workflow

When a tag starting with `v*` is pushed, the GitHub Actions workflow:

1. **Checks out the code** with full history (`fetch-depth: 0`)
2. **Sets up the environment**:
   - Installs pnpm
   - Sets up Node.js LTS with npm registry configuration
3. **Generates changelog** using `changelogithub`
4. **Publishes to npm**:
   - Runs `pnpm install`
   - Publishes with `pnpm publish --no-git-checks -r --access public`
   - Uses provenance for enhanced security

### 3. Local Development Release

For local testing, you can use:
```bash
pnpm release:local
```
This bypasses the GitHub Actions workflow and publishes directly.

## Release History Pattern

Based on recent commits, the release pattern follows:
- Version bumps: `v0.0.4` → `v0.0.5` → `v0.0.6`
- Commit messages: `chore: release v{version}`
- Each release includes necessary workflow improvements

## Configuration

### Package.json Scripts
- `release`: Automated release via GitHub Actions
- `release:local`: Direct local release
- `prepublishOnly`: Ensures build runs before publishing

### GitHub Actions Permissions
- `id-token: write` - For npm provenance
- `contents: write` - For creating releases and changelogs

### Secrets Required
- `GITHUB_TOKEN` - For changelog generation
- `NPM_TOKEN` - For npm publishing

## Best Practices

1. **Never use `--no-verify`** - Pre-commit hooks ensure code quality
2. **Test before releasing** - Run `pnpm test` and `pnpm build` locally
3. **Use semantic versioning** - The project follows semver conventions
4. **Review changes** - Check git status before running release commands
