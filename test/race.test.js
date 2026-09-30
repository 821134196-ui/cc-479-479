'use strict';
// 库存竞争：最后一辆车被两处终端同时请求时，仅一笔成功
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, startHttp } = require('./helpers');

test('两处终端同时锁定最后一辆车：仅一笔成功', async () => {
  const world = makeWorld();
  const http = await startHttp(world);
  try {
    // 乙服务点仅剩 ST-B1 一辆可借；两个终端同时扫码锁车
    const [r1, r2] = await Promise.all([
      http.post('/api/checkout/begin', { vehicleCode: 'ST-B1', pointId: 2, staff: '终端-1' }),
      http.post('/api/checkout/begin', { vehicleCode: 'ST-B1', pointId: 2, staff: '终端-2' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], '必须一笔成功一笔冲突');
    const winner = r1.status === 200 ? r1 : r2;
    const loser = r1.status === 200 ? r2 : r1;
    assert.equal(loser.body.error.code, 'VEHICLE_UNAVAILABLE');

    // 赢家完成借出；此后任何终端再锁都失败
    const ok = await http.post('/api/checkout/confirm', {
      lockToken: winner.body.lockToken, touristName: '竞争游客', touristPhone: '13900000000',
      childWeightKg: 12, period: '2h', checks: { brakeOk: true, beltOk: true, accessoriesOk: true }, staff: '终端-1',
    });
    assert.equal(ok.status, 200);
    const again = await http.post('/api/checkout/begin', { vehicleCode: 'ST-B1', pointId: 2, staff: '终端-2' });
    assert.equal(again.status, 409);

    const vehicles = await http.get('/api/vehicles?point_id=2');
    assert.equal(vehicles.body[0].status, 'rented');
  } finally {
    http.server.close();
  }
});

test('服务层并发锁：第二次 beginCheckout 抛 VEHICLE_UNAVAILABLE', () => {
  const { service } = makeWorld();
  const first = service.beginCheckout({ vehicleCode: 'ST-B1', pointId: 2, staff: 't1' });
  assert.ok(first.lockToken);
  assert.throws(
    () => service.beginCheckout({ vehicleCode: 'ST-B1', pointId: 2, staff: 't2' }),
    (e) => e.code === 'VEHICLE_UNAVAILABLE'
  );
});
