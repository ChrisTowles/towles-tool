# Releasing

## Automated Release

Trigger via GitHub Actions:

```bash
gh workflow run release.yml -f bump_type=patch  # or minor/major
gh run watch  # monitor progress
```

The workflow:
1. Runs CI (lint, typecheck, test)
2. Bumps version in package.json
3. Syncs plugin versions
4. Commits and tags
5. Builds executables for Linux and macOS
6. Creates GitHub release with assets

## Manual Release Commands

If you need to create a release manually:

```bash
# Create release with assets
gh release create v0.0.30 \
  --generate-notes \
  dist/tt-linux-x64 \
  dist/tt-darwin-arm64

# Upload assets to existing release
gh release upload v0.0.30 dist/tt-linux-x64 dist/tt-darwin-arm64

# View release
gh release view v0.0.30

# List releases
gh release list

# Delete release (if needed)
gh release delete v0.0.30 --yes
```

## Recovering from Failed Workflow

If the workflow fails after builds complete:

```bash
# Download artifacts from failed run
gh run download <run-id> --dir /tmp/release-assets

# Upload to release manually
gh release upload v<version> \
  /tmp/release-assets/tt-linux-x64/tt-linux-x64 \
  /tmp/release-assets/tt-darwin-arm64/tt-darwin-arm64
```
