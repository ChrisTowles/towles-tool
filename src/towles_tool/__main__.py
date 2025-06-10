from .cli import app

# This is the entry point for the CLI application.

# the reason is you want both
#
# python -m towles_tool --help -v
# python -m towles_tool today
# python -m towles_tool --help --verbose
# towles-tool --help
# tt --help --verbose


# CONTENTS of pyproject.toml
# ------
# [project.scripts]
# towles-tool = "towles_tool.__main__:__main__"
# tt = "towles_tool.__main__:__main__"
# -----


app()
