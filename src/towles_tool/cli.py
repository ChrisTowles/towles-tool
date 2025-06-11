import logging
import os
import pathlib
from datetime import datetime, timedelta
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.prompt import Prompt
from rich.table import Table

from towles_tool.config import (
    create_config_file,
    get_cache_file_path,
    get_config_file_path,
    load_cache_file,
    load_config,
)

console = Console()

logger = logging.getLogger(__name__)

app = typer.Typer(
    name="towles-tool",
)


# Global state to hold options that can be used across commands
class State:
    """Global state to hold options that can be used across commands."""

    def __init__(self) -> None:
        self.verbose: bool = False


state = State()

# Note: Because we want to use the same option in multiple commands,  we can specify it once and reuse it.
# I tried serveral ways to do this was from https://github.com/fastapi/typer/issues/405#issuecomment-1555190792
# the final option was to follow the docs but that means --verbose and --config-file are only available
# in the main command, NOT in the subcommands.
verbose_option = Annotated[
    bool,
    typer.Option(
        "--verbose",
        "-v",
        help="Enable verbose mode. This will print additional information to the console.",
    ),
]


@app.command()
def setup(
    config_file: Annotated[
        Optional[str],
        typer.Option(
            "--config",
            "-c",
            help="Spectify config location.",
        ),
    ] = None,
    reset: Annotated[
        bool,
        typer.Option(
            "--reset",
            "-r",
            help="reset the config file to default. This will overwrite the existing config file.",
        ),
    ] = False,
) -> None:
    """Configure the tool with a config file."""

    console.log(f"Verbose mode: {state.verbose}")
    console.log(f"Config file: {config_file}")
    console.log(f"Reset config: {reset}")

    if config_file:
        # If a config file is specified, use it
        console.log(f"Using config file: {config_file}")
    if not config_file:
        console.log("No config file specified. prompting for default config file.")
        console.log(
            "   If you have location you backup your config files its recommended to specify file where it will be backed up.",
            style="bold yellow",
        )
        console.log("")
        default_config_file = get_config_file_path()  # get the default config file path
        config_file = Prompt.ask("Enter the path to the default config file:", default=default_config_file)
    # convert to absolute path
    config_file = str(pathlib.Path(config_file).expanduser().absolute())

    # if invalid path, fail
    if not os.path.exists(os.path.dirname(config_file)):
        console.log(
            f"Invalid config file path: {config_file}. The directory does not exist.",
            style="bold red",
        )
        raise typer.Exit(code=1)
    console.log(f"Using config file: {config_file}")

    cache_config = load_cache_file(create=True, config_file=config_file)

    # Here you would typically load a config file or create one if it doesn't exist

    # Load the default config file or create one

    # Load the config file
    config_content = create_config_file(cache_config.location_of_personal_config, reset=reset)
    console.log(f"Config loaded: {config_content}")


@app.command()
def doctor() -> None:
    """Check if the config file exists and other dependences"""

    console.log("Doctor Command")
    console.log(f"Verbose mode: {state.verbose}")

    console.log(f"Cache file: {get_cache_file_path()}")
    cache_file_contents = load_cache_file()
    console.log(f"Cache File: {cache_file_contents}")
    console.log(f"Config file: {get_config_file_path()}")
    config_file_contents = load_config()
    console.log(f"Config File: {config_file_contents}")


@app.command(
    help="create a markdown file to keep notes for the week in markdown file.",
    name="today",
)
def today() -> None:
    console.log("Today Command")

    config = load_config()

    if not os.path.exists(config.journal_base_folder_location):
        logger.warning(f"Journal base folder doesn't exists: {config.journal_base_folder_location}")
        console.log(
            "Creating the journal base folder. You can change this in the config file.",
            style="bold yellow",
        )
        os.makedirs(config.journal_base_folder_location, exist_ok=True)

    console.log(f"Journal base folder: {config.journal_base_folder_location}")

    today = datetime.now()
    # create year folder if it doesn't exist
    year_folder = os.path.join(config.journal_base_folder_location, str(today.year))
    if not os.path.exists(year_folder):
        console.log(f"Creating year folder: {year_folder}")
        os.makedirs(year_folder, exist_ok=True)
    console.log(f"Journal year folder: {year_folder}")

    # get the current date and the monday of the current week
    monday = today - timedelta(days=today.weekday())
    # create file name based on the current date
    file_name = f"{monday.strftime('%Y-%m-%d')}_week_notes.md"

    today_file_path = os.path.join(year_folder, file_name)

    if not os.path.exists(today_file_path):
        console.log(f"Creating today's file: {today_file_path}")
        with open(today_file_path, "w") as f:
            f.write(f"# Notes for the week starting {monday.strftime('%Y-%m-%d')}\n\n")
            f.write("## Monday\n\n")
            f.write("## Tuesday\n\n")
            f.write("## Wednesday\n\n")
            f.write("## Thursday\n\n")
            f.write("## Friday\n\n")
            f.write("## Saturday\n\n")
            f.write("## Sunday\n\n")

    console.log(f"Opening today's file: {today_file_path}")

    # Open the file in VS Code
    typer.launch(f"code {today_file_path}")


@app.command(
    help="print a rich table",
    name="table-test",
)
def tableTest() -> None:
    table = Table(title="Star Wars Movies")

    table.add_column("Released", justify="right", style="cyan", no_wrap=True)
    table.add_column("Title", style="magenta")
    table.add_column("Box Office", justify="right", style="green")

    table.add_row("Dec 20, 2019", "Star Wars: The Rise of Skywalker", "$952,110,690")
    table.add_row("May 25, 2018", "Solo: A Star Wars Story", "$393,151,347")
    table.add_row("Dec 15, 2017", "Star Wars Ep. V111: The Last Jedi", "$1,332,539,889")
    table.add_row("Dec 16, 2016", "Rogue One: A Star Wars Story", "$1,332,439,889")

    console.print(table)

    console.log("Today Command")
    console.log(f"Verbose mode: {state.verbose}")


@app.command()
def test01(
    username: Annotated[str, typer.Option(..., help="Fake Username to delete")] = "",
) -> None:
    """
    This command simulates the deletion of a user by printing a message.
    """
    if state.verbose:
        console.log(f"Fake: About to delete user: {username}")
    # Perform the delete operation
    console.log(f"Fake: User {username} deleted successfully.")


# not sure invoke_without_command does anything.
@app.callback(invoke_without_command=False)
def main(verbose: verbose_option = False) -> None:
    """
    Towles Tool CLI

    This is a command-line interface for a tool that provides various functionalities.
    """

    # Note: the values of the options are passed to the commands, when that happens,
    # the value of verbose_option and config_file only set when the "towles-tool --verbose today" and not
    #  "towles-tool today --verbose"

    state.verbose = verbose


if __name__ == "__main__":
    app()
