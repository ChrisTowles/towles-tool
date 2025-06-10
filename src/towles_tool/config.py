import os
from typing import Optional

import platformdirs
import yaml
from pydantic import BaseModel
from rich.console import Console

console = Console()

# logger.remove(0) # remove the default handler configuration
# logger.add(sys.stdout, level="INFO", serialize=True)


# Models
class ConfigFileContents(BaseModel):
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
        default_config = ConfigFileContents(location_of_personal_config=config_file_name)
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

    config_file_path = get_config_file_path(filename)

    if not os.path.isfile(config_file_path):
        console.print(
            f"No config file! Make one in {config_file_path} and find an example "
            "config at https://github.com/ChrisTowles/towles-tool/blob/main/towles_tool_config.yaml.example"
            "Alternatively, use --config-file FILE"
        )
        exit(1)

    console.log(f"Loading config from {config_file_path}")
    # Here you would load the config file, e.g. using PyYAML or similar
    # For now, just return the filename

    # Read and validate the config file using Pydantic and YAML
    with open(config_file_path) as f:
        config_data = yaml.safe_load(f)
        config = ConfigFileContents(**config_data)

    return config
