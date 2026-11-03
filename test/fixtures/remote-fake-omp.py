#!/usr/bin/python3
"""Deterministic native-RPC fixture, no model or network access."""
import base64
import json
from pathlib import Path
import sys
import threading
import time
import uuid

root = Path(sys.argv[sys.argv.index('--cwd')+1])
folder = Path(sys.argv[sys.argv.index('--session-dir')+1])
if '--resume' in sys.argv:
    journal = Path(sys.argv[sys.argv.index('--resume')+1])
    native_id = json.loads(journal.read_text().splitlines()[0])['id']
else:
    native_id = uuid.uuid4().hex
    journal = folder/(native_id+'.jsonl')
    journal.write_text(json.dumps(dict(type='session', id=native_id, cwd=str(root)))+'\n')
lock = threading.Lock()
messages = [json.loads(line)['message'] for line in journal.read_text().splitlines()[1:] if json.loads(line).get('type') == 'message']
settled = True


def emit(value):
    data = json.dumps(value, separators=(',', ':')).encode()
    with lock:
        if len(data) > 1024*1024:
            chunks = [data[i:i+256*1024] for i in range(0, len(data), 256*1024)]
            key = uuid.uuid4().hex
            for i, chunk in enumerate(chunks):
                print(json.dumps(dict(type='rpc_chunk', chunkId=key, index=i, count=len(chunks),
                                      byteLength=len(data), data=base64.b64encode(chunk).decode())), flush=True)
        else:
            print(data.decode(), flush=True)


emit(dict(type='ready', supportedProtocolVersions=[1, 2]))

def append_message(role, text):
    message = dict(id=uuid.uuid4().hex, role=role, content=[dict(type='text', text=text)], timestamp=int(time.time()*1000))
    messages.append(message)
    with journal.open('a') as stream:
        stream.write(json.dumps(dict(type='message', message=message))+'\n')
    if role == 'user':
        emit(dict(type='message_start', messageId=message['id'], message=message))
    emit(dict(type='message_end', messageId=message['id'], message=message))

def finish(text):
    global settled
    append_message('assistant', text)
    settled = True
    emit(dict(type='prompt_result', status='completed', sessionSettled=True))
    emit(dict(type='session_settled'))

for line in sys.stdin:
    frame = json.loads(line)
    kind = frame['type']
    data = {}
    if kind == 'get_state':
        data = dict(sessionId=native_id, sessionFile=str(journal), cwd=str(root), isSettled=settled, model=dict(id='fixture', name='隔离验收模型'),
                    promptCount=len((root/'prompts.txt').read_text().splitlines()) if (root/'prompts.txt').exists() else 0)
    elif kind == 'get_messages':
        data = dict(messages=['x'*(1200*1024)])
    elif kind == 'get_messages_page':
        data = dict(messages=list(messages), totalMessages=len(messages))
    elif kind == 'get_available_commands':
        data = dict(commands=[])
    elif kind == 'get_subagents':
        data = dict(subagents=[dict(id='fixture-child', status='running')])
    elif kind == 'cancel_subagent':
        with (root/'cancellations.txt').open('a') as stream:
            stream.write(frame['subagentId']+'\n')
        data = dict(cancelled=True)
    elif kind == 'get_available_models':
        data = dict(models=[])
    elif kind == 'prompt':
        settled = False
        append_message('user', frame.get('message', ''))
        emit(dict(type='agent_start'))
        with (root/'prompts.txt').open('a') as stream:
            stream.write(frame.get('message', '')+'\n')
        if frame.get('message') == 'question':
            emit(dict(type='extension_ui_request', id='question-one', method='input', title='Fixture question'))
        else:
            def later(text=frame.get('message', '')):
                time.sleep(.15)
                emit(dict(type='message_update', marker='after-disconnect'))
                finish('远端已完成：'+text)
            threading.Thread(target=later, daemon=True).start()
        if frame.get('message') == 'lost-ack':
            time.sleep(.3)
    elif kind == 'extension_ui_response':
        (root/'answer.txt').write_text(frame['id']+':'+frame.get('value', ''))
        finish('已收到你的回复')
        continue
    elif kind == 'abort_and_restore_queue':
        settled = True
        data = dict(steering=[], followUp=[])
        emit(dict(type='session_settled'))
    emit(dict(type='response', id=frame.get('id'), command=kind, success=True, data=data))
