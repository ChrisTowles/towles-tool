from typer.testing import CliRunner

from towles_tool.cli import app

runner = CliRunner()


def test_main():
    result = runner.invoke(app, "today")
    assert result.exit_code == 0
    assert "Star Wars Movies" in result.output


def test_command_test01():
    result = runner.invoke(app, ["test01", "--username", "testuser"])
    assert result.exit_code == 0
    assert "Fake: About to delete user: testuser" not in result.output
    assert "Fake: User testuser deleted successfully." in result.output


def test_command_test01_verbose():
    result = runner.invoke(app, ["--verbose", "test01", "--username", "testuser"])
    assert result.exit_code == 0
    assert "Fake: About to delete user: testuser" in result.output
    assert "Fake: User testuser deleted successfully." in result.output


def test_command_test01_verbose_wrong_order():
    # this should fail because the --verbose option is not recognized when at the end of the command
    result = runner.invoke(app, ["test01", "--username", "testuser", "--verbose"])
    assert result.exit_code == 2
    assert "No such option: --verbose" in result.output


def test_command_test01_verbose_short():
    result = runner.invoke(app, ["-v", "test01", "--username", "testuser"])
    assert result.exit_code == 0
    assert result.exit_code == 0
    assert "Fake: About to delete user: testuser" in result.output
    assert "Fake: User testuser deleted successfully." in result.output


# def test_verbose_short_3_condensed():
#     result = runner.invoke(app, ["-hv"])
#     assert result.exit_code == 2
#     assert "Verbose level is 3" in result.output
