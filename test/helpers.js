'use strict';
// 测试公共工具：内存库 + 临时照片目录 + 最小数据集 + HTTP 服务
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createAdapters } = require('../src/adapters');
const { createService } = require('../src/service');
const { createServer } = require('../src/server');

function makeWorld() {
  const db = openDb(':memory:');
  const photosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stroller-photos-'));
  const adapters = createAdapters();
  const service = createService({ db, adapters, photosDir });
  const at = '2026-09-30T08:00:00.000Z';

  db.exec('BEGIN');
  const insP = db.prepare('INSERT INTO service_points (code, name, map_x, map_y, capacity) VALUES (?,?,?,?,?)');
  insP.run('A', '甲服务点', 10, 10, 3);
  insP.run('B', '乙服务点', 50, 50, 2);
  const insV = db.prepare(`INSERT INTO vehicles (code, home_point_id, point_id, max_weight_kg, has_canopy, has_rain_cover, status, updated_at)
                           VALUES (?,?,?,?,?,?,?,?)`);
  insV.run('ST-A1', 1, 1, 22, 1, 1, 'available', at);
  insV.run('ST-A2', 1, 1, 15, 1, 0, 'available', at); // 无雨罩车型
  insV.run('ST-B1', 2, 2, 22, 1, 1, 'available', at);
  db.exec('COMMIT');

  return { db, adapters, service, photosDir, at };
}

function startHttp(world) {
  const server = createServer({ service: world.service, publicDir: path.join(__dirname, '..', 'public'), photosDir: world.photosDir });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        async post(p, body) {
          const res = await fetch(`http://127.0.0.1:${port}${p}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          return { status: res.status, body: await res.json() };
        },
        async get(p) {
          const res = await fetch(`http://127.0.0.1:${port}${p}`);
          return { status: res.status, body: await res.json() };
        },
      });
    });
  });
}

module.exports = { makeWorld, startHttp };
