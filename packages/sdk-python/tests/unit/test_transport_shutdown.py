from __future__ import annotations

import asyncio
import json
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar, cast

import pytest
from qwen_code_sdk.errors import ProcessExitError
from qwen_code_sdk.query import Query, query
from qwen_code_sdk.transport import ProcessTransport
from qwen_code_sdk.types import QueryOptions

SESSION_ID = "123e4567-e89b-12d3-a456-426614174000"
T = TypeVar("T")


class TrackingReader(asyncio.StreamReader):
    def __init__(self) -> None:
        super().__init__()
        self.active_reads = 0
        self.max_active_reads = 0
        self.readline_started = asyncio.Event()
        self.read_started = asyncio.Event()

    async def readline(self) -> bytes:
        self.active_reads += 1
        self.max_active_reads = max(self.max_active_reads, self.active_reads)
        self.readline_started.set()
        try:
            return await super().readline()
        finally:
            self.active_reads -= 1

    async def read(self, n: int = -1) -> bytes:
        self.active_reads += 1
        self.max_active_reads = max(self.max_active_reads, self.active_reads)
        self.read_started.set()
        try:
            return await super().read(n)
        finally:
            self.active_reads -= 1


class StreamProcess:
    def __init__(self, reader: TrackingReader, returncode: int | None = 0) -> None:
        self.stdin = None
        self.stderr = None
        self.stdout = reader
        self.returncode = returncode
        self.exit_event = asyncio.Event()
        if returncode is not None:
            self.exit_event.set()

    def terminate(self) -> None:
        self.stdout.feed_data(b'{"value":"during close"}\n')
        self.stdout.feed_eof()
        self.returncode = 0
        self.exit_event.set()

    def kill(self) -> None:
        self.terminate()

    async def wait(self) -> int:
        await self.exit_event.wait()
        assert self.returncode is not None
        return self.returncode


def transport_with_reader(
    returncode: int | None = 0,
) -> tuple[ProcessTransport, TrackingReader]:
    reader = TrackingReader()
    transport = ProcessTransport(QueryOptions())
    transport._process = cast(
        asyncio.subprocess.Process, StreamProcess(reader, returncode)
    )
    return transport, reader


async def wait_until(predicate: Callable[[], bool]) -> None:
    deadline = asyncio.get_running_loop().time() + 3
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("Timed out waiting for the fixture")
        await asyncio.sleep(0.01)


PEER_SOURCE = r"""
import json, os, signal, sys, time

sid = "123e4567-e89b-12d3-a456-426614174000"
message = {"type":"assistant", "session_id":sid, "uuid":sid,
           "parent_tool_use_id":None,
           "message":{"id":"message-1", "type":"message", "role":"assistant",
                      "model":"fixture", "content":[{"type":"text","text":""}],
                      "stop_reason":None, "stop_sequence":None,
                      "usage":{"input_tokens":0,"output_tokens":0}}}
empty = json.dumps(message, separators=(",",":")).encode() + b"\n"
message["message"]["content"][0]["text"] = "x" * (65536 - len(empty))
frame = json.dumps(message, separators=(",",":")).encode() + b"\n"
assert len(frame) == 65536

def write_frame(data):
    pending = memoryview(data)
    while pending:
        pending = pending[os.write(1, pending):]

if os.environ.get("QWEN_TEST_EXIT_AFTER_OUTPUT"):
    for _ in range(128):
        write_frame(frame)
    write_frame(empty)
    sys.exit(0)

def stop(signum, frame_info):
    for _ in range(int(os.environ["QWEN_TEST_FLUSH_COUNT"])):
        write_frame(frame)
    os._exit(0)

signal.signal(signal.SIGTERM, stop)
for raw in sys.stdin:
    incoming = json.loads(raw)
    if incoming.get("type") == "control_request":
        print(json.dumps({"type":"control_response","response":{
              "subtype":"success","request_id":incoming["request_id"],
              "response":{}}}), flush=True)
    elif incoming.get("type") == "user":
        ready = {"type":"system","subtype":"init","session_id":sid}
        print(json.dumps(ready), flush=True)
while True:
    time.sleep(60)
"""


@pytest.fixture
def shutdown_peer(tmp_path: Path) -> Path:
    peer = tmp_path / "shutdown_peer.py"
    peer.write_text(PEER_SOURCE, encoding="utf-8")
    return peer


async def reap_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.kill()
    if process.stdout is not None:
        await asyncio.wait_for(process.stdout.read(), timeout=3)
    await asyncio.wait_for(process.wait(), timeout=3)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX graceful SIGTERM fixture")
@pytest.mark.parametrize("frame_count", [1, 130])
@pytest.mark.asyncio
async def test_query_close_drains_graceful_shutdown_output(
    shutdown_peer: Path, frame_count: int
) -> None:
    result = query(
        "hello",
        {
            "path_to_qwen_executable": str(shutdown_peer),
            "env": {"QWEN_TEST_FLUSH_COUNT": str(frame_count)},
        },
    )
    process = None
    try:
        ready = await asyncio.wait_for(anext(result), timeout=3)
        assert ready["type"] == "system"
        process = result._transport._process
        assert process is not None and process.stdout is not None

        started = time.monotonic()
        await asyncio.wait_for(result.close(), timeout=8)

        assert time.monotonic() - started < 3
        assert process.returncode == 0
        assert process.stdout.at_eof()
    finally:
        if result._router_task is not None:
            result._router_task.cancel()
            await asyncio.gather(result._router_task, return_exceptions=True)
        if process is not None:
            await reap_process(process)


