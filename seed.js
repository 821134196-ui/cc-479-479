'use strict';
// 重置并重新生成样例数据：node seed.js
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./src/db');
const { seed } = require('./src/seed');

const DB_PATH = process.env.STROLLER_DB || path.join(__dirname, 'data', 'stroller.db');

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch (_) { /* 不存在则忽略 */ }
}
const db = openDb(DB_PATH);
seed(db);
console.log(`样例数据已生成：${DB_PATH}`);
console.log('内置样例：');
console.log('  · 缺车      —— 花海服务点 P4 无可借车辆（触发调拨提醒）');
console.log('  · 跨点归还  —— 租借单 R-100001（山门借出，可还至湖畔/索道站）');
console.log('  · 刹车异常  —— ST-008 维修中（索道站），ST-003 无雨罩可演示雨罩缺失路径');
