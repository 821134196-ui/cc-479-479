'use strict';
// 原生 node:http 服务：JSON API + 静态页面 + 损伤照片访问。无外部依赖。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./service');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError('PAYLOAD_TOO_LARGE', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError('BAD_JSON', '请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function createServer({ service, publicDir, photosDir }) {
  // 路由表：[method, 正则, handler(匹配组, body, query)]
  const routes = [
    ['GET', /^\/api\/dashboard$/, () => service.dashboard()],
    ['GET', /^\/api\/points$/, () => service.listPoints()],
    ['GET', /^\/api\/vehicles$/, (m, b, q) => service.listVehicles(q.point_id ? Number(q.point_id) : null)],
    ['GET', /^\/api\/rentals$/, (m, b, q) => service.listRentals(q.status || null)],
    ['GET', /^\/api\/events$/, (m, b, q) => service.listEvents({ vehicleId: q.vehicle_id ? Number(q.vehicle_id) : null })],
    ['GET', /^\/api\/notifications$/, () => service.listNotifications()],
    ['POST', /^\/api\/scan$/, (m, b) => service.scan(b.code)],
    ['POST', /^\/api\/checkout\/begin$/, (m, b) => service.beginCheckout(b)],
    ['POST', /^\/api\/checkout\/confirm$/, (m, b) => service.confirmCheckout(b)],
    ['POST', /^\/api\/checkout\/cancel$/, (m, b) => service.cancelCheckout(b)],
    ['POST', /^\/api\/returns$/, (m, b) => service.returnRental(b)],
    ['GET', /^\/api\/cleaning$/, (m, b, q) => service.listCleaning(q.point_id ? Number(q.point_id) : null)],
    ['POST', /^\/api\/cleaning\/(\d+)\/start$/, (m, b) => service.startCleaning(Number(m[1]), b.staff)],
    ['POST', /^\/api\/cleaning\/(\d+)\/finish$/, (m, b) => service.finishCleaning(Number(m[1]), b.staff)],
    ['POST', /^\/api\/inspections$/, (m, b) => service.inspect(b)],
    ['GET', /^\/api\/inspections$/, () => service.listInspections()],
    ['POST', /^\/api\/repairs$/, (m, b) => service.reportRepair(b)],
    ['POST', /^\/api\/repairs\/(\d+)\/fix$/, (m, b) => service.fixRepair(Number(m[1]), b.staff)],
    ['GET', /^\/api\/repairs$/, () => service.listRepairs()],
    ['POST', /^\/api\/transfers$/, (m, b) => service.transferVehicle(b)],
    ['GET', /^\/api\/deposit-reviews$/, () => service.listDepositReviews()],
    ['POST', /^\/api\/deposit-reviews$/, (m, b) => service.createDepositReview(b)],
    ['POST', /^\/api\/deposit-reviews\/(\d+)\/resolve$/, (m, b) => service.resolveDepositReview({ id: Number(m[1]), ...b })],
    ['POST', /^\/api\/tick$/, () => service.tick()], // 手动触发一次进程内任务（演示/测试）
  ];

  function serveStatic(res, filePath) {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const query = Object.fromEntries(url.searchParams.entries());

    try {
      if (pathname.startsWith('/api/')) {
        for (const [method, re, handler] of routes) {
          if (method !== req.method) continue;
          const m = pathname.match(re);
          if (!m) continue;
          const body = req.method === 'POST' ? await readBody(req) : {};
          const result = await handler(m, body, query);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }
        throw new AppError('NOT_FOUND', `接口不存在：${req.method} ${pathname}`, 404);
      }

      // 损伤照片
      if (pathname.startsWith('/photos/')) {
        const fname = path.basename(pathname);
        return serveStatic(res, path.join(photosDir, fname));
      }

      // 静态页面
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.join(publicDir, rel);
      if (!filePath.startsWith(publicDir)) throw new AppError('FORBIDDEN', '非法路径', 403);
      return serveStatic(res, filePath);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[server]', e);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: e.code || 'INTERNAL', message: e.message || '服务器错误', details: e.details } }));
    }
  });

  return server;
}

module.exports = { createServer };
