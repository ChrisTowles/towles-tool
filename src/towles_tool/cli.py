import logging
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.table import Table

console = Console()

logger = logging.getLogger(__name__)

app = typer.Typer(
    name="towles-tool",
)

# Global state to hold options that can be used across commands
state = {
    "verbose": False,
    "config_file": None,
}

# Note: Because we want to use the same option in multiple commands,  we can specify it once and reuse it.
# I tried serveral ways to do this was from https://github.com/fastapi/typer/issues/405#issuecomment-1555190792
# the final option was to follow the docs but that means --verbose and --config-file are only available
# in the main command, NOT in the subcommands.
verbose_option = Annotated[
    Optional[bool],
    typer.Option(
        "--verbose",
        "-v",
        help="Enable verbose mode. This will print additional information to the console.",
    ),
]

config_file_option = Annotated[
    Optional[str],
    typer.Option(
        "--config",
        "-c",
        help="Spectify config location.",
    ),
]


@app.command()
def doctor() -> None:
    """Check if the config file exists and other dependences"""

    console.log("Doctor Command")


@app.command(help="Display a table of the top Star Wars movies released in the last 5 years.")
def today() -> None:
    table = Table(title="Star Wars Movies")

    table.add_column("Released", justify="right", style="cyan", no_wrap=True)
    table.add_column("Title", style="magenta")
    table.add_column("Box Office", justify="right", style="green")

    table.add_row("Dec 20, 2019", "Star Wars: The Rise of Skywalker", "$952,110,690")
    table.add_row("May 25, 2018", "Solo: A Star Wars Story", "$393,151,347")
    table.add_row("Dec 15, 2017", "Star Wars Ep. V111: The Last Jedi", "$1,332,539,889")
    table.add_row("Dec 16, 2016", "Rogue One: A Star Wars Story", "$1,332,439,889")

    console = Console()
    console.print(table)

    console.log("Today Command")
    console.log(f"Verbose mode: {state['verbose']}")
    console.log(f"Config file: {state['config_file']}")


@app.command()
def test01(
    username: Annotated[str, typer.Option(..., help="Fake Username to delete")] = "",
):
    """
    This command simulates the deletion of a user by printing a message.
    """
    if state["verbose"]:
        console.log(f"Fake: About to delete user: {username}")
    # Perform the delete operation
    console.log(f"Fake: User {username} deleted successfully.")


# not sure invoke_without_command does anything.
@app.callback(invoke_without_command=False)
def main(verbose: verbose_option = False, config_file: config_file_option = None) -> None:
    """
    Towles Tool CLI

    This is a command-line interface for a tool that provides various functionalities.
    """

    # Note: the values of the options are passed to the commands, when that happens,
    # the value of verbose_option and config_file only set when the "towles-tool --verbose today" and not
    #  "towles-tool today --verbose"

    state["verbose"] = verbose
    state["config_file"] = config_file


if __name__ == "__main__":
    app()
