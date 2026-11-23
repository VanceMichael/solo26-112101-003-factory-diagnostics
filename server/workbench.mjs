// 值班工作台 HTTP 服务：对值班人和顾问暴露编排引擎，不直接暴露来源报文。

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { GatewayClient, GatewayError } from '../lib/gateway-client.mjs';
import { Orchestrator, PlanRejectedError, ReadRejectedError } from '../lib/orchestrator.mjs';

export function createWorkbench(sourceUrl) {
  const orchestrator = new Orchestrator(new GatewayClient(sourceUrl));

  const send = (response, status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(payload));
  };

  const readBody = async request => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    return text ? JSON.parse(text) : {};
  };

  const handle = async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const route = request.method + ' ' + url.pathname;
    try {
      switch (route) {
        case 'POST /workbench/refresh':
          return send(response, 200, await orchestrator.refresh());
        case 'GET /workbench/overview':
          return send(response, 200, orchestrator.overview());
        case 'GET /workbench/plan':
          return send(response, 200, orchestrator.plan());
        case 'GET /workbench/plan/strict':
          return send(response, 200, orchestrator.planOrThrow());
        case 'POST /workbench/run':
          return send(response, 200, await orchestrator.run(await readBody(request)));
        case 'POST /workbench/read': {
          const body = await readBody(request);
          if (!body.channelId) return send(response, 400, { message: '缺少 channelId' });
          return send(response, 200, await orchestrator.read(body.channelId, body.orderIds));
        }
        case 'POST /workbench/receipt/poll': {
          const body = await readBody(request);
          if (!body.receiptId) return send(response, 400, { message: '缺少 receiptId' });
          return send(response, 200, await orchestrator.pollReceipt(body.receiptId));
        }
        case 'POST /workbench/resume': {
          const body = await readBody(request);
          if (!body.receiptId) return send(response, 400, { message: '缺少 receiptId' });
          return send(response, 200, await orchestrator.resume(body.receiptId));
        }
        case 'GET /workbench/events':
          return send(response, 200, { events: orchestrator.store.state.events });
        default: {
          const cardMatch = url.pathname.match(/^\/workbench\/cards\/(.+)$/);
          if (request.method === 'GET' && cardMatch) {
            return send(response, 200, orchestrator.cardView(decodeURIComponent(cardMatch[1])));
          }
          const advisorMatch = url.pathname.match(/^\/workbench\/advisors\/(.+)$/);
          if (request.method === 'GET' && advisorMatch) {
            return send(response, 200, orchestrator.advisorView(decodeURIComponent(advisorMatch[1])));
          }
          return send(response, 404, { message: '工作台没有此资源' });
        }
      }
    } catch (error) {
      if (error instanceof ReadRejectedError) {
        return send(response, 409, { message: error.message, reason: error.reason, detail: error.detail, rejections: error.rejections });
      }
      if (error instanceof PlanRejectedError) {
        return send(response, 409, { message: error.message, rejections: error.rejections });
      }
      if (error instanceof GatewayError) {
        return send(response, 502, { message: error.message, status: error.status, path: error.path, body: error.body });
      }
      return send(response, 500, { message: error.message });
    }
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      send(response, 500, { message: error.message });
    });
  });

  return {
    orchestrator,
    listen: port => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    }),
    url: () => `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4180';
  const port = Number(process.env.WORKBENCH_PORT ?? 4181);
  const workbench = createWorkbench(sourceUrl);
  await workbench.listen(port);
  console.log(`值班工作台已启动：${workbench.url()}（来源 ${sourceUrl}）`);
}
