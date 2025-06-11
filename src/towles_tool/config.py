import logging
import os
import pathlib
from typing import Optional

import platformdirs
import yaml
from pydantic import BaseModel
from rich.console import Console
from rich.prompt import Prompt

console = Console()

logger = logging.getLogger(__name__)


# Models
class ConfigFileContents(BaseModel):
    journal_base_folder_location: str


# Cache file is used to store the location of the personal config file
class ConfigCacheFileContents(BaseModel):
    location_of_personal_config: str


def create_config_file(filename: Optional[str] = None, reset: bool = False) -> ConfigFileContents:
    """Create the config directory if it doesn't exist."""
    config_file_name = get_config_file_path(filename)

    if reset and os.path.exists(config_file_name):
        console.log(f"Resetting config file at {config_file_name}")
        os.remove(config_file_name)

    if not os.path.exists(config_file_name):
        console.log(f"Creating config file at {config_file_name}")
        os.makedirs(os.path.dirname(config_file_name), exist_ok=True)

        # Create a default config using the Pydantic model

        journal_base_dir = Prompt.ask(
            "Enter the base folder location for your journal files",
            default=os.path.join(platformdirs.user_data_dir("towles-tool"), "journals"),
        )

        # convert to absolute path
        journal_base_dir = str(pathlib.Path(journal_base_dir).expanduser().absolute())
        if not os.path.exists(journal_base_dir):
            console.log(
                f"Creating journal base folder at {journal_base_dir}",
                style="bold yellow",
            )
            os.makedirs(journal_base_dir, exist_ok=True)

        default_config = ConfigFileContents(journal_base_folder_location=journal_base_dir)
        # Write the config to file using YAML
        with open(config_file_name, "w") as f:
            yaml.dump(default_config.model_dump(), f)

        console.log(f"Config file created at {config_file_name}")
    else:
        console.log(f"Config file already exists at {config_file_name}")

    return load_config(config_file_name)


def get_config_file_path(filename: Optional[str] = None) -> str:
    """Get the path to the config file."""
    # If a filename is provided, use it; otherwise, use the default config file name
    config_dir = platformdirs.user_config_dir("towles-tool")
    if not filename:
        filename = os.path.join(config_dir, "towles_tool_config.yaml")

    else:
        # Ensure the filename is absolute or relative to the config directory
        if not os.path.isabs(filename):
            filename = os.path.join(config_dir, filename)

    return filename


def load_config(filename: Optional[str] = None) -> ConfigFileContents:
    """Load config from the specified file and return the parsed config"""
    # Get a path to the file. If it was specified, it should be fine.
    # If it was not specified, assume it's config.ini in the script's dir.

    cache_file = load_cache_file()

    if not os.path.isfile(cache_file.location_of_personal_config):
        console.print(
            f"No config file! Make one in {cache_file.location_of_personal_config} and find an example "
            "config at https://github.com/ChrisTowles/towles-tool/blob/main/towles_tool_config.yaml.example"
            "Alternatively, use --config-file FILE"
        )
        exit(1)

    console.log(f"Loading config from {cache_file.location_of_personal_config}")
    # Here you would load the config file, e.g. using PyYAML or similar
    # For now, just return the filename

    # Read and validate the config file using Pydantic and YAML
    with open(cache_file.location_of_personal_config) as f:
        config_data = yaml.safe_load(f)
        config = ConfigFileContents(**config_data)

    return config


def get_cache_file_path() -> str:
    cache_file_name = "towles_tool_cache.yaml"
    config_dir = platformdirs.user_config_dir("towles-tool")
    cache_file_path = os.path.join(config_dir, cache_file_name)

    return cache_file_path


def load_cache_file(
    create: bool = False, reset: bool = False, config_file: Optional[str] = None
) -> ConfigCacheFileContents:
    """Load cache from the specified file and return the parsed cache"""

    cache_file_path = get_cache_file_path()

    # normal call, but not with create
    if not create and not os.path.isfile(cache_file_path):
        logger.warning(
            f"""No cache file exists at {cache_file_path}! We make one by running
`towles-tool setup` or `tt setup` command.
            """
        )
        exit(1)

    # if create and reset and file exists, remove it
    if create and reset and os.path.exists(cache_file_path):
        logger.info(f"Resetting cache file at {cache_file_path}")
        os.remove(cache_file_path)

    # if create and file does not exist, create it
    if create and not os.path.exists(cache_file_path):
        logger.info(f"Creating cache file at {cache_file_path}")

        # If a config file is specified, use it; otherwise, use the default config file name
        if not config_file:
            config_file = get_config_file_path()

        os.makedirs(os.path.dirname(cache_file_path), exist_ok=True)

        # Create a default cache using the Pydantic model
        default_cache = ConfigCacheFileContents(location_of_personal_config=config_file)
        # Write the cache to file using YAML
        with open(cache_file_path, "w") as f:
            yaml.dump(default_cache.model_dump(), f)

        logger.info(f"Cache file created at {cache_file_path}")

    # Here you would load the config file, e.g. using PyYAML or similar
    # For now, just return the filename

    # Read and validate the config file using Pydantic and YAML

    with open(cache_file_path) as f:
        config_cache_yaml = yaml.safe_load(f)
        config_cache = ConfigCacheFileContents(**config_cache_yaml)

    return config_cache
