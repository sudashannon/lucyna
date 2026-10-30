"""Durable run intent and replayable, bounded event log (no credentials)."""
import json
import sqlite3
import time

TERMINAL = {'completed', 'cancelled', 'failed'}
BUSY = {'queued', 'starting', 'running', 'waiting_user', 'stopping', 'verifying'}


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
            root TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS one_work_writer ON runs(root)
            WHERE state NOT IN ('completed','cancelled','failed');
          CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS run_events ON events(run_id,seq);
          CREATE TABLE IF NOT EXISTS automation (root TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS automation_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        ''')

    def get(self, key):
        row = self.db.execute('SELECT data FROM runs WHERE id=?', (key,)).fetchone()
        if not row:
            raise ValueError('后台任务不存在')
        return json.loads(row[0])

    def by_request(self, key):
        row = self.db.execute('SELECT data FROM runs WHERE request_key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, root=None):
        rows = self.db.execute('SELECT data FROM runs'+(' WHERE root=?' if root else '')+' ORDER BY rowid DESC', (root,) if root else ())
        return [json.loads(row[0]) for row in rows]

    def save(self, run, event=None, new=False):
        run['updatedAt'] = time.time()
        with self.db:
            if new:
                self.db.execute('INSERT INTO runs VALUES (?,?,?,?,?)', (run['id'], run['requestKey'], run['root'], run['state'], json.dumps(run)))
            else:
                self.db.execute('UPDATE runs SET state=?,data=? WHERE id=?', (run['state'], json.dumps(run), run['id']))
            if event:
                self.db.execute('INSERT INTO events(run_id,data) VALUES (?,?)', (run['id'], json.dumps(dict(event, time=time.time()))))
                self.db.execute('DELETE FROM events WHERE run_id=? AND seq < COALESCE((SELECT seq FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1 OFFSET 999),0)', (run['id'], run['id']))

    def events(self, key, after=0):
        rows = self.db.execute('SELECT seq,data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 100', (key, after)).fetchall()
        first = self.db.execute('SELECT MIN(seq) FROM events WHERE run_id=?', (key,)).fetchone()[0]
        return {'events': [dict(json.loads(data), seq=seq) for seq, data in rows], 'firstSeq': first}

    def automation(self, root=None):
        rows = self.db.execute('SELECT data FROM automation'+(' WHERE root=?' if root else ''), (root,) if root else ())
        return [json.loads(row[0]) for row in rows]

    def save_automation(self, value):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO automation VALUES (?,?)', (value['root'], json.dumps(value)))

    def clients(self):
        return [json.loads(row[0]) for row in self.db.execute('SELECT data FROM automation_clients')]

    def save_client(self, value):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO automation_clients VALUES (?,?)', (value['id'], json.dumps(value)))
