import typer
from rich.console import Console
from rich.table import Table

console = Console()

state = {"verbose": False, "config_file": None}


app = typer.Typer(
    name="towles-tool",
)


@app.command()
def doctor():
    """Check if the config file exists and other dependences"""

    console.log("Doctor Command")


@app.command()
def gfg(string: str = typer.Argument(..., help="""Prints input string""")):
    """Prints geeksforgeeks and input string"""
    print("@geeksforgeeks")
    print(string)


# @click.option(
#     "--daily",
#     "frequency",
#     flag_value="daily",
#     default=True,
#     help="Fetch the Top ML tweets for the past 24 hours.",
# )
# @click.option(
#     "--weekly",
#     "frequency",
#     flag_value="weekly",
#     help="Fetch the Top ML tweets for the past 7 days.",
# )
@app.command(help="Display a table of the top Star Wars movies released in the last 5 years.")
def today():
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
# You can input a default value like
# 'True' or 'False' instead of '...'
# in typer.Option() below.
def square(name, language: bool = typer.Option(..., prompt="Do You Want to print the language"), display: bool = False):
    print("@geeksforgeeks")

    if display == True:
        print(name)
    if language == True:
        print("Python 3.6+")


@app.callback(invoke_without_command=True)
def main(
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enables verbose mode"),
    config_file: str = typer.Option(None, "--config-file", "-c", help="Path to config file"),
):
    """
    collection of tools for machine learning engineers..
    """

    if verbose:
        print("Will write verbose output")
        state["verbose"] = True
    if config_file:
        state["config_file"] = config_file


if __name__ == "__main__":
    app()
