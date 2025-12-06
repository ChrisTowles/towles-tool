#!/usr/bin/env python3
"""
Bedrock API Timing Test
Times various stages of Bedrock API calls to diagnose performance issues.
"""

import argparse
import json
import time

import boto3
from rich.console import Console
from rich.table import Table

console = Console()


def time_operation(operation_name: str):
    """Decorator to time operations"""

    def decorator(func):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = func(*args, **kwargs)
            end = time.perf_counter()
            elapsed = end - start
            return result, elapsed

        return wrapper

    return decorator


@time_operation("client_initialization")
def initialize_client(region: str, profile: str = None):
    """Initialize Bedrock client"""
    session_kwargs = {}
    if profile:
        session_kwargs["profile_name"] = profile

    session = boto3.Session(**session_kwargs)
    client = session.client("bedrock-runtime", region_name=region)
    return client


@time_operation("api_call")
def invoke_model(client, model_id: str, prompt: str, max_tokens: int = 1000):
    """Invoke Bedrock model"""

    # Prepare request body based on model
    if "claude" in model_id:
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
    elif "titan" in model_id:
        body = {
            "inputText": prompt,
            "textGenerationConfig": {
                "maxTokenCount": max_tokens,
                "temperature": 0.7,
            },
        }
    else:
        # Generic format
        body = {"prompt": prompt, "max_tokens": max_tokens}

    response = client.invoke_model(
        modelId=model_id,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )

    return response


@time_operation("response_parsing")
def parse_response(response, model_id: str):
    """Parse response from Bedrock"""
    response_body = json.loads(response["body"].read())

    if "claude" in model_id:
        content = response_body.get("content", [{}])[0].get("text", "")
        input_tokens = response_body.get("usage", {}).get("input_tokens", 0)
        output_tokens = response_body.get("usage", {}).get("output_tokens", 0)
    elif "titan" in model_id:
        content = response_body.get("results", [{}])[0].get("outputText", "")
        input_tokens = response_body.get("inputTextTokenCount", 0)
        output_tokens = response_body.get("results", [{}])[0].get("tokenCount", 0)
    else:
        content = str(response_body)
        input_tokens = 0
        output_tokens = 0

    return content, input_tokens, output_tokens


def run_timing_test(
    model_id: str,
    prompt: str,
    region: str = "us-east-1",
    profile: str = None,
    max_tokens: int = 1000,
    iterations: int = 1,
):
    """Run complete timing test"""

    console.print("\n[bold cyan]Bedrock Timing Test[/bold cyan]")
    console.print(f"Model: {model_id}")
    console.print(f"Region: {region}")
    console.print(f"Iterations: {iterations}")
    console.print(f"Prompt length: {len(prompt)} chars\n")

    all_timings = []

    for i in range(iterations):
        if iterations > 1:
            console.print(f"[yellow]Iteration {i + 1}/{iterations}[/yellow]")

        timings = {}

        # Initialize client
        if i == 0:  # Only time initialization once
            client, init_time = initialize_client(region, profile)
            timings["client_init"] = init_time
            console.print(f"  Client initialization: {init_time * 1000:.2f}ms")

        # Make API call
        start_api = time.perf_counter()
        response, api_time = invoke_model(client, model_id, prompt, max_tokens)
        end_api = time.perf_counter()
        timings["api_call"] = api_time
        console.print(f"  API call: {api_time * 1000:.2f}ms")

        # Parse response
        (content, input_tokens, output_tokens), parse_time = parse_response(
            response, model_id
        )
        timings["response_parse"] = parse_time
        console.print(f"  Response parsing: {parse_time * 1000:.2f}ms")

        # Calculate totals
        timings["total_with_init"] = (
            timings.get("client_init", 0)
            + timings["api_call"]
            + timings["response_parse"]
        )
        timings["total_without_init"] = timings["api_call"] + timings["response_parse"]
        timings["input_tokens"] = input_tokens
        timings["output_tokens"] = output_tokens
        timings["response_length"] = len(content)

        console.print(
            f"  [bold]Total (with init): {timings['total_with_init'] * 1000:.2f}ms[/bold]"
        )
        console.print(
            f"  [bold]Total (without init): {timings['total_without_init'] * 1000:.2f}ms[/bold]"
        )
        console.print(f"  Input tokens: {input_tokens}, Output tokens: {output_tokens}")
        console.print(f"  Response length: {len(content)} chars\n")

        all_timings.append(timings)

        if iterations > 1 and i < iterations - 1:
            time.sleep(0.5)  # Small delay between iterations

    # Print summary
    if iterations > 1:
        print_summary(all_timings)

    return all_timings


def print_summary(all_timings: list):
    """Print summary statistics for multiple iterations"""
    console.print("\n[bold cyan]Summary Statistics[/bold cyan]")

    table = Table(show_header=True, header_style="bold magenta")
    table.add_column("Metric", style="cyan")
    table.add_column("Min (ms)", justify="right")
    table.add_column("Max (ms)", justify="right")
    table.add_column("Avg (ms)", justify="right")
    table.add_column("Median (ms)", justify="right")

    metrics = ["api_call", "response_parse", "total_without_init"]

    for metric in metrics:
        values = [t[metric] * 1000 for t in all_timings if metric in t]
        if values:
            values_sorted = sorted(values)
            min_val = min(values)
            max_val = max(values)
            avg_val = sum(values) / len(values)
            median_val = values_sorted[len(values_sorted) // 2]

            table.add_row(
                metric.replace("_", " ").title(),
                f"{min_val:.2f}",
                f"{max_val:.2f}",
                f"{avg_val:.2f}",
                f"{median_val:.2f}",
            )

    console.print(table)

    # Token statistics
    avg_input = sum(t["input_tokens"] for t in all_timings) / len(all_timings)
    avg_output = sum(t["output_tokens"] for t in all_timings) / len(all_timings)
    console.print(
        f"\nAverage tokens - Input: {avg_input:.0f}, Output: {avg_output:.0f}"
    )


def main():
    parser = argparse.ArgumentParser(
        description="Time Bedrock API calls to diagnose performance issues"
    )
    parser.add_argument(
        "--model",
        default="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        help="Bedrock model ID (default: Claude 3.5 Sonnet v2)",
    )
    parser.add_argument(
        "--prompt",
        default="Hello! Please respond with a short greeting.",
        help="Prompt to send (default: simple greeting)",
    )
    parser.add_argument(
        "--region", default="us-east-1", help="AWS region (default: us-east-1)"
    )
    parser.add_argument("--profile", help="AWS profile to use")
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=1000,
        help="Maximum tokens to generate (default: 1000)",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=1,
        help="Number of iterations to run (default: 1)",
    )

    args = parser.parse_args()

    try:
        run_timing_test(
            model_id=args.model,
            prompt=args.prompt,
            region=args.region,
            profile=args.profile,
            max_tokens=args.max_tokens,
            iterations=args.iterations,
        )
    except Exception as e:
        console.print(f"[bold red]Error:[/bold red] {str(e)}")
        import traceback

        console.print(traceback.format_exc())
        return 1

    return 0


if __name__ == "__main__":
    exit(main())