@pytest.mark.asyncio
async def test_close_drains_paused_stdout_after_process_has_exited(
    shutdown_peer: Path,
) -> None:
    transport = ProcessTransport(
        QueryOptions(
            path_to_qwen_executable=str(shutdown_peer),
            env={"QWEN_TEST_EXIT_AFTER_OUTPUT": "1"},
        )
    )
    await transport.start()
    process = transport._process
    assert process is not None and process.stdout is not None
    try:
        await wait_until(lambda: process.returncode is not None)
        assert process.returncode == 0
        assert not process.stdout.at_eof()

        await asyncio.wait_for(transport.close(), timeout=3)

        assert process.stdout.at_eof()
    finally:
        await reap_process(process)


@pytest.mark.asyncio
async def test_close_hands_off_an_active_readline_without_concurrent_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    transport, reader = transport_with_reader(returncode=None)
    messages = transport.read_messages()
    next_message = asyncio.create_task(anext(messages))
    try:
        await asyncio.wait_for(reader.readline_started.wait(), timeout=1)
        await asyncio.wait_for(transport.close(), timeout=1)

        with pytest.raises(StopAsyncIteration):
            await next_message
        assert reader.at_eof()
        assert reader.max_active_reads == 1
        assert reader.active_reads == 0
    finally:
        next_message.cancel()
        await asyncio.gather(next_message, return_exceptions=True)
        await messages.aclose()


@pytest.mark.asyncio
async def test_close_drains_while_message_iterator_is_paused_at_yield() -> None:
    transport, reader = transport_with_reader()
    reader.feed_data(b'{"value":1}\n{"value":2}\n')
    reader.feed_eof()
    messages = transport.read_messages()
    try:
        assert await anext(messages) == {"value": 1}
        await asyncio.wait_for(transport.close(), timeout=1)

        assert reader.at_eof()
        assert reader.max_active_reads == 1
        with pytest.raises(StopAsyncIteration):
            await anext(messages)
    finally:
        await messages.aclose()


@pytest.mark.asyncio
async def test_router_failure_closes_its_own_paused_transport_reader() -> None:
    transport, reader = transport_with_reader()
    result = Query(transport, QueryOptions(), "hello", SESSION_ID)
    reader.feed_data(b'{"type":"control_response","response":null}\n{"value":2}\n')
    reader.feed_eof()

    result._router_task = asyncio.create_task(result._message_router())
    await asyncio.wait_for(result._router_task, timeout=1)

    error = await result._message_queue.get()
    assert isinstance(error, TypeError)
    assert result.is_closed()
    assert reader.at_eof()
    assert reader.max_active_reads == 1


@pytest.mark.asyncio
async def test_cancelling_close_releases_the_shutdown_reader() -> None:
    transport, reader = transport_with_reader()
    closing = asyncio.create_task(transport.close())
    try:
        await asyncio.wait_for(reader.read_started.wait(), timeout=1)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing

        assert reader.active_reads == 0
        assert reader._waiter is None
    finally:
        reader.feed_eof()
        closing.cancel()
        await asyncio.gather(closing, return_exceptions=True)


@pytest.mark.asyncio
async def test_close_bounds_the_stdout_join_after_process_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_wait_for = asyncio.wait_for
    deadlines: list[float | None] = []

    async def short_wait(awaitable: Awaitable[T], timeout: float | None) -> T:
        deadlines.append(timeout)
        assert timeout == 5.0
        return await real_wait_for(awaitable, timeout=0.01)

    monkeypatch.setattr(asyncio, "wait_for", short_wait)
    transport, reader = transport_with_reader()
    try:
        with pytest.raises(asyncio.TimeoutError):
            await real_wait_for(transport.close(), timeout=1)

        assert deadlines == [5.0]
        assert reader.active_reads == 0
        assert reader._waiter is None
    finally:
        reader.feed_eof()


@pytest.mark.parametrize("returncode", [0, 7])
@pytest.mark.asyncio
async def test_live_reader_preserves_messages_and_process_exit_status(
    returncode: int,
) -> None:
    transport, reader = transport_with_reader(returncode=returncode)
    payloads = [{"value": "first"}, {"value": "second"}]
    reader.feed_data("".join(json.dumps(item) + "\n" for item in payloads).encode())
    reader.feed_eof()

    received = [message async for message in transport.read_messages()]
    await transport.close()

    assert received == payloads
    assert reader.at_eof()
    assert reader.max_active_reads == 1
    if returncode:
        assert isinstance(transport.exit_error, ProcessExitError)
        assert transport.exit_error.exit_code == returncode
    else:
        assert transport.exit_error is None
