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
5. Creates GitHub release
6. Publishes to npm
