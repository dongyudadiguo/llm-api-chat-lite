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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(urlParam, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*'
      }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: `上游返回 ${response.status}` })
      };
    }

    const contentType = response.headers.get('content-type') || '';
    let text;

    if (contentType.includes('text/html')) {
      const html = await response.text();
      text = htmlToText(html);
    } else {
      text = await response.text();
    }

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

function htmlToText(html) {
  let text = html;
  // Remove script, style, nav, header, footer, noscript, svg, head
  text = text.replace(/<(script|style|nav|header|footer|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Replace block-level closing tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|dt|dd|th|td)[^>]*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr[^>]*>/gi, '\n---\n');
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  // Collapse whitespace: multiple spaces → single space
  text = text.replace(/[ \t]+/g, ' ');
  // Collapse 3+ newlines → 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // Trim each line
  text = text.split('\n').map(l => l.trim()).join('\n');
  // Collapse multiple blank lines again after trim
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

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
  return false;
}