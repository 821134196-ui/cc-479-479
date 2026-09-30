'use strict';
// 样例数据：4 个服务点、12 辆车，内置「缺车 / 跨点 / 刹车异常」演示样例。
// 游客与付款均为样例。
function seedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM service_points').get().c;
  if (count > 0) return false;
  seed(db);
  return true;
}

function seed(db) {
  const now = new Date();
  const iso = (d) => d.toISOString();
  const hoursAgo = (h) => iso(new Date(now.getTime() - h * 3600 * 1000));
  const hoursLater = (h) => iso(new Date(now.getTime() + h * 3600 * 1000));

  db.exec('BEGIN');
  try {
    // ---- 服务点 ----
    const insPoint = db.prepare('INSERT INTO service_points (code, name, map_x, map_y, capacity) VALUES (?,?,?,?,?)');
    insPoint.run('P1', '山门服务点', 14, 72, 8);
    insPoint.run('P2', '湖畔服务点', 44, 42, 6);
    insPoint.run('P3', '索道站服务点', 70, 62, 4);
    insPoint.run('P4', '花海服务点', 84, 24, 5);

    // ---- 车辆 ----
    const insV = db.prepare(`INSERT INTO vehicles (code, home_point_id, point_id, max_weight_kg, has_canopy, has_rain_cover, status, updated_at)
                             VALUES (?,?,?,?,?,?,?,?)`);
    const at = iso(now);
    // 山门 P1：3 辆可借 + 1 辆租出（跨点归还样例）
    insV.run('ST-001', 1, 1, 15, 1, 1, 'available', at);
    insV.run('ST-002', 1, 1, 22, 1, 1, 'available', at);
    insV.run('ST-003', 1, 1, 25, 1, 0, 'available', at); // 无雨罩车型（雨罩缺失处理路径演示）
    insV.run('ST-004', 1, 1, 22, 1, 1, 'rented', at);
    // 湖畔 P2：2 辆可借 + 1 辆待清洁
    insV.run('ST-005', 2, 2, 22, 1, 1, 'available', at);
    insV.run('ST-006', 2, 2, 15, 1, 1, 'available', at);
    insV.run('ST-007', 2, 2, 22, 1, 1, 'pending_clean', at);
    // 索道站 P3：1 辆维修（刹车异常样例）+ 1 辆待安全复检
    insV.run('ST-008', 3, 3, 22, 1, 1, 'repair', at);
    insV.run('ST-009', 3, 3, 15, 1, 1, 'pending_inspect', at);
    // 花海 P4：全部不可借 → 缺车样例
    insV.run('ST-010', 4, 4, 22, 1, 1, 'rented', at);
    insV.run('ST-011', 4, 4, 15, 1, 1, 'pending_clean', at);

    // ---- 租借单（样例游客与付款） ----
    const insR = db.prepare(`INSERT INTO rentals (code, vehicle_id, rent_point_id, return_point_id, tourist_name, tourist_phone,
        child_weight_kg, period, start_at, due_at, returned_at, status, deposit_amount, deposit_status,
        pay_receipt, refund_receipt, overtime_minutes, overtime_fee, missing_accessories, waived_accessories, deduction, damage_note, signature, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // 跨点归还样例：山门借出、即将超时，可在湖畔归还
    insR.run('R-100001', 4, 1, null, '林小样', '13800000001', 18, '2h',
      hoursAgo(1.9), hoursLater(0.1), null, 'active', 20000, 'held',
      'PAY-R-100001', null, 0, 0, '[]', '[]', 0, null, '林小样', hoursAgo(1.9));
    // 花海在租
    insR.run('R-100002', 10, 4, null, '周示例', '13800000002', 12, 'halfday',
      hoursAgo(1), hoursLater(3), null, 'active', 20000, 'held',
      'PAY-R-100002', null, 0, 0, '[]', '[]', 0, null, '周示例', hoursAgo(1));
    // 历史单：已归还、有扣款、押金争议中（押金复核样例）
    insR.run('R-100000', 1, 1, 1, '陈演示', '13800000003', 14, '2h',
      hoursAgo(26), hoursAgo(24), hoursAgo(23.5), 'returned', 20000, 'disputed',
      'PAY-R-100000', 'REF-R-100000', 32, 2000, '[]', '[]', 2000, '车架轻微刮痕', '陈演示', hoursAgo(26));

    // ---- 清洁队列 ----
    const insC = db.prepare('INSERT INTO cleaning_tasks (vehicle_id, point_id, status, assignee, created_at, done_at) VALUES (?,?,?,?,?,?)');
    insC.run(7, 2, 'queued', null, hoursAgo(0.5), null);          // ST-007 待清洁
    insC.run(11, 4, 'in_progress', '保洁-阿芳', hoursAgo(0.4), null); // ST-011 清洁中
    insC.run(9, 3, 'done', '保洁-阿芳', hoursAgo(3), hoursAgo(2.5)); // ST-009 已清洁待复检

    // ---- 维修工单：刹车异常样例 ----
    db.prepare('INSERT INTO repair_orders (vehicle_id, point_id, reported_by, issue, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(8, 3, '员工-小王', '刹车异常：制动行程过长，需更换刹车线', 'open', hoursAgo(2));

    // ---- 押金复核：争议待处理 ----
    db.prepare('INSERT INTO deposit_reviews (rental_id, reason, status, created_at) VALUES (?,?,?,?)')
      .run(3, '游客认为超时 32 分钟系排队还车所致，申请免除超时费 ¥20', 'pending', hoursAgo(20));

    // ---- 事件日志 ----
    const insE = db.prepare('INSERT INTO events (vehicle_id, rental_id, point_id, type, actor, payload, created_at) VALUES (?,?,?,?,?,?,?)');
    insE.run(4, 1, 1, 'rented', '员工-小王', JSON.stringify({ code: 'R-100001', period: '2h' }), hoursAgo(1.9));
    insE.run(10, 2, 4, 'rented', '员工-小李', JSON.stringify({ code: 'R-100002', period: 'halfday' }), hoursAgo(1));
    insE.run(7, null, 2, 'returned', '员工-小李', '{}', hoursAgo(0.5));
    insE.run(8, null, 3, 'repair_reported', '员工-小王', JSON.stringify({ issue: '刹车异常' }), hoursAgo(2));
    insE.run(9, null, 3, 'cleaning_done', '保洁-阿芳', '{}', hoursAgo(2.5));
    insE.run(1, 3, 1, 'deposit_disputed', '员工-小王', JSON.stringify({ reason: '超时费争议' }), hoursAgo(20));

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { seedIfEmpty, seed };
