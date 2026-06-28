const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 20;

const BASE_JSON_HEADERS = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Content-Type': 'application/json'
};

export async function onRequest(context) {
  const responseHeaders = makeResponseHeaders(context.request);

  if (!isAllowedOrigin(context.request)) {
    return json({ error: '不允许的 Origin' }, 403, responseHeaders);
  }

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  if (context.request.method !== 'POST') {
    return json({ error: '仅支持 POST 请求' }, 405, responseHeaders);
  }

  const contentLength = Number(context.request.headers.get('content-length') || 0);
  if (contentLength > Math.ceil(MAX_REQUEST_BYTES * 4 / 3) + 4096) {
    return json({ error: `请求体超过 ${MAX_REQUEST_BYTES} 字节限制` }, 413, responseHeaders);
  }

  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400, responseHeaders);
  }

  let targetUrl;
  try {
    targetUrl = parseTargetUrl(payload && payload.url);
  } catch (err) {
    return json({ error: err.message }, err.status || 400, responseHeaders);
  }

  let method;
  try {
    method = normalizeMethod((payload && payload.method) || 'GET');
  } catch (err) {
    return json({ error: err.message }, 400, responseHeaders);
  }

  let requestHeaders;
  try {
    requestHeaders = buildRequestHeaders(payload && payload.headers);
  } catch (err) {
    return json({ error: err.message }, 400, responseHeaders);
  }

  let requestBody;
  if (method !== 'GET' && method !== 'HEAD' && payload && payload.hasBody) {
    try {
      requestBody = base64ToUint8Array(payload.bodyBase64);
    } catch {
      return json({ error: 'bodyBase64 无效' }, 400, responseHeaders);
    }
    if (requestBody.byteLength > MAX_REQUEST_BYTES) {
      return json({ error: `请求体超过 ${MAX_REQUEST_BYTES} 字节限制` }, 413, responseHeaders);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const result = await fetchWithRedirects(targetUrl.href, {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
      redirect: normalizeRedirect(payload && payload.redirect)
    });

    let responseBuffer = new ArrayBuffer(0);
    if (!isNullBodyResponse(method, result.response.status)) {
      const responseLength = Number(result.response.headers.get('content-length') || 0);
      if (responseLength > MAX_RESPONSE_BYTES) {
        return json({ error: `响应体超过 ${MAX_RESPONSE_BYTES} 字节限制` }, 413, responseHeaders);
      }

      responseBuffer = await result.response.arrayBuffer();
      if (responseBuffer.byteLength > MAX_RESPONSE_BYTES) {
        return json({ error: `响应体超过 ${MAX_RESPONSE_BYTES} 字节限制` }, 413, responseHeaders);
      }
    }

    return json({
      status: result.response.status,
      statusText: result.response.statusText,
      headers: serializeResponseHeaders(result.response.headers),
      bodyBase64: arrayBufferToBase64(responseBuffer),
      nullBody: isNullBodyResponse(method, result.response.status),
      url: result.url,
      redirected: result.redirected
    }, 200, responseHeaders);
  } catch (err) {
    if (err.name === 'AbortError') {
      return json({ error: `请求超时（${Math.round(TIMEOUT_MS / 1000)}秒）` }, 504, responseHeaders);
    }
    return json({ error: err.message || String(err) }, err.status || 502, responseHeaders);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRedirects(initialUrl, init) {
  let url = initialUrl;
  let method = init.method;
  let headers = cloneHeaders(init.headers);
  let body = init.body;
  let redirected = false;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: init.signal,
      redirect: 'manual'
    });

    const location = response.headers.get('location');
    if (!isRedirectStatus(response.status) || !location) {
      return { response, url: response.url || url, redirected };
    }

    if (init.redirect === 'manual') {
      return { response, url: response.url || url, redirected };
    }

    if (init.redirect === 'error') {
      throw createHttpError('请求被重定向', 502);
    }

    if (i === MAX_REDIRECTS) {
      throw createHttpError('重定向次数过多', 508);
    }

    const nextUrl = new URL(location, url);
    validateTargetUrl(nextUrl);

    const previousOrigin = new URL(url).origin;
    if (
      (response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      headers = cloneHeaders(headers);
      deleteBodyHeaders(headers);
    }

    if (nextUrl.origin !== previousOrigin) {
      headers = cloneHeaders(headers);
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }

    url = nextUrl.href;
    redirected = true;
  }

  throw createHttpError('重定向次数过多', 508);
}

