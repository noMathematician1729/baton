import os

from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm

from .tools import (
    baton_get_task,
    baton_smoke_nonce,
    baton_submit_milestone,
    workspace_list_files,
    workspace_read_file,
    workspace_write_file,
)


worker_name = os.getenv("BATON_WORKER_ID", "local").replace("-", "_")

root_agent = LlmAgent(
    name=f"baton_{worker_name}_gemma_worker",
    model=LiteLlm(model=os.getenv("BATON_ADK_MODEL", "ollama_chat/gemma4:e4b")),
    description="A Gemma worker that completes one BATON milestone at a time.",
    instruction=(
        "You are a BATON worker. Work only through the provided baton and workspace tools. "
        "Never request, read, print, or store credentials, private keys, or files outside the "
        "assigned workspace. Fetch the task before doing job work. Read the required inputs, "
        "write the milestone outputs, and submit exactly the current milestone with accurate "
        "completed and unfinished steps. If a tool returns an error, correct the issue and retry."
    ),
    tools=[
        baton_get_task,
        workspace_list_files,
        workspace_read_file,
        workspace_write_file,
        baton_submit_milestone,
        baton_smoke_nonce,
    ],
)
