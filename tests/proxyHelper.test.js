const test = require('node:test');
const assert = require('node:assert/strict');

test('proxyHelper: parseProxyString parses standard URL formats', async () => {
  const { parseProxyString } = await import('../src/collector/proxyHelper.js');

  const p1 = parseProxyString('http://admin:pass123@103.153.22.10:8080');
  assert.equal(p1.protocol, 'http');
  assert.equal(p1.host, '103.153.22.10');
  assert.equal(p1.port, 8080);
  assert.equal(p1.username, 'admin');
  assert.equal(p1.password, 'pass123');
  assert.equal(p1.normalized_url, 'http://admin:pass123@103.153.22.10:8080');

  const p2 = parseProxyString('socks5://user:secret@127.0.0.1:1080');
  assert.equal(p2.protocol, 'socks5');
  assert.equal(p2.host, '127.0.0.1');
  assert.equal(p2.port, 1080);
});

test('proxyHelper: parseProxyString parses residential ip:port:user:pass format', async () => {
  const { parseProxyString } = await import('../src/collector/proxyHelper.js');

  const p = parseProxyString('14.225.205.100:9999:customer45:secretPass');
  assert.equal(p.protocol, 'http');
  assert.equal(p.host, '14.225.205.100');
  assert.equal(p.port, 9999);
  assert.equal(p.username, 'customer45');
  assert.equal(p.password, 'secretPass');
  assert.equal(p.normalized_url, 'http://customer45:secretPass@14.225.205.100:9999');
});

test('proxyHelper: parseProxyString parses ip:port format without credentials', async () => {
  const { parseProxyString } = await import('../src/collector/proxyHelper.js');

  const p = parseProxyString('103.56.12.34:3128');
  assert.equal(p.protocol, 'http');
  assert.equal(p.host, '103.56.12.34');
  assert.equal(p.port, 3128);
  assert.equal(p.username, null);
  assert.equal(p.password, null);
  assert.equal(p.normalized_url, 'http://103.56.12.34:3128');
});

test('proxyHelper: parseBatchProxies deduplicates and ignores invalid lines', async () => {
  const { parseBatchProxies } = await import('../src/collector/proxyHelper.js');

  const input = `
    14.225.205.100:9999:user1:pass1
    # comment line
    invalid string here
    14.225.205.100:9999:user1:pass1
    http://user2:pass2@103.153.22.10:8080
    socks5://user3:pass3@103.153.22.11:1080
  `;

  const parsed = parseBatchProxies(input);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].username, 'user1');
  assert.equal(parsed[1].username, 'user2');
  assert.equal(parsed[2].protocol, 'socks5');
});
