'use strict';
// 平台入口：npm start 一条命令启动（首次启动自动建库并写入样例数据）。
const path = require('node:path');
const { openDb } = require('./src/db');
const { createAdapters } = require('./src/adapters');
const { createService } = require('./src/service');
const { createScheduler } = require('./src/scheduler');
const { createServer } = require('./src/server');
const { seedIfEmpty } = require('./src/seed');

const PORT = Number(process.env.PORT || 8321);
const DB_PATH = process.env.STROLLER_DB || path.join(__dirname, 'data', 'stroller.db');
const PHOTOS_DIR = process.env.STROLLER_PHOTOS || path.join(__dirname, 'data', 'photos');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TICK_MS = Number(process.env.TICK_MS || 15000);

const db = openDb(DB_PATH);
if (seedIfEmpty(db)) {
  console.log('[init] 数据库为空，已写入样例数据（含缺车 / 跨点归还 / 刹车异常样例）');
}

const adapters = createAdapters();
const service = createService({ db, adapters, photosDir: PHOTOS_DIR });
const scheduler = createScheduler({ service, tickMs: TICK_MS });
scheduler.start();
scheduler.runOnce(); // 启动即扫描一次超时与缺车

const server = createServer({ service, publicDir: PUBLIC_DIR, photosDir: PHOTOS_DIR });
server.listen(PORT, () => {
  console.log(`景区婴儿车租借与清洁周转平台已启动：http://localhost:${PORT}`);
  console.log(`数据库：${DB_PATH}　损伤照片目录：${PHOTOS_DIR}`);
});
