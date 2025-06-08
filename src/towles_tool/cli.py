import typer

app = typer.Typer()
# from sliceofml.api import API

# from sliceofml.apikey import (
#     read_credentials,
#     prompt_api_details,
#     request_access_token,
#     write_netrc,
# )
# from sliceofml.config import TWITTER_API
# from sliceofml.display import Display


@app.command()
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
def today():
    """Create the Weekly scratch file"""
    print("Create the Weekly scratch file")


def main():
    app()


if __name__ == "__main__":
    app()
