// 网关与工单台来源的 HTTP 客户端。
// 只负责取原件、回执和工单约定，不包含任何依赖判定逻辑。

import { request as httpRequest } from 'node:http';

export class GatewayError extends Error {
  constructor(status, path, body) {
    super(`来源 ${path} 返回 ${status}`);
    this.name = 'GatewayError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

// 回环地址直连：沙箱里的代理变量会让全局 fetch 误把本地来源也转发到代理，
// 且 Node 22 不读取 NO_PROXY，因此对 127.0.0.1/localhost 走 node:http。
function isLoopback(url) {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
}

function directRequest(urlString, { method, headers, body }) {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export class GatewayClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.loopback = isLoopback(new URL(this.baseUrl));
  }

  async #request(method, path, body) {
    const url = this.baseUrl + path;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload === undefined ? undefined : { 'content-type': 'application/json' };
    const response = this.loopback
      ? await directRequest(url, { method, headers, body: payload })
      : await fetch(url, { method, headers, body: payload }).then(async r => ({ status: r.status, text: await r.text() }));
    const text = response.text;
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GatewayError(response.status, path, data);
    }
    return { status: response.status, data };
  }

  get(path) {
    return this.#request('GET', path);
  }

  post(path, body) {
    return this.#request('POST', path, body ?? {});
  }

  getClock() {
    return this.get('/gateway/clock').then(r => r.data);
  }

  getChannels() {
    return this.get('/gateway/channels').then(r => r.data);
  }

  getOrders() {
    return this.get('/desk/orders').then(r => r.data);
  }

  getEligibility() {
    return this.get('/desk/eligibility').then(r => r.data);
  }

  // 领取会话：202 表示已受理但仍在占用停顿，200 表示当次即结算。
  read(channelId) {
    return this.post(`/gateway/read/${encodeURIComponent(channelId)}`);
  }

  getReceipt(receiptId) {
    return this.get(`/gateway/receipt/${encodeURIComponent(receiptId)}`).then(r => r.data);
  }

  // resumePath 来自回执里的续领凭据，网关只认它自己签发的路径。
  resume(resumePath) {
    return this.post(resumePath);
  }

  selectScenario(stage) {
    return this.post(`/scenario/${encodeURIComponent(stage)}`);
  }
}
