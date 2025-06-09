import os
from typing import Optional

import appdirs
from rich.console import Console

console = Console()

# logger.remove(0) # remove the default handler configuration
# logger.add(sys.stdout, level="INFO", serialize=True)


def load_config(filename: Optional[str] = None) -> str:
    """Load config from the specified file and return the parsed config"""
    # Get a path to the file. If it was specified, it should be fine.
    # If it was not specified, assume it's config.ini in the script's dir.

    config_dir = appdirs.user_config_dir("towles-tool")
    console.log(f"Config dir: {config_dir}")

    if not filename:
        filename = os.path.join(config_dir, "towles_tool_config.yaml")

    if not os.path.isfile(filename):
        console.print(
            f"No config file! Make one in {filename} and find an example "
            "config at https://github.com/ChrisTowles/towles-tool/blob/main/towles_tool_config.yaml.example"
            "Alternatively, use --config-file FILE"
        )
        exit(1)