function parseTargetUrl(value) {
  if (!value || typeof value !== 'string') {
    throw createHttpError('缺少 url 参数', 400);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw createHttpError('无效的 URL', 400);
  }
  validateTargetUrl(parsedUrl);
  return parsedUrl;
}

function validateTargetUrl(parsedUrl) {
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw createHttpError('仅支持 HTTP/HTTPS 协议', 400);
  }
  if (isPrivateHost(parsedUrl.hostname)) {
    throw createHttpError('不允许访问内网地址', 403);
  }
}

function normalizeMethod(value) {
  const method = String(value || 'GET').toUpperCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method)) {
    throw new Error('无效的请求方法');
  }
  if (['CONNECT', 'TRACE', 'TRACK'].includes(method)) {
    throw new Error('不支持的请求方法');
  }
  return method;
}

function normalizeRedirect(value) {
  if (value === 'manual' || value === 'error') return value;
  return 'follow';
}

function makeResponseHeaders(request) {
  const headers = new Headers(BASE_JSON_HEADERS);
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

function isAllowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function buildRequestHeaders(input) {
  const headers = new Headers();
  const entries = Array.isArray(input)
    ? input
    : input && typeof input === 'object'
      ? Object.entries(input)
      : [];

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const name = String(entry[0] || '').trim();
    if (!name) continue;
    const value = entry[1];
    if (isBlockedRequestHeader(name)) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, String(v));
    } else {
      headers.append(name, String(value));
    }
  }

  if (!headers.has('accept')) headers.set('accept', '*/*');
  if (!headers.has('user-agent')) {
    headers.set(
      'user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );
  }
  return headers;
}

function serializeResponseHeaders(headers) {
  const out = [];
  headers.forEach((value, name) => {
    if (!isBlockedResponseHeader(name)) out.push([name, value]);
  });
  return out;
}

function cloneHeaders(headers) {
  const cloned = new Headers();
  headers.forEach((value, name) => cloned.append(name, value));
  return cloned;
}

function deleteBodyHeaders(headers) {
  headers.delete('content-encoding');
  headers.delete('content-language');
  headers.delete('content-location');
  headers.delete('content-type');
  headers.delete('content-length');
}

function isBlockedRequestHeader(name) {
  const h = String(name).toLowerCase();
  return (
    h === 'host' ||
    h === 'connection' ||
    h === 'content-length' ||
    h === 'transfer-encoding' ||
    h === 'keep-alive' ||
    h === 'upgrade' ||
    h === 'te' ||
    h === 'trailer' ||
    h === 'proxy-authenticate' ||
    h === 'proxy-authorization' ||
    h === 'cookie' ||
    h === 'accept-encoding' ||
    h === 'origin' ||
    h === 'referer' ||
    h === 'access-control-request-method' ||
    h === 'access-control-request-headers' ||
    h === 'forwarded' ||
    h === 'via' ||
    h.startsWith('x-forwarded-') ||
    h.startsWith('proxy-') ||
    h.startsWith('sec-')
  );
}

function isBlockedResponseHeader(name) {
  const h = String(name).toLowerCase();
  return (
    h === 'connection' ||
    h === 'content-length' ||
    h === 'content-encoding' ||
    h === 'transfer-encoding' ||
    h === 'keep-alive' ||
    h === 'upgrade' ||
    h === 'te' ||
    h === 'trailer' ||
    h === 'set-cookie' ||
    h === 'set-cookie2'
  );
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isNullBodyResponse(method, status) {
  return method === 'HEAD' || status === 204 || status === 205 || status === 304;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function json(data, status = 200, headers = BASE_JSON_HEADERS) {
  return new Response(JSON.stringify(data), { status, headers });
}

function createHttpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/g, '');
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h)) return true;
  if (
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.localhost') ||
    h.endsWith('.localdomain')
  ) return true;

  if (h.includes(':')) {
    if (h.startsWith('::ffff:')) return isPrivateHost(normalizeMappedIpv4(h.slice(7)));
    if (h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
    return false;
  }

  const parts = h.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 0) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    if (parts[0] >= 224) return true;
  }
  return false;
}

function normalizeMappedIpv4(value) {
  if (value.includes('.')) return value.slice(value.lastIndexOf(':') + 1);
  const parts = value.split(':').map(part => parseInt(part || '0', 16));
  if (parts.length !== 2 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    return '127.0.0.1';
  }
  return [
    (parts[0] >> 8) & 255,
    parts[0] & 255,
    (parts[1] >> 8) & 255,
    parts[1] & 255
  ].join('.');
}
