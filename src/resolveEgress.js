const dns = require('dns');
const net = require('net');
const {
  internalRanges,
  allowedInternalHosts,
  blockedHosts,
  hostResolverRules,
} = require('./config');

// Addresses no page gets the service to connect to. IPv4: this network, private, carrier-grade
// NAT, loopback, link-local (the cloud metadata service), benchmarking, multicast and reserved;
// IPv4-mapped IPv6 addresses match these too. IPv6: unspecified, loopback and IPv4-compatible,
// NAT64, 6to4, unique local, link-local and multicast. The configured ranges are our VPCs, which
// use public address space.
const internal = new net.BlockList();
[
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4',
  '::/96', '64:ff9b::/96', '64:ff9b:1::/48', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8',
  ...internalRanges,
].forEach((range) => {
  const [address, prefix] = range.split('/');
  internal.addSubnet(address, Number(prefix), `ipv${net.isIP(address)}`);
});

// An exact host, or `*.example.com` for the hosts under example.com.
const matches = (patterns, host) =>
  patterns.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern,
  );

// The MAP rules in HOST_RESOLVER_RULES, local development's way to reach the Docker host
// (`MAP *.publitas.localhost host.docker.internal`). Chrome hands every name to the egress proxy
// unresolved, so the rules apply here instead, and a host they map may be internal: the mapping
// is the operator's own routing. Patterns are a hostname or `*.domain`, as above; a pattern that
// is an IP address is ignored, as the proxy connects to an IP literal without resolving it.
const mappings = (hostResolverRules || '')
  .split(',')
  .map((rule) => rule.trim().split(/\s+/))
  .filter(([verb, pattern, target]) => verb === 'MAP' && target && !net.isIP(pattern));

// The addresses the service may connect to for a host (a URL's hostname, or a name or address
// Chrome asks the egress proxy for), or why it may not; {} when there is no host, and the lookup's
// error code as `unresolved` when it does not resolve. A host with any internal address is
// refused, so a name cannot pair a public address with an internal one, unless it is an allowed
// internal host. Callers connect to exactly the addresses answered: a second lookup could answer
// differently (DNS rebinding).
module.exports = async (hostname) => {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '');
  if (!host) return {};
  if (matches(blockedHosts, host)) return {refused: 'is blocked'};
  const [, , target] = mappings.find(([, pattern]) => matches([pattern], host)) || [];
  let addresses;
  try {
    addresses = await dns.promises.lookup(target || host, {all: true});
  } catch (err) {
    return {unresolved: err.code};
  }
  if (target || matches(allowedInternalHosts, host)) return {addresses};
  return addresses.some(({address, family}) => internal.check(address, `ipv${family}`))
    ? {refused: 'resolves to an internal address'}
    : {addresses};
};
