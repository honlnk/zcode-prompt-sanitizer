// Test fixture for daemon mode: a plain-JS stand-in for the real CLI child.
// It listens on FIXTURE_PORT, reports readiness over IPC like the real daemon
// child, records its pid at FIXTURE_PIDFILE for the test to clean up, and
// exits on SIGTERM.
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.env.FIXTURE_PORT || 0);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('fixture ok');
});

server.listen(port, '127.0.0.1', () => {
  if (process.env.FIXTURE_PIDFILE) {
    writeFileSync(process.env.FIXTURE_PIDFILE, String(process.pid));
  }
  process.send?.({
    ok: true,
    banner: 'fixture banner\n',
    pid: process.pid,
    host: '127.0.0.1',
    port: server.address().port,
  });
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
