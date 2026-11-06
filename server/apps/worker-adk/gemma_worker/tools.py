import os
from typing import Any

import httpx


def _call_daemon(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    socket_path = os.getenv("BATON_WORKER_SOCKET")
    if not socket_path:
        return {"error": "BATON_WORKER_SOCKET is unavailable"}

    transport = httpx.HTTPTransport(uds=socket_path)
    try:
        with httpx.Client(transport=transport, base_url="http://baton-worker", timeout=600) as client:
            response = client.post("/tool", json={"tool": tool, "args": args})
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as error:
        return {"error": f"BATON worker tool failed: {error}"}

    if not isinstance(result, dict):
        return {"error": "BATON worker returned an invalid tool response"}
    return result


def baton_get_task() -> dict[str, Any]:
    """Get this worker's assigned BATON task, current milestone, and recovered accepted outputs."""
    return _call_daemon("baton_get_task", {})


def baton_smoke_nonce() -> dict[str, Any]:
    """Return a one-time nonce for the worker runtime connection self-test."""
    return _call_daemon("baton_smoke_nonce", {})


def workspace_list_files() -> dict[str, Any]:
    """List files inside this worker's assigned workspace."""
    return _call_daemon("workspace_list_files", {})


def workspace_read_file(path: str) -> dict[str, Any]:
    """Read a UTF-8 text file inside the assigned workspace using a relative path."""
    return _call_daemon("workspace_read_file", {"path": path})


def workspace_write_file(path: str, content: str) -> dict[str, Any]:
    """Create or replace a UTF-8 text file inside the assigned workspace using a relative path."""
    return _call_daemon("workspace_write_file", {"path": path, "content": content})


def baton_submit_milestone(
    milestone: int,
    summary: str,
    completed_steps: list[str],
    unfinished_steps: list[str],
    files: list[str],
    decisions: list[str] | None = None,
) -> dict[str, Any]:
    """Save a checkpoint and submit the current milestone for buyer review."""
    return _call_daemon(
        "baton_submit_milestone",
        {
            "milestone": milestone,
            "summary": summary,
            "completedSteps": completed_steps,
            "unfinishedSteps": unfinished_steps,
            "files": files,
            "decisions": decisions or [],
        },
    )
