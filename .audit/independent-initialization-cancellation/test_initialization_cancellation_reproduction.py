from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
import qwen_code_sdk
from qwen_code_sdk import Query, QueryOptions, SDKUserMessage, TimeoutOptions
from test_query_core import FakeTransport, _wait_for_request


class DelayedInitializeTransport(FakeTransport):
    """Hold only initialize; reply successfully to each later control request."""

    def write(self, data: str) -> None:
        super().write(data)
        request = self.writes[-1]
        if request.get("type") != "control_request":
            return
        subtype = request["request"]["subtype"]
        if subtype == "initialize":
            return
        self.push(
            {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request["request_id"],
                    "response": {"answered": subtype},
                },
            }
        )


def outcome(task: asyncio.Task[Any]) -> Any:
    if not task.done():
        return "still pending"
    if task.cancelled():
        return "CancelledError"
    error = task.exception()
    return type(error).__name__ + ": " + str(error) if error else task.result()


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt_kind", ["single", "stream"])
@pytest.mark.parametrize("cancel_waiter", [False, True])
async def test_one_cancelled_waiter_does_not_cancel_other_callers_or_input(
    prompt_kind: str, cancel_waiter: bool
) -> None:
    session_id = "123e4567-e89b-12d3-a456-426614174000"

    async def input_messages() -> AsyncIterator[SDKUserMessage]:
        yield {
            "type": "user",
            "session_id": session_id,
            "message": {"role": "user", "content": "independent prompt"},
            "parent_tool_use_id": None,
        }

    transport = DelayedInitializeTransport()
    result = Query(
        transport=transport,  # type: ignore[arg-type]
        options=QueryOptions(timeout=TimeoutOptions(control_request=2.0)),
        prompt="independent prompt" if prompt_kind == "single" else input_messages(),
        session_id=session_id,
    )
    calls = [asyncio.create_task(result.supported_commands())]
    try:
        init = await _wait_for_request(transport, "initialize")
        independent = asyncio.create_task(result.mcp_server_status())
        calls.append(independent)
        # Both public calls and the automatic input task now wait on the withheld response.
        await asyncio.sleep(0)
        assert not calls[0].done() and not independent.done()

        if cancel_waiter:
            calls[0].cancel()
            await asyncio.gather(calls[0], return_exceptions=True)

        transport.push(
            {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": init["request_id"],
                    "response": {},
                },
            }
        )
        # asyncio.wait bounds the observation without cancelling the independent call.
        await asyncio.wait(calls, timeout=1.0)
        later = asyncio.create_task(result.get_available_models())
        calls.append(later)
        await asyncio.wait([later], timeout=1.0)
        await asyncio.sleep(0)

        observation = {
            "source_module": qwen_code_sdk.__file__,
            "prompt_kind": prompt_kind,
            "cancel_requested_for_supported_commands_only": cancel_waiter,
            "initialize_success_reply_delivered": True,
            "supported_commands_outcome": outcome(calls[0]),
            "independent_mcp_server_status_outcome": outcome(independent),
            "later_get_available_models_outcome": outcome(later),
            "user_messages_written": sum(m.get("type") == "user" for m in transport.writes),
            "input_task_cancelled": result._input_task.cancelled() if result._input_task else None,
            "query_closed_before_cleanup": result.is_closed(),
            "transport_closed_before_cleanup": transport.closed,
            "control_requests_sent": [
                m["request"]["subtype"] for m in transport.writes if m.get("type") == "control_request"
            ],
        }
        print(json.dumps(observation), flush=True)
        assert outcome(independent) == {"answered": "mcp_server_status"}, observation
        assert outcome(later) == {"answered": "get_available_models"}, observation
        assert observation["user_messages_written"] == 1, observation
        assert not result.is_closed() and not transport.closed, observation
        assert outcome(calls[0]) == (
            "CancelledError" if cancel_waiter else {"answered": "supported_commands"}
        ), observation
    finally:
        for task in calls:
            if not task.done():
                task.cancel()
        await asyncio.gather(*calls, return_exceptions=True)
        await result.close()
