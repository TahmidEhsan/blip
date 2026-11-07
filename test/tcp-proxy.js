// Test helper: a TCP proxy in front of the test MongoDB, so the tests can make the database fail the way a
// real one does. `setMode('ok')` forwards everything, `setMode('hang')` stops forwarding on every connection
// (like a stalled database: sockets stay open and nothing answers; 'ok' lets the data through again), and
// `setMode('reset')` drops every connection and refuses new ones (like a network failure).
import net from 'node:net';
import { once } from 'node:events';

function connect(pair) {
  pair.client.pipe(pair.upstream);
  pair.upstream.pipe(pair.client);
}

function disconnect(pair) {
  pair.client.unpipe(pair.upstream);
  pair.upstream.unpipe(pair.client);
  pair.client.pause();
  pair.upstream.pause();
}

/**
 * @param {string} uri the MongoDB to forward to (`mongodb://host:port/...`)
 * @returns {Promise<{ uri: string, port: number, setMode: (mode: 'ok'|'hang'|'reset') => void, close: () => Promise<void> }>} `uri`
 *   connects through the proxy (directly to that one member: a replica set would hand out its real address)
 */
export async function startTcpProxy(uri) {
  const { hostname, port: targetPort } = new URL(uri);
  const pairs = new Set();
  let mode = 'ok';

  const server = net.createServer((client) => {
    client.on('error', () => {});
    if (mode === 'reset') {
      client.destroy();
      return;
    }
    const upstream = net.connect(Number(targetPort), hostname);
    upstream.on('error', () => {});
    const pair = { client, upstream };
    pairs.add(pair);
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', drop);
    upstream.on('close', drop);
    if (mode === 'ok') connect(pair);
    else disconnect(pair);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    port,
    uri: `mongodb://127.0.0.1:${port}/?directConnection=true`,
    setMode(next) {
      mode = next;
      for (const pair of pairs) {
        if (next === 'reset') {
          pair.client.destroy();
          pair.upstream.destroy();
        } else if (next === 'hang') {
          disconnect(pair);
        } else {
          connect(pair);
        }
      }
    },
    async close() {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}
