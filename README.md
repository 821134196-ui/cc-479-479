# 景区婴儿车租借与清洁周转平台

零依赖（Node ≥ 22 内置 `node:sqlite` + `node:http`），一条命令本地启动。

## 启动

```bash
npm start          # http://localhost:8321 （首次启动自动建库并写入样例数据）
```

其他命令：

```bash
npm run seed       # 重置数据库并重新生成样例（缺车 / 跨点 / 刹车异常）
npm test           # 运行测试：库存竞争、资格校验、清洁阻断、跨点归属、退款幂等
```

环境变量（可选）：`PORT`（默认 8321）、`STROLLER_DB`、`STROLLER_PHOTOS`、`TICK_MS`（进程内任务周期，默认 15s）。

## 内置样例（游客与付款均为样例）

| 样例 | 位置 |
|---|---|
| 缺车 | 花海服务点 P4 无可借车辆，调度任务自动生成「缺车 + 调拨提醒」（右上角 🔔） |
| 跨点归还 | 租借单 `R-100001`（山门借出、即将超时），可在「跨点归还」页还至湖畔/索道站 |
| 刹车异常 | `ST-008` 维修中（索道站）；借出检查把刹车标「异常」也会自动下架并生成工单 |
| 雨罩缺失 | `ST-003` 为无雨罩车型；对有车罩车辆把雨罩标「缺失」可走「游客确认无雨罩继续」路径 |
| 押金争议 | `R-100000` 有一笔待处理的押金复核单 |

## 业务流程

1. **借出**：扫码锁车（原子锁定，两处终端抢同一辆车仅一笔成功，锁定 5 分钟有效）→ 游客信息（体重资格校验）→ 借出检查（刹车/安全带/遮阳篷/雨罩/配件）→ 游客签署 → 冻结押金（模拟付款回执）。
2. **归还**：复核外观与附件，可跨点归还（目标点满仓则拒绝并提示原租借点）；超时按 30 分钟 ¥10 计、遗失配件每件 ¥50 从押金扣减；重复归还不重复退款（同一退款回执）。归还后车辆进入**待清洁**，跨点归还会改变车辆归属位置。
3. **周转**：清洁队列 → 清洁完成 → **点位主管**安全复检（普通员工 403）→ 恢复可借；复检不通过转维修。
4. **维修**：普通员工可报修；维修中车辆不可租借、**不可调拨**；修复后须主管复检才能再借。
5. **押金复核**：押金争议发起复核单，主管处理并可追加退款（按复核单幂等）。

## 数据与目录

- `data/stroller.db` —— SQLite：服务点、车辆、租借单、事件日志、清洁任务、检查记录、维修工单、押金复核、提醒
- `data/photos/` —— 归还时上传的损伤照片（页面 `/photos/<文件名>` 可访问）
- 进程内任务（`src/scheduler.js`）：到期未还标记超时并提醒、释放过期锁车、缺车点生成调拨提醒（按小时去重）
- 模拟适配器（`src/adapters.js`）：扫码枪、付款/退款回执（退款按单号幂等）

## 页面

景区白 / 森林绿 / 阳光黄配色。七个页签：**点位库存**（简版地图 + 点位列表 + 车辆表，车辆行同时显示体重上限与清洁状态）、**借用核验**（借出检查用车辆轮廓标注刹车/篷布/安全带位置，游客签署页大按钮短文本）、**跨点归还**、**清洁队列**、**车辆检查**、**维修工单**、**押金复核**。

## 主要 API

```
GET  /api/dashboard|points|vehicles|rentals|events|notifications
POST /api/scan                         模拟扫码
POST /api/checkout/begin|confirm|cancel  锁车 / 确认借出 / 取消
POST /api/returns                      归还（幂等，支持跨点）
GET|POST /api/cleaning…                清洁队列（start/finish）
POST /api/inspections                  安全复检（role=supervisor）
GET|POST /api/repairs…                 维修工单（report/fix）
POST /api/transfers                    调拨（维修中拒绝）
GET|POST /api/deposit-reviews…         押金复核
POST /api/tick                         手动触发一次进程内任务
```

错误统一为 `{ error: { code, message, details } }`，如 `WEIGHT_EXCEEDED`、`VEHICLE_UNAVAILABLE`、`RAIN_COVER_MISSING`、`BRAKE_FAULT`、`CROSS_POINT_FULL`、`REPAIR_LOCKED`、`FORBIDDEN_ROLE`。

## 测试（`npm test`，13 项）

- `test/race.test.js` —— 两处终端同时锁最后一辆车，HTTP 并发仅一笔 200
- `test/eligibility.test.js` —— 体重超限拒绝并释放车辆；刹车异常自动报修；雨罩缺失确认路径
- `test/cleaning.test.js` —— 归还后未清洁/未复检不可借；员工复检 403；主管复检通过才可借
- `test/crosspoint.test.js` —— 跨点归还改变归属位置；满仓拒绝；维修中不可调拨
- `test/refund.test.js` —— 重复归还不重复退款（适配器调用仅一次）；超时与遗失配件扣减；超时提醒去重
