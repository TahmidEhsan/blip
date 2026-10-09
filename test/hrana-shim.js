// Test helper: a small Hrana v2 server (the JSON-over-HTTP protocol Turso speaks) backed by node:sqlite,
// so the tests can drive Blip's remote database path (@libsql/client/web over HTTP) with no account.
// It is an emulation for tests only: every Hrana stream gets its own connection to one database file.
//
// `state.mode` switches the server between answering normally ('ok'), failing every request with
// HTTP 502 ('fail') and accepting requests without ever answering them ('hang'). `state.hangWhen`, a
// function of a request's SQL texts, leaves just the matching requests unanswered. `state.pipelines`
// counts answered HTTP round trips, `state.sql` lists every statement run, and `state.authorization`
// keeps the last Authorization header seen.
import http from 'node:http';
import { once } from 'node:events';

/** node:sqlite, or null on a Node build without it (the remote tests are skipped then). */
export async function loadNodeSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  }
}

/**
 * Start the server on an ephemeral port.
 * @param {{ file: string, sqlite: typeof import('node:sqlite') }} options
 * @returns {Promise<{ url: string, state: object, close: () => Promise<void> }>}
 */
export async function startHranaServer({ file, sqlite }) {
  const state = { mode: 'ok', hangWhen: null, pipelines: 0, sql: [], authorization: null };
  const streams = new Map();
  let nextBaton = 1;

  const openConnection = () => {
    const db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 2000');
    return { db, sqls: new Map() };
  };

  const toJs = (v) => {
    if (!v || v.type === 'null') return null;
    if (v.type === 'integer') return BigInt(v.value);
    if (v.type === 'float') return Number(v.value);
    if (v.type === 'text') return v.value;
    if (v.type === 'blob') return Buffer.from(v.base64, 'base64');
    throw new Error(`unknown value type ${v.type}`);
  };
  const fromJs = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
    if (typeof v === 'number') return { type: 'float', value: v };
    if (typeof v === 'string') return { type: 'text', value: v };
    return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  };

  function execute(conn, stmt) {
    let sql = stmt.sql ?? conn.sqls.get(stmt.sql_id);
    if (/^\s*BEGIN TRANSACTION READONLY\s*$/i.test(sql)) sql = 'BEGIN DEFERRED';
    state.sql.push(sql.replace(/\s+/g, ' ').trim());
    const prepared = conn.db.prepare(sql);
    prepared.setReadBigInts(true);
    const named = {};
    for (const { name, value } of stmt.named_args ?? []) named[name] = toJs(value);
    const positional = (stmt.args ?? []).map(toJs);
    const params = Object.keys(named).length ? [named, ...positional] : positional;
    const columns = prepared.columns();
    let rows = [];
    let affected = 0;
    let lastId = null;
    if (columns.length) {
      rows = prepared.all(...params).map((row) => columns.map((c) => fromJs(row[c.name])));
      if (!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
        const info = conn.db.prepare('SELECT changes() AS c, last_insert_rowid() AS r').get();
        affected = Number(info.c);
        lastId = String(info.r);
      }
    } else {
      const info = prepared.run(...params);
      affected = Number(info.changes);
      lastId = String(info.lastInsertRowid);
    }
    return {
      cols: columns.map((c) => ({ name: c.name, decltype: c.type ?? null })),
      rows,
      affected_row_count: affected,
      last_insert_rowid: lastId,
    };
  }

  // Like sqld: the SQLite message, and a code naming the error class.
  const errorOf = (err) => {
    const message = String(err?.message || err);
    return { message: `SQLite error: ${message}`, code: /constraint/i.test(message) ? 'SQLITE_CONSTRAINT' : 'SQLITE_ERROR' };
  };

  function condition(cond, results, errors) {
    if (!cond) return true;
    if (cond.type === 'ok') return results[cond.step] != null;
    if (cond.type === 'error') return errors[cond.step] != null;
    if (cond.type === 'not') return !condition(cond.cond, results, errors);
    if (cond.type === 'and') return cond.conds.every((c) => condition(c, results, errors));
    if (cond.type === 'or') return cond.conds.some((c) => condition(c, results, errors));
    throw new Error(`unknown condition ${cond.type}`);
  }

  function pipeline(body) {
    let baton = body.baton;
    const conn = baton && streams.has(baton) ? streams.get(baton) : openConnection();
    const results = [];
    let close = false;
    for (const request of body.requests) {
      try {
        if (request.type === 'execute') {
          results.push({ type: 'ok', response: { type: 'execute', result: execute(conn, request.stmt) } });
        } else if (request.type === 'batch') {
          const stepResults = [];
          const stepErrors = [];
          request.batch.steps.forEach((step, i) => {
            stepResults[i] = null;
            stepErrors[i] = null;
            if (!condition(step.condition, stepResults, stepErrors)) return;
            try {
              stepResults[i] = execute(conn, step.stmt);
            } catch (err) {
              stepErrors[i] = errorOf(err);
            }
          });
          results.push({ type: 'ok', response: { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } } });
        } else if (request.type === 'store_sql') {
          conn.sqls.set(request.sql_id, request.sql);
          results.push({ type: 'ok', response: { type: 'store_sql' } });
        } else if (request.type === 'close_sql') {
          conn.sqls.delete(request.sql_id);
          results.push({ type: 'ok', response: { type: 'close_sql' } });
        } else if (request.type === 'close') {
          close = true;
          results.push({ type: 'ok', response: { type: 'close' } });
        } else if (request.type === 'get_autocommit') {
          results.push({ type: 'ok', response: { type: 'get_autocommit', is_autocommit: !conn.db.isTransaction } });
        } else {
          throw new Error(`unsupported request ${request.type}`);
        }
      } catch (err) {
        results.push({ type: 'error', error: errorOf(err) });
      }
    }
    if (close) {
      try {
        if (conn.db.isTransaction) conn.db.exec('ROLLBACK');
      } catch {
        // nothing to roll back
      }
      conn.db.close();
      if (baton) streams.delete(baton);
      baton = null;
    } else {
      baton ||= `b${nextBaton++}`;
      streams.set(baton, conn);
    }
    return { baton, base_url: null, results };
  }

  const server = http.createServer((req, res) => {
    if (state.mode === 'hang') return; // accept and never answer
    if (state.mode === 'fail') {
      res.statusCode = 502;
      res.end('upstream unavailable');
      return;
    }
    if (req.method !== 'POST' || !/^\/v2\/pipeline\/?$/.test(req.url)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    state.authorization = req.headers.authorization ?? null;
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      let out;
      try {
        const body = JSON.parse(data);
        const texts = body.requests.flatMap((r) => (r.type === 'execute' ? [r.stmt.sql] : r.type === 'batch' ? r.batch.steps.map((step) => step.stmt.sql) : []));
        if (state.hangWhen?.(texts.filter(Boolean))) return; // never answered
        state.pipelines += 1;
        out = pipeline(body);
      } catch (err) {
        res.statusCode = 400;
        res.end(String(err?.message || err));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      for (const conn of streams.values()) {
        try {
          conn.db.close();
        } catch {
          // already closed
        }
      }
      streams.clear();
    },
  };
}
