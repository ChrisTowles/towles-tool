# Releasing a new version

```bash
gh release create --generate-notes v0.*.*
```


## Setup

- Create an API Token on [PyPI](https://pypi.org/).
- Add the API Token to your projects secrets with the name `PYPI_TOKEN` by visiting [this page](https://github.com/ChrisTowles/towles-tool/settings/secrets/actions/new).
- Create a [new release](https://github.com/ChrisTowles/towles-tool/releases/new) on Github.
- Create a new tag in the form `*.*.*`.

The `.github/workflows/on-release-main.yml` workflow will automatically run and publish the new version to PyPI as well as the documentation to Github pages.


For more details, see [here](https://fpgmaas.github.io/cookiecutter-uv/features/cicd/#how-to-trigger-a-release).



### Commit the changes

To finalize the set-up for publishing to PyPI, see [here](https://fpgmaas.github.io/cookiecutter-uv/features/publishing/#set-up-for-pypi).
For activating the automatic documentation with MkDocs, see [here](https://fpgmaas.github.io/cookiecutter-uv/features/mkdocs/#enabling-the-documentation-on-github).
To enable the code coverage reports, see [here](https://fpgmaas.github.io/cookiecutter-uv/features/codecov/).
