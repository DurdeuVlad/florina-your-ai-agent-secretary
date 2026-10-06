/**
 * Test fixture for DaemonRunner.startDetached (issue #323).
 *
 * Spawned as `node detach-fake-daemon.cjs start`. Binds the TCP port in
 * FLORINA_TEST_PORT, writes its own pid to FLORINA_TEST_PIDFILE (mirroring
 * what the real child does via runner.start()), and stays alive until
 * SIGTERM — enough for the runner's pidfile-readiness probe. With
 * FLORINA_TEST_FAIL=1 it exits immediately, simulating a startup crash.
 */
'use strict';
const fs = require('node:fs');
const net = require('node:net');

if (process.env.FLORINA_TEST_FAIL === '1') {
  process.stderr.write('fake daemon: deliberate startup failure\n');
  process.exit(2);
}

const port = Number(process.env.FLORINA_TEST_PORT);
const pidFile = process.env.FLORINA_TEST_PIDFILE;
const server = net.createServer(() => {});
server.listen(port, '127.0.0.1', () => {
  // The real child writes its pidfile only after the daemon binds.
  if (pidFile) {
    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  }
  process.stdout.write(`fake daemon listening on ${port}\n`);
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
