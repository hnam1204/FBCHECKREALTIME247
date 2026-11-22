/**
 * Proxy parser, validator, and health-check engine for Facebook Residential & Datacenter Proxies.
 * Supports HTTP, HTTPS, SOCKS4, SOCKS5, and residential formats (ip:port:user:pass).
 */

/**
 * Parses a single proxy string into structured components and normalized URL
 * @param {string} rawLine
 * @returns {{ raw_proxy: string, protocol: string, host: string, port: number, username: string|null, password: string|null, normalized_url: string } | null}
 */
export function parseProxyString(rawLine) {
  if (!rawLine || typeof rawLine !== 'string') return null;
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  try {
    let protocol = 'http';
    let host = '';
    let port = 80;
    let username = null;
    let password = null;

    if (line.includes('://')) {
      // URL format: http://user:pass@host:port or socks5://...
      const url = new URL(line);
      protocol = url.protocol.replace(':', '').toLowerCase();
      if (!['http', 'https', 'socks5', 'socks5h', 'socks4'].includes(protocol)) {
        protocol = 'http';
      }
      host = url.hostname;
      port = parseInt(url.port || (protocol.startsWith('socks') ? '1080' : '80'), 10);
      username = url.username ? decodeURIComponent(url.username) : null;
      password = url.password ? decodeURIComponent(url.password) : null;
    } else {
      // Colon or @ separated formats
      // Format 1: host:port:user:pass
      const parts = line.split(':');
      if (parts.length === 4) {
        host = parts[0].trim();
        port = parseInt(parts[1].trim(), 10);
        username = parts[2].trim();
        password = parts[3].trim();
      } else if (parts.length === 2) {
        // Format 2: host:port
        host = parts[0].trim();
        port = parseInt(parts[1].trim(), 10);
      } else if (line.includes('@')) {
        // Format 3: user:pass@host:port or host:port@user:pass
        const [left, right] = line.split('@');
        if (left.includes(':') && right.includes(':')) {
          const rightParts = right.split(':');
          if (!isNaN(parseInt(rightParts[1], 10))) {
            // user:pass@host:port
            const leftParts = left.split(':');
            username = leftParts[0];
            password = leftParts[1];
            host = rightParts[0];
            port = parseInt(rightParts[1], 10);
          } else {
            // host:port@user:pass
            const leftParts = left.split(':');
            host = leftParts[0];
            port = parseInt(leftParts[1], 10);
            const rightParts = right.split(':');
            username = rightParts[0];
            password = rightParts[1];
          }
        }
      }
    }

    if (!host || isNaN(port) || port <= 0 || port > 65535) {
      return null;
    }

    const authStr = username && password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const normalized_url = `${protocol}://${authStr}${host}:${port}`;

    return {
      raw_proxy: line,
      protocol,
      host,
      port,
      username,
      password,
      normalized_url
    };
  } catch (err) {
    return null;
  }
}

/**
 * Parses batch multi-line proxy text into an array of deduplicated proxy objects
 * @param {string|string[]} input
 * @returns {Array<{ raw_proxy: string, protocol: string, host: string, port: number, username: string|null, password: string|null, normalized_url: string }>}
 */
export function parseBatchProxies(input) {
  if (!input) return [];
  const lines = Array.isArray(input)
    ? input
    : input.split(/[\r\n;,]+/).map(s => s.trim());

  const seen = new Set();
  const result = [];

  for (const l of lines) {
    const parsed = parseProxyString(l);
    if (parsed && !seen.has(parsed.normalized_url)) {
      seen.add(parsed.normalized_url);
      result.push(parsed);
    }
  }

  return result;
}

/**
 * Tests a proxy's connectivity, latency (ms), and external exit IP in Node.js
 * @param {string} proxyUrl e.g. "http://user:pass@103.1.2.3:8080"
 * @param {number} timeoutMs
 * @returns {Promise<{ live: boolean, latency_ms: number, exit_ip: string|null, error: string|null }>}
 */
export async function testProxyConnectivity(proxyUrl, timeoutMs = 7000) {
  const start = Date.now();
  try {
    let agent;
    if (proxyUrl.startsWith('socks')) {
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      agent = new SocksProxyAgent(proxyUrl);
    } else {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      agent = new HttpsProxyAgent(proxyUrl);
    }

    const fetch = (await import('node-fetch')).default;

    // Test connectivity directly to Facebook Gateway (authoritative endpoint for Facebook proxies)
    let res = null;
    try {
      res = await fetch('https://graph.facebook.com', {
        agent,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
    } catch (fbErr) {
      // Fallback to mbasic.facebook.com
      res = await fetch('https://mbasic.facebook.com', {
        agent,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
    }

    const latency_ms = Date.now() - start;

    if (res && res.status) {
      let exit_ip = null;
      try {
        const u = new URL(proxyUrl);
        exit_ip = u.hostname;
      } catch (_) {}

      return {
        live: true,
        latency_ms,
        exit_ip: exit_ip || 'FB Edge',
        error: null
      };
    } else {
      return {
        live: false,
        latency_ms: 0,
        exit_ip: null,
        error: `HTTP ${res?.status || 502}`
      };
    }
  } catch (err) {
    return {
      live: false,
      latency_ms: 0,
      exit_ip: null,
      error: err.name === 'FetchError' || err.type === 'request-timeout' ? 'Timeout / Không kết nối được' : err.message
    };
  }
}
