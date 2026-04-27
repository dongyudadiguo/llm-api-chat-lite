exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const urlParam = event.queryStringParameters?.url;

  if (!urlParam) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 url 参数' }) };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlParam);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '无效的 URL' }) };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '仅支持 HTTP/HTTPS 协议' }) };
  }

  if (isPrivateHost(parsedUrl.hostname)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: '不允许访问内网地址' }) };
  }

  const jinaUrl = `https://r.jina.ai/${urlParam}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'text/plain' }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: `上游返回 ${response.status}` })
      };
    }

    let text = await response.text();

    if (text.length > 8000) {
      text = text.slice(0, 8000) + '\n\n[内容已截断]';
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ content: text })
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { statusCode: 504, headers, body: JSON.stringify({ error: '请求超时（8秒）' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  } finally {
    clearTimeout(timeout);
  }
};

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();

  if (['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'].includes(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;

  const parts = h.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 127) return true;
  }

  if (/^[0-9a-f:]+$/.test(h)) {
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    if (h === '::ffff:127.0.0.1') return true;
  }

  return false;
}
