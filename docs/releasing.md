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
7. Publishes to npm
