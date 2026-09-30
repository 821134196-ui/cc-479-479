'use strict';
// 业务服务层：租借、归还、清洁、复检、维修、调拨、押金复核、进程内提醒。
// 所有写操作在事务内完成；车辆锁定用原子 UPDATE 保证并发下仅一笔成功。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEPOSIT_CENTS = 20000;          // 押金 ¥200
const OVERTIME_UNIT_MIN = 30;         // 超时计费单位：每 30 分钟
const OVERTIME_UNIT_FEE = 1000;       // 每单位 ¥10
const MISSING_ACCESSORY_FEE = 5000;   // 遗失配件每件 ¥50
const LOCK_TTL_MS = 5 * 60 * 1000;    // 借出锁定时长 5 分钟
const PERIOD_HOURS = { '2h': 2, halfday: 4, fullday: 10 };
const PHYSICAL_STATUSES = ['available', 'locked', 'pending_clean', 'cleaning', 'pending_inspect', 'repair'];

class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowIso(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

function createService({ db, adapters, photosDir }) {
  fs.mkdirSync(photosDir, { recursive: true });

  const q = {
    pointById: db.prepare('SELECT * FROM service_points WHERE id = ?'),
    vehicleById: db.prepare('SELECT * FROM vehicles WHERE id = ?'),
    vehicleByCode: db.prepare('SELECT * FROM vehicles WHERE code = ?'),
    rentalByCode: db.prepare('SELECT * FROM rentals WHERE code = ?'),
    rentalById: db.prepare('SELECT * FROM rentals WHERE id = ?'),
    activeRentalByVehicle: db.prepare("SELECT * FROM rentals WHERE vehicle_id = ? AND status IN ('active','overdue') ORDER BY id DESC LIMIT 1"),
    insertEvent: db.prepare('INSERT INTO events (vehicle_id, rental_id, point_id, type, actor, payload, created_at) VALUES (?,?,?,?,?,?,?)'),
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw e;
    }
  }

  function event({ vehicleId = null, rentalId = null, pointId = null, type, actor = null, payload = {} }, at) {
    q.insertEvent.run(vehicleId, rentalId, pointId, type, actor, JSON.stringify(payload), at || nowIso());
  }

  function getVehicle(idOrCode) {
    const v = typeof idOrCode === 'number' ? q.vehicleById.get(idOrCode) : q.vehicleByCode.get(String(idOrCode));
    if (!v) throw new AppError('VEHICLE_NOT_FOUND', `车辆不存在：${idOrCode}`, 404);
    return v;
  }

  function physicalCount(pointId) {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM vehicles WHERE point_id = ? AND status IN (${PHYSICAL_STATUSES.map(() => '?').join(',')})`
    ).get(pointId, ...PHYSICAL_STATUSES);
    return row.c;
  }

  // ---------- 查询 ----------

  function listPoints() {
    const points = db.prepare('SELECT * FROM service_points ORDER BY id').all();
    return points.map((p) => {
      const rows = db.prepare('SELECT status, COUNT(*) AS c FROM vehicles WHERE point_id = ? GROUP BY status').all(p.id);
      const by = Object.fromEntries(rows.map((r) => [r.status, r.c]));
      return {
        ...p,
        available: by.available || 0,
        rented: by.rented || 0,
        locked: by.locked || 0,
        pending_clean: by.pending_clean || 0,
        cleaning: by.cleaning || 0,
        pending_inspect: by.pending_inspect || 0,
        repair: by.repair || 0,
        physical: physicalCount(p.id),
        total: rows.reduce((s, r) => s + r.c, 0),
      };
    });
  }

  function listVehicles(pointId) {
    const sql = pointId
      ? 'SELECT * FROM vehicles WHERE point_id = ? ORDER BY code'
      : 'SELECT * FROM vehicles ORDER BY point_id, code';
    const rows = pointId ? db.prepare(sql).all(pointId) : db.prepare(sql).all();
    return rows.map((v) => ({ ...v, active_rental: q.activeRentalByVehicle.get(v.id) || null }));
  }

  function listRentals(status) {
    const sql = status
      ? 'SELECT * FROM rentals WHERE status = ? ORDER BY id DESC'
      : 'SELECT * FROM rentals ORDER BY id DESC';
    return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  }

  function listEvents({ vehicleId, limit = 50 }) {
    if (vehicleId) {
      return db.prepare('SELECT * FROM events WHERE vehicle_id = ? ORDER BY id DESC LIMIT ?').all(vehicleId, limit);
    }
    return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---------- 扫码（模拟适配器） ----------

  function scan(code) {
    const scanned = adapters.scanner.scan(code);
    const vehicle = q.vehicleByCode.get(scanned.code);
    const rental = q.rentalByCode.get(scanned.code);
    return { scan: scanned, vehicle: vehicle || null, rental: rental || null };
  }

  // ---------- 借出 ----------

  // 第一步：锁定车辆（原子更新，两处终端同时请求仅一笔成功）
  function beginCheckout({ vehicleCode, pointId, staff }, now) {
    const at = nowIso(now);
    const vehicle = getVehicle(vehicleCode);
    if (vehicle.point_id !== Number(pointId)) {
      const home = q.pointById.get(vehicle.point_id);
      throw new AppError('WRONG_POINT', `车辆 ${vehicle.code} 当前在「${home ? home.name : vehicle.point_id}」，请到对应服务点租借`, 409);
    }
    const token = crypto.randomUUID();
    const expires = new Date(new Date(at).getTime() + LOCK_TTL_MS).toISOString();
    const res = db.prepare(
      "UPDATE vehicles SET status = 'locked', lock_token = ?, lock_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'available'"
    ).run(token, expires, at, vehicle.id);
    if (res.changes !== 1) {
      const cur = q.vehicleById.get(vehicle.id);
      throw new AppError('VEHICLE_UNAVAILABLE', `车辆 ${vehicle.code} 当前不可借（状态：${cur.status}）`, 409, { status: cur.status });
    }
    event({ vehicleId: vehicle.id, pointId, type: 'locked', actor: staff, payload: { token } }, at);
    return { lockToken: token, expiresAt: expires, vehicle: q.vehicleById.get(vehicle.id) };
  }

  function cancelCheckout({ lockToken, staff }, now) {
    const at = nowIso(now);
    return tx(() => {
      const v = db.prepare("SELECT * FROM vehicles WHERE lock_token = ? AND status = 'locked'").get(lockToken);
      if (!v) throw new AppError('LOCK_INVALID', '锁定不存在或已失效', 409);
      db.prepare("UPDATE vehicles SET status = 'available', lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?").run(at, v.id);
      event({ vehicleId: v.id, pointId: v.point_id, type: 'lock_released', actor: staff }, at);
      return { released: v.code };
    });
  }

  // 第二步：借出前检查（刹车/安全带/配件）+ 资格校验 + 收押金，确认后正式借出
  // 注意：拒绝路径的副作用（释放锁定、下架报修）须随事务提交，因此在事务内收集结果、事务外抛错。
  function confirmCheckout({ lockToken, touristName, touristPhone, childWeightKg, period, checks = {}, acceptNoRainCover = false, staff, signature }, now) {
    const at = nowIso(now);
    const outcome = tx(() => {
      const v = db.prepare("SELECT * FROM vehicles WHERE lock_token = ? AND status = 'locked'").get(lockToken);
      if (!v || (v.lock_expires_at && v.lock_expires_at < at)) {
        return { reject: new AppError('LOCK_INVALID', '锁定不存在或已过期，请重新扫码锁车', 409) };
      }
      const releaseLock = () => db.prepare(
        "UPDATE vehicles SET status = 'available', lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?"
      ).run(at, v.id);
      const toRepair = (issue, reason) => {
        db.prepare("UPDATE vehicles SET status = 'repair', lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?").run(at, v.id);
        const order = db.prepare('INSERT INTO repair_orders (vehicle_id, point_id, reported_by, issue, status, created_at) VALUES (?,?,?,?,?,?)')
          .run(v.id, v.point_id, staff || 'staff', issue, 'open', at);
        event({ vehicleId: v.id, pointId: v.point_id, type: 'checkout_rejected', actor: staff, payload: { reason, repairOrderId: Number(order.lastInsertRowid) } }, at);
        return Number(order.lastInsertRowid);
      };

      // 资格校验：适用体重
      const weight = Number(childWeightKg);
      if (!(weight > 0)) return { reject: new AppError('WEIGHT_REQUIRED', '请填写儿童体重', 400) };
      if (weight > v.max_weight_kg) {
        releaseLock();
        const bigger = db.prepare(
          "SELECT code, max_weight_kg FROM vehicles WHERE point_id = ? AND status = 'available' AND max_weight_kg >= ? ORDER BY max_weight_kg LIMIT 3"
        ).all(v.point_id, weight);
        event({ vehicleId: v.id, pointId: v.point_id, type: 'checkout_rejected', actor: staff, payload: { reason: 'WEIGHT_EXCEEDED', weight } }, at);
        return { reject: new AppError('WEIGHT_EXCEEDED', `儿童体重 ${weight}kg 超过该车适用上限 ${v.max_weight_kg}kg，请更换大承重车辆`, 422, { suggestions: bigger }) };
      }
      if (!PERIOD_HOURS[period]) return { reject: new AppError('PERIOD_INVALID', '租借时段无效', 400) };

      // 借出前检查：刹车 / 安全带 / 配件异常 → 下架并自动生成维修工单
      if (checks.brakeOk === false) {
        const repairOrderId = toRepair('刹车异常（借出前检查发现）', 'BRAKE_FAULT');
        return { reject: new AppError('BRAKE_FAULT', `车辆 ${v.code} 刹车异常，已下架并自动生成维修工单，请为游客更换车辆`, 422, { repairOrderId }) };
      }
      if (checks.beltOk === false) {
        const repairOrderId = toRepair('安全带异常（借出前检查发现）', 'BELT_FAULT');
        return { reject: new AppError('BELT_FAULT', `车辆 ${v.code} 安全带异常，已下架并报修`, 422, { repairOrderId }) };
      }
      if (checks.accessoriesOk === false) {
        const repairOrderId = toRepair('配件缺失/损坏（借出前检查发现）', 'ACCESSORIES_MISSING');
        return { reject: new AppError('ACCESSORIES_MISSING', `车辆 ${v.code} 配件不齐，已下架并报修，请更换车辆`, 422, { repairOrderId }) };
      }
      // 雨罩缺失：游客可确认后继续（保留锁定，等待终端二次确认）
      const waived = [];
      if (v.has_rain_cover && checks.rainCoverOk === false) {
        if (!acceptNoRainCover) {
          return { reject: new AppError('RAIN_COVER_MISSING', `车辆 ${v.code} 雨罩缺失：可让游客确认「无雨罩继续租借」，或取消后更换车辆`, 422, { canAccept: true, lockToken }) };
        }
        waived.push('rain_cover');
      }

      // 通过：创建租借单 + 收押金（模拟付款）
      const code = `R-${crypto.randomInt(100000, 999999)}`;
      const due = new Date(new Date(at).getTime() + PERIOD_HOURS[period] * 3600 * 1000).toISOString();
      const receipt = adapters.payment.chargeDeposit({ rentalCode: code, amount: DEPOSIT_CENTS, touristName });
      const info = db.prepare(
        `INSERT INTO rentals (code, vehicle_id, rent_point_id, tourist_name, tourist_phone, child_weight_kg, period,
           start_at, due_at, status, deposit_amount, deposit_status, pay_receipt, waived_accessories, signature, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'active',?,'held',?,?,?,?)`
      ).run(code, v.id, v.point_id, touristName || '样例游客', touristPhone || '13800000000', weight, period,
        at, due, DEPOSIT_CENTS, receipt.receiptNo, JSON.stringify(waived), signature || '', at);
      db.prepare("UPDATE vehicles SET status = 'rented', lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?").run(at, v.id);
      db.prepare('INSERT INTO inspections (vehicle_id, rental_id, kind, brake_ok, belt_ok, accessories_ok, result, inspector, role, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(v.id, info.lastInsertRowid, 'pre_rental', 1, 1, 1, 'pass', staff || 'staff', 'staff', '借出前检查通过', at);
      event({ vehicleId: v.id, rentalId: Number(info.lastInsertRowid), pointId: v.point_id, type: 'rented', actor: staff, payload: { code, period, dueAt: due, deposit: DEPOSIT_CENTS, waived } }, at);
      return { ok: { rental: q.rentalById.get(info.lastInsertRowid), receipt } };
    });
    if (outcome.reject) throw outcome.reject;
    return outcome.ok;
  }

  // ---------- 归还（含跨点） ----------

  function returnRental({ rentalCode, vehicleCode, pointId, staff, checks = {}, missingAccessories = [], damageNote = '', damageFee = 0, damagePhotos = [] }, now) {
    const at = nowIso(now);
    let rental = null;
    if (rentalCode) rental = q.rentalByCode.get(String(rentalCode));
    if (!rental && vehicleCode) {
      const v = q.vehicleByCode.get(String(vehicleCode));
      if (v) rental = q.activeRentalByVehicle.get(v.id);
    }
    if (!rental) throw new AppError('RENTAL_NOT_FOUND', '未找到进行中的租借单', 404);

    // 幂等：重复归还直接返回首次结果，绝不再次退款
    if (rental.status === 'returned') {
      return {
        alreadyReturned: true,
        rental,
        refund: rental.refund_receipt ? { receiptNo: rental.refund_receipt, duplicate: true } : null,
      };
    }

    const returnPoint = q.pointById.get(Number(pointId));
    if (!returnPoint) throw new AppError('POINT_NOT_FOUND', '归还服务点不存在', 404);
    const crossPoint = returnPoint.id !== rental.rent_point_id;

    // 跨点满仓：目标点物理车位已满时拒绝跨点归还
    if (crossPoint && physicalCount(returnPoint.id) >= returnPoint.capacity) {
      const origin = q.pointById.get(rental.rent_point_id);
      throw new AppError('CROSS_POINT_FULL',
        `「${returnPoint.name}」车位已满（${returnPoint.capacity}），请前往原租借点「${origin ? origin.name : ''}」或其他服务点归还`, 409);
    }

    return tx(() => {
      const cur = q.rentalById.get(rental.id);
      if (cur.status === 'returned') { // 事务内再校验，防并发重复退款
        return { alreadyReturned: true, rental: cur, refund: cur.refund_receipt ? { receiptNo: cur.refund_receipt, duplicate: true } : null };
      }
      const vehicle = q.vehicleById.get(cur.vehicle_id);
      const waived = JSON.parse(cur.waived_accessories || '[]');

      // 超时费用
      const overtimeMin = Math.max(0, Math.floor((new Date(at) - new Date(cur.due_at)) / 60000));
      const overtimeFee = overtimeMin > 0 ? Math.ceil(overtimeMin / OVERTIME_UNIT_MIN) * OVERTIME_UNIT_FEE : 0;
      // 遗失配件（借出时已豁免的不计费）
      const missing = [...new Set(missingAccessories)].filter((a) => !waived.includes(a));
      const missingFee = missing.length * MISSING_ACCESSORY_FEE;
      const dmgFee = Math.max(0, Math.round(Number(damageFee) || 0));
      const deduction = Math.min(cur.deposit_amount, overtimeFee + missingFee + dmgFee);
      const refundAmount = cur.deposit_amount - deduction;

      // 押金退款（适配器按租借单幂等，重复调用返回同一回执）
      const refund = adapters.payment.refund({ key: cur.code, amount: refundAmount, reason: 'rental_return' });

      // 归还复核：刹车异常 → 直接进维修；否则进入待清洁
      const brakeFault = checks.brakeOk === false;
      const nextStatus = brakeFault ? 'repair' : 'pending_clean';
      db.prepare("UPDATE vehicles SET status = ?, point_id = ?, lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(nextStatus, returnPoint.id, at, vehicle.id);
      if (brakeFault) {
        db.prepare('INSERT INTO repair_orders (vehicle_id, point_id, reported_by, issue, status, created_at) VALUES (?,?,?,?,?,?)')
          .run(vehicle.id, returnPoint.id, staff || 'staff', '刹车异常（归还复核发现）', 'open', at);
      } else {
        db.prepare('INSERT INTO cleaning_tasks (vehicle_id, point_id, status, created_at) VALUES (?,?,?,?)')
          .run(vehicle.id, returnPoint.id, 'queued', at);
      }

      db.prepare(
        `UPDATE rentals SET status = 'returned', returned_at = ?, return_point_id = ?, deposit_status = ?,
           refund_receipt = ?, overtime_minutes = ?, overtime_fee = ?, missing_accessories = ?, deduction = ?, damage_note = ?
         WHERE id = ?`
      ).run(at, returnPoint.id, deduction > 0 ? 'partial_refunded' : 'refunded',
        refund.receiptNo, overtimeMin, overtimeFee, JSON.stringify(missing), deduction, damageNote || null, cur.id);

      // 损伤照片存本地目录
      const savedPhotos = saveDamagePhotos({ rentalCode: cur.code, vehicleId: vehicle.id, photos: damagePhotos, note: damageNote, at });

      event({ vehicleId: vehicle.id, rentalId: cur.id, pointId: returnPoint.id, type: 'returned', actor: staff,
        payload: { crossPoint, overtimeMin, overtimeFee, missing, deduction, refund: refund.receiptNo, brakeFault } }, at);
      if (crossPoint) {
        event({ vehicleId: vehicle.id, rentalId: cur.id, pointId: returnPoint.id, type: 'cross_point_return', actor: staff,
          payload: { from: cur.rent_point_id, to: returnPoint.id } }, at);
      }
      event({ vehicleId: vehicle.id, rentalId: cur.id, pointId: returnPoint.id, type: 'deposit_refunded', actor: staff,
        payload: { amount: refundAmount, receipt: refund.receiptNo } }, at);

      return {
        alreadyReturned: false,
        rental: q.rentalById.get(cur.id),
        refund: { ...refund, amount: refundAmount },
        overtime: { minutes: overtimeMin, fee: overtimeFee },
        deduction,
        crossPoint,
        photos: savedPhotos,
        nextStatus,
      };
    });
  }

  function saveDamagePhotos({ rentalCode, vehicleId, photos, note, at }) {
    const saved = [];
    (photos || []).forEach((p, i) => {
      if (!p || !p.dataBase64) return;
      const safe = String(p.filename || `photo${i + 1}.jpg`).replace(/[^\w.一-龥-]/g, '_');
      const fname = `${rentalCode}-${Date.now()}-${i}-${safe}`;
      const fpath = path.join(photosDir, fname);
      fs.writeFileSync(fpath, Buffer.from(p.dataBase64, 'base64'));
      db.prepare('INSERT INTO damage_photos (rental_id, vehicle_id, path, note, created_at) VALUES (?,?,?,?,?)')
        .run(q.rentalByCode.get(rentalCode).id, vehicleId, fname, note || null, at);
      saved.push(fname);
    });
    return saved;
  }

  // ---------- 清洁队列 ----------

  function listCleaning(pointId) {
    const sql = `SELECT ct.*, v.code AS vehicle_code, v.max_weight_kg FROM cleaning_tasks ct
                 JOIN vehicles v ON v.id = ct.vehicle_id
                 ${pointId ? 'WHERE ct.point_id = ?' : ''} ORDER BY ct.id DESC`;
    return pointId ? db.prepare(sql).all(pointId) : db.prepare(sql).all();
  }

  function startCleaning(taskId, staff, now) {
    const at = nowIso(now);
    return tx(() => {
      const t = db.prepare('SELECT * FROM cleaning_tasks WHERE id = ?').get(taskId);
      if (!t) throw new AppError('TASK_NOT_FOUND', '清洁任务不存在', 404);
      if (t.status !== 'queued') throw new AppError('TASK_STATE', '任务不在待处理状态', 409);
      db.prepare("UPDATE cleaning_tasks SET status = 'in_progress', assignee = ? WHERE id = ?").run(staff || 'cleaner', t.id);
      db.prepare("UPDATE vehicles SET status = 'cleaning', updated_at = ? WHERE id = ? AND status = 'pending_clean'").run(at, t.vehicle_id);
      event({ vehicleId: t.vehicle_id, pointId: t.point_id, type: 'cleaning_started', actor: staff }, at);
      return db.prepare('SELECT * FROM cleaning_tasks WHERE id = ?').get(t.id);
    });
  }

  function finishCleaning(taskId, staff, now) {
    const at = nowIso(now);
    return tx(() => {
      const t = db.prepare('SELECT * FROM cleaning_tasks WHERE id = ?').get(taskId);
      if (!t) throw new AppError('TASK_NOT_FOUND', '清洁任务不存在', 404);
      if (t.status !== 'in_progress' && t.status !== 'queued') throw new AppError('TASK_STATE', '任务不在进行中', 409);
      db.prepare("UPDATE cleaning_tasks SET status = 'done', assignee = COALESCE(assignee, ?), done_at = ? WHERE id = ?").run(staff || 'cleaner', at, t.id);
      db.prepare("UPDATE vehicles SET status = 'pending_inspect', updated_at = ? WHERE id = ? AND status IN ('pending_clean','cleaning')").run(at, t.vehicle_id);
      event({ vehicleId: t.vehicle_id, pointId: t.point_id, type: 'cleaning_done', actor: staff }, at);
      return db.prepare('SELECT * FROM cleaning_tasks WHERE id = ?').get(t.id);
    });
  }

  // ---------- 安全复检（点位主管） ----------

  function inspect({ vehicleId, kind, brakeOk, beltOk, accessoriesOk, inspector, role, note }, now) {
    const at = nowIso(now);
    if (kind !== 'post_clean' && kind !== 'post_repair') {
      throw new AppError('KIND_INVALID', '复检类型须为 post_clean 或 post_repair', 400);
    }
    if (role !== 'supervisor') {
      throw new AppError('FORBIDDEN_ROLE', '安全复检须由点位主管完成，普通员工仅可报修', 403);
    }
    return tx(() => {
      const v = getVehicle(Number(vehicleId));
      if (v.status !== 'pending_inspect') {
        throw new AppError('VEHICLE_STATE', `车辆 ${v.code} 当前状态为 ${v.status}，不在待复检队列`, 409);
      }
      const pass = brakeOk !== false && beltOk !== false && accessoriesOk !== false;
      const info = db.prepare('INSERT INTO inspections (vehicle_id, rental_id, kind, brake_ok, belt_ok, accessories_ok, result, inspector, role, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(v.id, null, kind, brakeOk === false ? 0 : 1, beltOk === false ? 0 : 1, accessoriesOk === false ? 0 : 1,
          pass ? 'pass' : 'fail', inspector || 'supervisor', role, note || null, at);
      if (pass) {
        db.prepare("UPDATE vehicles SET status = 'available', updated_at = ? WHERE id = ?").run(at, v.id);
        event({ vehicleId: v.id, pointId: v.point_id, type: 'inspection_passed', actor: inspector, payload: { kind } }, at);
      } else {
        db.prepare("UPDATE vehicles SET status = 'repair', updated_at = ? WHERE id = ?").run(at, v.id);
        db.prepare('INSERT INTO repair_orders (vehicle_id, point_id, reported_by, issue, status, created_at) VALUES (?,?,?,?,?,?)')
          .run(v.id, v.point_id, inspector || 'supervisor', `安全复检未通过：${note || '见检查记录'}`, 'open', at);
        event({ vehicleId: v.id, pointId: v.point_id, type: 'inspection_failed', actor: inspector, payload: { kind, note } }, at);
      }
      return { inspectionId: Number(info.lastInsertRowid), result: pass ? 'pass' : 'fail', vehicle: q.vehicleById.get(v.id) };
    });
  }

  function listInspections(limit = 50) {
    return db.prepare('SELECT i.*, v.code AS vehicle_code FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id ORDER BY i.id DESC LIMIT ?').all(limit);
  }

  // ---------- 维修工单 ----------

  function reportRepair({ vehicleId, issue, staff }, now) {
    const at = nowIso(now);
    return tx(() => {
      const v = getVehicle(Number(vehicleId));
      if (v.status === 'rented') throw new AppError('VEHICLE_RENTED', '车辆借出中，待归还后再报修', 409);
      if (v.status === 'repair') throw new AppError('ALREADY_REPAIR', '车辆已在维修中', 409);
      db.prepare("UPDATE vehicles SET status = 'repair', lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?").run(at, v.id);
      const info = db.prepare('INSERT INTO repair_orders (vehicle_id, point_id, reported_by, issue, status, created_at) VALUES (?,?,?,?,?,?)')
        .run(v.id, v.point_id, staff || 'staff', issue || '故障报修', 'open', at);
      event({ vehicleId: v.id, pointId: v.point_id, type: 'repair_reported', actor: staff, payload: { issue } }, at);
      return db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(info.lastInsertRowid);
    });
  }

  function fixRepair(orderId, staff, now) {
    const at = nowIso(now);
    return tx(() => {
      const o = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(orderId);
      if (!o) throw new AppError('ORDER_NOT_FOUND', '维修工单不存在', 404);
      if (o.status === 'fixed') throw new AppError('ORDER_STATE', '工单已修复', 409);
      db.prepare("UPDATE repair_orders SET status = 'fixed', resolved_at = ? WHERE id = ?").run(at, o.id);
      // 修复后须主管安全复检才能恢复可借
      db.prepare("UPDATE vehicles SET status = 'pending_inspect', updated_at = ? WHERE id = ?").run(at, o.vehicle_id);
      event({ vehicleId: o.vehicle_id, pointId: o.point_id, type: 'repair_fixed', actor: staff, payload: { orderId: o.id } }, at);
      return db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(o.id);
    });
  }

  function listRepairs() {
    return db.prepare(`SELECT r.*, v.code AS vehicle_code, p.name AS point_name FROM repair_orders r
                       JOIN vehicles v ON v.id = r.vehicle_id JOIN service_points p ON p.id = r.point_id
                       ORDER BY r.id DESC`).all();
  }

  // ---------- 调拨 ----------

  function transferVehicle({ vehicleId, toPointId, staff }, now) {
    const at = nowIso(now);
    return tx(() => {
      const v = getVehicle(Number(vehicleId));
      if (v.status === 'repair') throw new AppError('REPAIR_LOCKED', `车辆 ${v.code} 维修中，不能调拨`, 409);
      if (v.status !== 'available') throw new AppError('VEHICLE_STATE', `仅「可借」车辆可调拨，当前状态：${v.status}`, 409);
      const target = q.pointById.get(Number(toPointId));
      if (!target) throw new AppError('POINT_NOT_FOUND', '目标服务点不存在', 404);
      if (target.id === v.point_id) throw new AppError('SAME_POINT', '车辆已在该服务点', 400);
      if (physicalCount(target.id) >= target.capacity) {
        throw new AppError('CROSS_POINT_FULL', `「${target.name}」车位已满，无法调入`, 409);
      }
      db.prepare('UPDATE vehicles SET point_id = ?, updated_at = ? WHERE id = ?').run(target.id, at, v.id);
      event({ vehicleId: v.id, pointId: target.id, type: 'transferred', actor: staff, payload: { from: v.point_id, to: target.id } }, at);
      return q.vehicleById.get(v.id);
    });
  }

  // ---------- 押金复核 ----------

  function createDepositReview({ rentalCode, reason, staff }, now) {
    const at = nowIso(now);
    return tx(() => {
      const rental = q.rentalByCode.get(String(rentalCode));
      if (!rental) throw new AppError('RENTAL_NOT_FOUND', '租借单不存在', 404);
      if (!['refunded', 'partial_refunded', 'held'].includes(rental.deposit_status)) {
        throw new AppError('DEPOSIT_STATE', `当前押金状态 ${rental.deposit_status} 不可发起复核`, 409);
      }
      db.prepare("UPDATE rentals SET deposit_status = 'disputed' WHERE id = ?").run(rental.id);
      const info = db.prepare('INSERT INTO deposit_reviews (rental_id, reason, status, created_at) VALUES (?,?,?,?)')
        .run(rental.id, reason || '游客对押金扣款有异议', 'pending', at);
      event({ vehicleId: rental.vehicle_id, rentalId: rental.id, pointId: rental.rent_point_id, type: 'deposit_disputed', actor: staff, payload: { reason } }, at);
      return db.prepare('SELECT * FROM deposit_reviews WHERE id = ?').get(info.lastInsertRowid);
    });
  }

  function resolveDepositReview({ id, resolution, refundAmount = 0, staff }, now) {
    const at = nowIso(now);
    return tx(() => {
      const r = db.prepare('SELECT * FROM deposit_reviews WHERE id = ?').get(id);
      if (!r) throw new AppError('REVIEW_NOT_FOUND', '复核单不存在', 404);
      if (r.status === 'resolved') throw new AppError('REVIEW_STATE', '复核单已处理', 409);
      const rental = q.rentalById.get(r.rental_id);
      const extra = Math.max(0, Math.round(Number(refundAmount) || 0));
      let receipt = null;
      if (extra > 0) {
        receipt = adapters.payment.refund({ key: `${rental.code}-review-${r.id}`, amount: extra, reason: 'deposit_review' });
        event({ vehicleId: rental.vehicle_id, rentalId: rental.id, type: 'deposit_review_refund', actor: staff, payload: { amount: extra, receipt: receipt.receiptNo } }, at);
      }
      db.prepare("UPDATE deposit_reviews SET status = 'resolved', resolution = ?, refund_amount = ?, resolved_by = ?, resolved_at = ? WHERE id = ?")
        .run(resolution || '已复核', extra, staff || 'supervisor', at, r.id);
      db.prepare("UPDATE rentals SET deposit_status = 'refunded' WHERE id = ?").run(rental.id);
      return { review: db.prepare('SELECT * FROM deposit_reviews WHERE id = ?').get(r.id), receipt };
    });
  }

  function listDepositReviews() {
    return db.prepare(`SELECT dr.*, r.code AS rental_code, r.tourist_name, r.deposit_amount, r.deduction
                       FROM deposit_reviews dr JOIN rentals r ON r.id = dr.rental_id ORDER BY dr.id DESC`).all();
  }

  // ---------- 进程内任务：超时与调拨提醒 ----------

  function tick(now) {
    const at = nowIso(now);
    const results = { overdue: 0, locksReleased: 0, reminders: 0 };
    tx(() => {
      // 1. 释放过期锁定
      const expired = db.prepare("SELECT * FROM vehicles WHERE status = 'locked' AND lock_expires_at < ?").all(at);
      for (const v of expired) {
        db.prepare("UPDATE vehicles SET status = 'available', lock_token = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?").run(at, v.id);
        event({ vehicleId: v.id, pointId: v.point_id, type: 'lock_expired' }, at);
        results.locksReleased += 1;
      }
      // 2. 游客超时：到期未还 → 标记 + 提醒（按租借单去重）
      const due = db.prepare("SELECT * FROM rentals WHERE status = 'active' AND due_at < ?").all(at);
      for (const r of due) {
        db.prepare("UPDATE rentals SET status = 'overdue' WHERE id = ? AND status = 'active'").run(r.id);
        const v = q.vehicleById.get(r.vehicle_id);
        notify('overdue', {
          pointId: r.rent_point_id, rentalId: r.id,
          message: `租借单 ${r.code}（${r.tourist_name}，车辆 ${v ? v.code : r.vehicle_id}）已超时未还，请联系游客`,
          dedupeKey: `overdue:${r.id}`, at,
        });
        event({ vehicleId: r.vehicle_id, rentalId: r.id, pointId: r.rent_point_id, type: 'overdue' }, at);
        results.overdue += 1;
      }
      // 3. 缺车与调拨提醒：某点无可借车且其他点有富余（按点+小时去重）
      const points = listPoints();
      for (const p of points) {
        if (p.available > 0) continue;
        const donors = points.filter((d) => d.id !== p.id && d.available >= 2);
        notify('stockout', {
          pointId: p.id,
          message: `「${p.name}」当前无可借车辆`,
          dedupeKey: `stockout:${p.id}:${at.slice(0, 13)}`, at,
        });
        if (donors.length > 0) {
          notify('transfer_reminder', {
            pointId: p.id,
            message: `建议从「${donors[0].name}」（可借 ${donors[0].available} 辆）调拨车辆至「${p.name}」`,
            dedupeKey: `transfer:${p.id}:${at.slice(0, 13)}`, at,
          });
          results.reminders += 1;
        }
      }
    });
    return results;
  }

  function notify(type, { pointId = null, rentalId = null, message, dedupeKey, at }) {
    db.prepare('INSERT OR IGNORE INTO notifications (type, point_id, rental_id, message, dedupe_key, created_at) VALUES (?,?,?,?,?,?)')
      .run(type, pointId, rentalId, message, dedupeKey, at || nowIso());
  }

  function listNotifications(limit = 30) {
    return db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit);
  }

  function dashboard() {
    const points = listPoints();
    const activeRentals = db.prepare("SELECT COUNT(*) AS c FROM rentals WHERE status IN ('active','overdue')").get().c;
    const overdue = db.prepare("SELECT COUNT(*) AS c FROM rentals WHERE status = 'overdue'").get().c;
    const cleaningBacklog = db.prepare("SELECT COUNT(*) AS c FROM cleaning_tasks WHERE status != 'done'").get().c;
    const openRepairs = db.prepare("SELECT COUNT(*) AS c FROM repair_orders WHERE status != 'fixed'").get().c;
    const pendingReviews = db.prepare("SELECT COUNT(*) AS c FROM deposit_reviews WHERE status = 'pending'").get().c;
    return {
      points, activeRentals, overdue, cleaningBacklog, openRepairs, pendingReviews,
      notifications: listNotifications(10),
    };
  }

  return {
    tx, event, getVehicle, physicalCount,
    listPoints, listVehicles, listRentals, listEvents, dashboard,
    scan, beginCheckout, confirmCheckout, cancelCheckout, returnRental,
    listCleaning, startCleaning, finishCleaning,
    inspect, listInspections,
    reportRepair, fixRepair, listRepairs,
    transferVehicle,
    createDepositReview, resolveDepositReview, listDepositReviews,
    tick, listNotifications,
    DEPOSIT_CENTS,
  };
}

module.exports = { createService, AppError, DEPOSIT_CENTS };
