import asyncio
import json
import logging
import os
import sys
import uuid
from typing import Any

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from gemma_worker.agent import root_agent


async def run(prompt: str) -> dict[str, Any]:
    worker_id = os.getenv("BATON_WORKER_ID", "worker")
    app_name = "baton_worker"
    user_id = worker_id.replace("-", "_")
    session_service = InMemorySessionService()
    session = await session_service.create_session(app_name=app_name, user_id=user_id)
    runner = Runner(agent=root_agent, app_name=app_name, session_service=session_service)
    tool_calls: list[dict[str, str]] = []
    pending_calls: dict[str, list[int]] = {}
    final_message = ""

    async for event in runner.run_async(
        user_id=user_id,
        session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part(text=prompt)]),
    ):
        content = event.content
        if not content or not content.parts:
            continue
        for part in content.parts:
            if part.function_call and part.function_call.name:
                name = part.function_call.name
                pending_calls.setdefault(name, []).append(len(tool_calls))
                tool_calls.append({"tool": name, "status": "running"})
            if part.function_response and part.function_response.name:
                name = part.function_response.name
                indexes = pending_calls.get(name, [])
                if indexes:
                    index = indexes.pop(0)
                    response = part.function_response.response or {}
                    tool_calls[index]["status"] = "error" if isinstance(response, dict) and response.get("error") else "completed"
        if event.is_final_response():
            final_message = "\n".join(part.text for part in content.parts if part.text)

    return {
        "turnId": str(uuid.uuid4()),
        "status": "completed",
        "finalMessage": final_message,
        "toolCalls": tool_calls,
    }


def main() -> int:
    logging.basicConfig(stream=sys.stderr, level=os.getenv("BATON_ADK_LOG_LEVEL", "WARNING"))
    try:
        request = json.load(sys.stdin)
        result = asyncio.run(run(str(request["prompt"])))
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:  # The parent worker records the concise failure in its log.
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
