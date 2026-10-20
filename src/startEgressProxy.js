const net = require('net');
const logger = require('./logger');
const resolveEgress = require('./resolveEgress');
const {egressAttemptMs} = require('./config');

// SOCKS5 replies (RFC 1928): succeeded, connection not allowed by ruleset, host unreachable.
const reply = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
const SUCCEEDED = reply(0);
const NOT_ALLOWED = reply(2);
const UNREACHABLE = reply(4);

// Where a CONNECT request (VER CMD RSV ATYP DST.ADDR DST.PORT) wants to go, or undefined for
// anything else. Chrome sends every destination as a name (address type 3), IP literals
// included, so nothing else is accepted.
const destination = (request) => {
  const end = 5 + request[4];
  if (request[0] !== 5 || request[1] !== 1 || request[3] !== 3 || !(request.length >= end + 2)) {
    return undefined;
  }
  return {host: request.subarray(5, end).toString(), port: request.readUInt16BE(end)};
};

// Connects only where resolveEgress allows, and only to the addresses it checked: Node calls the
// lookup below instead of resolving the name again, and skips it for an IP literal, which is
// what was checked.
const connect = async (client, request) => {
  const target = destination(request);
  if (!target) {
    client.destroy();
    return;
  }
  const {host, port} = target;
  const {refused, unresolved, addresses} = await resolveEgress(host);
  if (client.destroyed) return; // Chrome gave up during the lookup
  if (refused) {
    logger.warn('Egress refused', {host, port, reason: refused});
    client.end(NOT_ALLOWED);
    return;
  }
  if (!addresses) {
    logger.warn('Egress failed', {host, port, reason: unresolved});
    client.end(UNREACHABLE);
    return;
  }
  const upstream = net.connect({
    host,
    port,
    lookup: (_name, options, callback) =>
      options.all
        ? callback(null, addresses)
        : callback(null, addresses[0].address, addresses[0].family),
    // Node moves on from an address after 250 ms when another follows, and in an IPv4-only pod
    // the AAAA records it moves on to fail at once: a slow handshake would leave nothing to try.
    autoSelectFamilyAttemptTimeout: egressAttemptMs,
    noDelay: true,
  });
  let connected = false;
  upstream.once('connect', () => {
    connected = true;
    client.write(SUCCEEDED);
    client.pipe(upstream).pipe(client);
  });
  upstream.on('error', (err) => {
    if (connected) return client.destroy();
    logger.warn('Egress failed', {host, port, reason: err.code});
    client.end(UNREACHABLE);
  });
  client.on('close', () => upstream.destroy());
};

// One SOCKS5 session per connection Chrome opens: it offers its authentication methods, the
// proxy picks none, and Chrome asks to CONNECT.
// Each SOCKS message is taken from a single read, which is how Chrome writes them over
// loopback; buffer them if anything else is ever pointed at this proxy.
const serve = (client) => {
  client.on('error', () => client.destroy());
  client.once('data', (greeting) => {
    if (greeting[0] !== 5) {
      client.destroy();
      return;
    }
    client.write(Buffer.from([5, 0]));
    client.once('data', (request) => {
      client.pause(); // nothing may be lost before the tunnel's pipe takes over
      connect(client, request).catch((err) => {
        logger.error(err);
        client.destroy();
      });
    });
  });
};

// Starts the egress proxy on a free loopback port and resolves with its URL. Unreferenced, so it
// never keeps an otherwise finished process alive. Both ends of a tunnel send small writes at
// once, as Chrome's own sockets do, instead of holding them back for Nagle's algorithm.
module.exports = () =>
  new Promise((resolve, reject) => {
    const server = net
      .createServer({noDelay: true}, serve)
      .unref()
      .on('error', (err) => (server.listening ? logger.error(err) : reject(err)));
    server.listen(0, '127.0.0.1', () => resolve(`socks5://127.0.0.1:${server.address().port}`));
  });
