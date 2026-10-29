"""Bounded OMP v1/v2 transport. This module never interprets model text as commands."""
import asyncio
import base64
import json
import os
import signal
import uuid

MAX_BYTES = 64 * 1024 * 1024


class FrameDecoder:
    def __init__(self):
        self.pending = None

    def push(self, frame):
        try:
            if not isinstance(frame, dict):
                raise ValueError('Invalid OMP frame')
            if frame.get('type') != 'rpc_chunk':
                if self.pending:
                    raise ValueError('Interrupted OMP chunk sequence')
                return frame
            key, index, count, size, data = (frame.get(k) for k in ('chunkId', 'index', 'count', 'byteLength', 'data'))
            if not isinstance(key, str) or not 0 < len(key) <= 128 or any(type(x) is not int for x in (index, count, size)):
                raise ValueError('Invalid OMP chunk header')
            if not 0 <= index < count or not 2 <= count <= 256 or not 1024*1024 <= size <= MAX_BYTES or not isinstance(data, str) or len(data) > 350000:
                raise ValueError('Invalid OMP chunk limits')
            decoded = base64.b64decode(data, validate=True)
            if not 0 < len(decoded) <= 256*1024 or base64.b64encode(decoded).decode() != data:
                raise ValueError('Invalid OMP chunk encoding')
            if self.pending is None:
                self.pending = [key, count, size, 0, bytearray()]
            p = self.pending
            if p[:3] != [key, count, size] or p[3] != index:
                raise ValueError('Out-of-order OMP chunk')
            p[3] += 1
            p[4].extend(decoded)
            if len(p[4]) > size:
                raise ValueError('OMP chunk overflow')
            if p[3] < count:
                return None
            if len(p[4]) != size:
                raise ValueError('Incomplete OMP chunk')
            value = json.loads(p[4].decode('utf-8'))
            if not isinstance(value, dict) or value.get('type') == 'rpc_chunk':
                raise ValueError('Invalid reassembled OMP frame')
            self.pending = None
            return value
        except Exception:
            self.pending = None
            raise


class Rpc:
    def __init__(self, process):
        self.process = process
        self.pending = {}
        self.events = asyncio.Queue(maxsize=1024)
        self.ready = asyncio.get_running_loop().create_future()
        self.reader = asyncio.create_task(self.read())

    @classmethod
    async def start(cls, args, env, child_setup=None):
        process = await asyncio.create_subprocess_exec(*args, env=env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=2*1024*1024, start_new_session=True, preexec_fn=child_setup)
        rpc = cls(process)
        try:
            ready = await asyncio.wait_for(asyncio.shield(rpc.ready), 35)
            if 2 in ready.get('supportedProtocolVersions', []):
                await rpc.request('negotiate_protocol', protocolVersion=2)
                await rpc.request('set_event_filter', events=None, messageUpdates='delta')
            return rpc
        except BaseException:
            await rpc.close()
            raise

    async def read(self):
        error = RuntimeError('OMP process exited')
        try:
            decoder = FrameDecoder()
            while line := await self.process.stdout.readline():
                event = decoder.push(json.loads(line))
                if event is None:
                    continue
                if event.get('type') == 'ready' and not self.ready.done():
                    self.ready.set_result(event)
                elif event.get('type') == 'response':
                    future = self.pending.get(event.get('id'))
                    if future and not future.done():
                        if event.get('success'):
                            future.set_result(event.get('data'))
                        else:
                            future.set_exception(RuntimeError(str(event.get('error', 'OMP request failed'))[:2000]))
                elif event.get('type') != 'message_update':
                    await self.events.put(event)
        except Exception as exc:
            error = exc
        finally:
            if not self.ready.done():
                self.ready.set_exception(error)
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)
            await self.events.put({'type': 'process_exit', 'error': str(error)[:2000]})

    async def send(self, frame):
        self.process.stdin.write((json.dumps(frame, ensure_ascii=False)+'\n').encode())
        await self.process.stdin.drain()

    async def request(self, kind, **data):
        key = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        try:
            await self.send(dict(data, type=kind, id=key))
            return await asyncio.wait_for(future, 45)
        finally:
            self.pending.pop(key, None)

    async def close(self):
        if self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
            except ProcessLookupError:
                pass
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)
