'use strict';
/* 景区婴儿车租借与清洁周转平台 —— 前端逻辑 */

// ---------- 基础 ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `请求失败 ${res.status}`);
    err.code = data.error?.code;
    err.details = data.error?.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3600);
}

const money = (cents) => `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');

const STATUS_LABEL = {
  available: '可借', locked: '锁定中', rented: '借出中',
  pending_clean: '待清洁', cleaning: '清洁中', pending_inspect: '待复检', repair: '维修中',
};
const CLEAN_LABEL = {
  available: '已清洁·可借', locked: '锁定中', rented: '—（借出）',
  pending_clean: '待清洁', cleaning: '清洁中', pending_inspect: '待安全复检', repair: '—（维修）',
};
const RENTAL_LABEL = { active: '在租', overdue: '已超时', returned: '已归还' };
const DEPOSIT_LABEL = { held: '冻结中', refunded: '已全额退', partial_refunded: '已部分退', disputed: '争议中' };
const badge = (txt, cls) => `<span class="badge ${cls}">${txt}</span>`;
const vBadge = (s) => badge(STATUS_LABEL[s] || s, s);

const state = {
  points: [],
  selectedPointId: null,
  rent: null,          // { lockToken, vehicle, pointId, checks }
  returnRental: null,  // 当前查询到的租借单
  returnPointId: null,
  returnChecks: { appearance: 'ok', brake: 'ok' },
  missing: new Set(),
  damagePhotos: [],
  inspectChecks: { brake: 'ok', belt: 'ok', accessories: 'ok' },
};

// ---------- 标签页 ----------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${btn.dataset.tab}`));
  refreshTab(btn.dataset.tab);
});

function refreshTab(tab) {
  if (tab === 'inventory') loadInventory();
  if (tab === 'cleaning') loadCleaning();
  if (tab === 'inspect') loadInspect();
  if (tab === 'repair') loadRepair();
  if (tab === 'deposit') loadDeposit();
  if (tab === 'rent') fillRentPoints();
  if (tab === 'return') loadReturnPoints();
}

// ---------- 点位库存 ----------
async function loadInventory() {
  state.points = await api('/api/points');
  renderMap();
  renderPointList();
  if (!state.selectedPointId && state.points.length) state.selectedPointId = state.points[0].id;
  await loadVehicles();
  updateCounts();
}

function renderMap() {
  const g = $('#mapPoints');
  g.innerHTML = state.points.map((p) => `
    <g class="map-point ${p.available === 0 ? 'empty' : ''} ${p.id === state.selectedPointId ? 'selected' : ''}"
       data-id="${p.id}" transform="translate(${p.map_x},${p.map_y})">
      <circle class="halo" r="6.5"/>
      <circle class="dot" r="4.2"/>
      <text y="1.5">${p.code}</text>
      <text class="name" y="9.5">${p.name} ${p.available}辆</text>
    </g>`).join('');
  g.querySelectorAll('.map-point').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedPointId = Number(el.dataset.id);
      renderMap(); renderPointList(); loadVehicles();
    });
  });
}

function renderPointList() {
  $('#pointList').innerHTML = state.points.map((p) => `
    <div class="point-item ${p.available === 0 ? 'empty' : ''} ${p.id === state.selectedPointId ? 'selected' : ''}" data-id="${p.id}">
      <div>
        <div class="pname">${p.name}</div>
        <div class="pmeta">在库 ${p.physical}/${p.capacity} · 借出 ${p.rented} · 清洁 ${p.pending_clean + p.cleaning} · 待复检 ${p.pending_inspect} · 维修 ${p.repair}</div>
      </div>
      <div class="avail"><b>${p.available}</b><span>可借</span></div>
    </div>`).join('');
  $$('#pointList .point-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedPointId = Number(el.dataset.id);
      renderMap(); renderPointList(); loadVehicles();
    });
  });
}

async function loadVehicles() {
  const p = state.points.find((x) => x.id === state.selectedPointId);
  $('#vehicleTableTitle').textContent = p ? `车辆库存 —— ${p.name}` : '车辆库存';
  if (!p) return;
  const vehicles = await api(`/api/vehicles?point_id=${p.id}`);
  $('#vehicleRows').innerHTML = vehicles.length ? vehicles.map((v) => `
    <tr>
      <td class="mono"><b>${v.code}</b></td>
      <td><span class="weight-max">≤ ${v.max_weight_kg} kg</span></td>
      <td>${v.has_canopy ? '✅' : '—'}</td>
      <td>${v.has_rain_cover ? '✅' : '⚠️ 无'}</td>
      <td>${vBadge(v.status)}${v.active_rental ? `<div class="hint mono">${v.active_rental.code}</div>` : ''}</td>
      <td>${badge(CLEAN_LABEL[v.status], v.status)}</td>
      <td>
        ${v.status === 'available' ? `<button class="btn sm ghost" data-transfer="${v.id}">调拨</button>` : ''}
        ${!['rented', 'repair'].includes(v.status) ? `<button class="btn sm danger" data-repair="${v.id}">报修</button>` : ''}
      </td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty-tip">该服务点暂无车辆</td></tr>`;

  $$('#vehicleRows [data-transfer]').forEach((b) => b.addEventListener('click', () => doTransfer(Number(b.dataset.transfer))));
  $$('#vehicleRows [data-repair]').forEach((b) => b.addEventListener('click', async () => {
    const issue = prompt('故障描述：', '刹车异响');
    if (issue === null) return;
    try {
      await api('/api/repairs', 'POST', { vehicleId: Number(b.dataset.repair), issue, staff: '员工-前台' });
      toast('已报修，车辆转入维修');
      loadInventory();
    } catch (e) { toast(e.message, true); }
  }));
}

async function doTransfer(vehicleId) {
  const targets = state.points.filter((p) => p.id !== state.selectedPointId);
  const names = targets.map((p, i) => `${i + 1}. ${p.name}（在库 ${p.physical}/${p.capacity}）`).join('\n');
  const pick = prompt(`调拨到哪个服务点？输入序号：\n${names}`, '1');
  const idx = Number(pick) - 1;
  if (!targets[idx]) return;
  try {
    await api('/api/transfers', 'POST', { vehicleId, toPointId: targets[idx].id, staff: '员工-前台' });
    toast(`已调拨至 ${targets[idx].name}`);
    loadInventory();
  } catch (e) { toast(e.message, true); }
}

// ---------- 借用核验 ----------
const rentState = () => state.rent;

function setRentStep(n) {
  const steps = $$('#rentSteps .step');
  steps.forEach((s, i) => { s.className = 'step ' + (i + 1 === n ? 'now' : i + 1 < n ? '' : 'todo'); });
  [1, 2, 3, 4].forEach((i) => { $(`#rentStep${i}`).style.display = i === n ? '' : 'none'; });
  if (n === 1) { $('#rentResult').innerHTML = ''; }
  $('#rentAlert').innerHTML = '';
}

function rentAlert(html, kind = 'err') {
  $('#rentAlert').innerHTML = html ? `<div class="alert ${kind}">${html}</div>` : '';
}

async function fillRentPoints() {
  state.points = await api('/api/points');
  const sel = $('#rentPoint');
  sel.innerHTML = state.points.map((p) => `<option value="${p.id}">${p.name}（可借 ${p.available}）</option>`).join('');
  updateRentPointHint();
  sel.onchange = updateRentPointHint;
}

function updateRentPointHint() {
  const p = state.points.find((x) => x.id === Number($('#rentPoint').value));
  const hint = $('#rentPointHint');
  if (!p) return;
  hint.textContent = p.available === 0
    ? `⚠️ 该服务点当前缺车，可前往：${state.points.filter((x) => x.available > 0).map((x) => `${x.name}（${x.available} 辆）`).join('、') || '暂无'}`
    : `该点可借 ${p.available} 辆`;
}

$('#btnMockScan').addEventListener('click', async () => {
  const pointId = Number($('#rentPoint').value);
  const vehicles = await api(`/api/vehicles?point_id=${pointId}`);
  const avail = vehicles.filter((v) => v.status === 'available');
  if (!avail.length) { rentAlert('该服务点当前<b>缺车</b>，请更换服务点或等待调拨。'); return; }
  const pick = avail[Math.floor(Math.random() * avail.length)];
  const scanned = await api('/api/scan', 'POST', { code: pick.code });
  $('#rentScanCode').value = scanned.scan.code;
  toast(`已扫码：${pick.code}`);
});

$('#btnLock').addEventListener('click', async () => {
  rentAlert('');
  const pointId = Number($('#rentPoint').value);
  const code = $('#rentScanCode').value.trim();
  if (!code) { rentAlert('请先扫码或输入车辆编号'); return; }
  try {
    const r = await api('/api/checkout/begin', 'POST', { vehicleCode: code, pointId, staff: '员工-前台' });
    state.rent = { lockToken: r.lockToken, vehicle: r.vehicle, pointId, checks: { brake: 'ok', belt: 'ok', canopy: 'ok', rain: 'ok', accessories: 'ok' } };
    $('#rainCheckItem').style.display = r.vehicle.has_rain_cover ? '' : 'none';
    toast(`已锁定 ${r.vehicle.code}（5 分钟内有效）`);
    setRentStep(2);
  } catch (e) {
    rentAlert(`<b>${e.code || '提示'}</b>：${e.message}`);
  }
});

$('#btnToCheck').addEventListener('click', () => {
  const w = Number($('#childWeight').value);
  const v = rentState()?.vehicle;
  if (v && w > v.max_weight_kg) {
    rentAlert(`儿童体重 ${w}kg 超过该车适用上限 <b>${v.max_weight_kg}kg</b>，提交后将被拒绝并释放车辆，建议更换大承重车辆。`, 'warn');
  } else rentAlert('');
  setRentStep(3);
});

// 借出检查：检查项开关 + 车辆轮廓标注联动
function bindCheckToggles(rootSel, checksObj, onChange) {
  $$(`${rootSel} .check-item`).forEach((item) => {
    const key = item.dataset.key;
    item.querySelectorAll('.toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        checksObj[key] = btn.dataset.v;
        item.querySelectorAll('.toggle button').forEach((b) => b.className = '');
        btn.className = btn.dataset.v === 'ok' ? 'on-ok' : 'on-bad';
        if (onChange) onChange(key, btn.dataset.v);
      });
    });
  });
}

bindCheckToggles('#rentStep3', {}, (key, val) => {
  if (!rentState()) return;
  rentState().checks[key] = val;
  syncHotspots();
});
// 上面的 checksObj 是临时对象，实际状态写进 rentState().checks
function syncHotspots() {
  const c = rentState()?.checks || {};
  $$('#strollerSvg .hotspot').forEach((h) => {
    const key = h.dataset.key; // canopy | belt | brake
    h.classList.toggle('bad', c[key] === 'bad');
  });
}
$$('#strollerSvg .hotspot').forEach((h) => {
  h.addEventListener('click', () => {
    if (!rentState()) return;
    const key = h.dataset.key;
    const cur = rentState().checks[key] === 'bad' ? 'ok' : 'bad';
    rentState().checks[key] = cur;
    const item = $(`#rentStep3 .check-item[data-key="${key}"]`);
    if (item) {
      item.querySelectorAll('.toggle button').forEach((b) => {
        b.className = b.dataset.v === cur ? (cur === 'ok' ? 'on-ok' : 'on-bad') : '';
      });
    }
    syncHotspots();
  });
});

$('#btnToSign').addEventListener('click', () => {
  const r = rentState();
  if (!r) return;
  const periodText = { '2h': '2 小时', halfday: '半日（4 小时）', fullday: '全日（至闭园）' }[$('#rentPeriod').value];
  $('#signSummary').textContent = `租借 ${r.vehicle.code} · ${periodText}`;
  $('#signName').value = $('#touristName').value;
  setRentStep(4);
});

async function cancelLock() {
  if (rentState()?.lockToken) {
    try { await api('/api/checkout/cancel', 'POST', { lockToken: rentState().lockToken, staff: '员工-前台' }); } catch (_) { /* 已失效 */ }
  }
  state.rent = null;
  setRentStep(1);
  fillRentPoints();
}
$('#btnCancelLock2').addEventListener('click', cancelLock);
$('#btnCancelLock3').addEventListener('click', cancelLock);
$('#btnCancelLock4').addEventListener('click', cancelLock);

$('#btnConfirmRent').addEventListener('click', () => doConfirmRent(false));

async function doConfirmRent(acceptNoRainCover) {
  const r = rentState();
  if (!r) return;
  const c = r.checks;
  try {
    const res = await api('/api/checkout/confirm', 'POST', {
      lockToken: r.lockToken,
      touristName: $('#touristName').value,
      touristPhone: $('#touristPhone').value,
      childWeightKg: Number($('#childWeight').value),
      period: $('#rentPeriod').value,
      checks: {
        brakeOk: c.brake !== 'bad',
        beltOk: c.belt !== 'bad',
        accessoriesOk: c.accessories !== 'bad' && c.canopy !== 'bad',
        rainCoverOk: c.rain !== 'bad',
      },
      acceptNoRainCover,
      staff: '员工-前台',
      signature: $('#signName').value,
    });
    const vcode = r.vehicle.code;
    state.rent = null;
    setRentStep(1);
    $('#rentResult').innerHTML = `
      <div class="card mt" style="max-width:560px">
        <h3>✅ 借出成功</h3>
        <div class="receipt">
          <div class="row"><span>租借单号</span><b class="mono">${res.rental.code}</b></div>
          <div class="row"><span>车辆</span><b class="mono">${vcode}</b></div>
          <div class="row"><span>应还时间</span><b>${fmtTime(res.rental.due_at)}</b></div>
          <div class="row"><span>押金（冻结）</span><b>${money(res.rental.deposit_amount)}</b></div>
          <div class="row total"><span>付款回执</span><span class="mono">${res.receipt.receiptNo}</span></div>
        </div>
        <div class="hint mt">可在任意服务点归还；归还后车辆将进入清洁消毒流程。</div>
      </div>`;
    toast('借出成功，押金已冻结');
    fillRentPoints();
  } catch (e) {
    if (e.code === 'RAIN_COVER_MISSING') {
      setRentStep(4);
      rentAlert(`<b>雨罩缺失</b>：${e.message}<br><button class="btn sun sm mt" id="btnAcceptNoRain">游客确认：无雨罩继续租借</button>`, 'warn');
      $('#btnAcceptNoRain').addEventListener('click', () => { rentAlert(''); doConfirmRent(true); });
    } else if (e.code === 'WEIGHT_EXCEEDED') {
      const sug = (e.details?.suggestions || []).map((s) => `${s.code}（≤${s.max_weight_kg}kg）`).join('、') || '本点暂无更大承重车辆';
      rentAlert(`<b>体重不符</b>：${e.message}<br>可选车辆：${sug}`);
      state.rent = null; setRentStep(1); fillRentPoints();
    } else if (['BRAKE_FAULT', 'BELT_FAULT', 'ACCESSORIES_MISSING'].includes(e.code)) {
      rentAlert(`<b>${e.message}</b><br>已自动生成维修工单（单号 ${e.details?.repairOrderId}），请为游客更换车辆。`);
      state.rent = null; setRentStep(1); fillRentPoints();
    } else {
      rentAlert(`<b>${e.code || '错误'}</b>：${e.message}`);
      if (e.code === 'LOCK_INVALID') { state.rent = null; setRentStep(1); }
    }
  }
}

// ---------- 跨点归还 ----------
async function loadReturnPoints() {
  state.points = await api('/api/points');
  if (state.returnRental) renderReturnPoints();
}

$('#btnReturnScan').addEventListener('click', async () => {
  const rentals = await api('/api/rentals?status=active');
  const overdue = await api('/api/rentals?status=overdue');
  const actives = [...rentals, ...overdue];
  if (!actives.length) { toast('当前没有在租订单', true); return; }
  const pick = actives[Math.floor(Math.random() * actives.length)];
  $('#returnScanCode').value = pick.code;
  findRental();
});
$('#btnFindRental').addEventListener('click', findRental);

async function findRental() {
  const code = $('#returnScanCode').value.trim();
  if (!code) return;
  try {
    const scanned = await api('/api/scan', 'POST', { code });
    let rental = scanned.rental;
    if (!rental && scanned.vehicle) {
      const actives = [...await api('/api/rentals?status=active'), ...await api('/api/rentals?status=overdue')];
      rental = actives.find((r) => r.vehicle_id === scanned.vehicle.id);
    }
    if (!rental) {
      // 可能是已归还单（演示幂等）
      const all = await api('/api/rentals');
      rental = all.find((r) => r.code === code);
      if (rental && rental.status === 'returned') {
        state.returnRental = rental;
        $('#returnFormCard').style.display = 'none';
        $('#rentalInfo').innerHTML = rentalCard(rental);
        $('#returnResult').innerHTML = `<div class="alert warn mt">该单已于 ${fmtTime(rental.returned_at)} 归还，退款回执 <b class="mono">${rental.refund_receipt || '—'}</b>。重复归还不会再次退款。</div>`;
        return;
      }
      throw new Error('未找到对应租借单');
    }
    state.returnRental = rental;
    state.returnPointId = rental.rent_point_id;
    state.missing = new Set();
    state.returnChecks = { appearance: 'ok', brake: 'ok' };
    resetReturnFormUI();
    $('#rentalInfo').innerHTML = rentalCard(rental);
    $('#returnFormCard').style.display = '';
    $('#returnResult').innerHTML = '';
    renderReturnPoints();
  } catch (e) {
    $('#rentalInfo').innerHTML = `<div class="alert err mt">${e.message}</div>`;
    $('#returnFormCard').style.display = 'none';
  }
}

function resetReturnFormUI() {
  $$('#returnFormCard .check-item').forEach((item) => {
    item.querySelectorAll('.toggle button').forEach((b) => {
      b.className = b.dataset.v === 'ok' ? 'on-ok' : '';
    });
  });
  $$('#missingChips .chip').forEach((c) => c.classList.remove('sel'));
  $('#damageFields').style.display = 'none';
  $('#damageNote').value = '';
  $('#damageFee').value = '0';
  $('#damagePhotos').value = '';
  $('#photoPreview').innerHTML = '';
  state.damagePhotos = [];
}

function rentalCard(r) {
  return `<div class="kv mt">
    <dt>租借单号</dt><dd class="mono">${r.code}</dd>
    <dt>游客</dt><dd>${r.tourist_name} · ${r.tourist_phone}</dd>
    <dt>儿童体重</dt><dd>${r.child_weight_kg} kg</dd>
    <dt>状态</dt><dd>${badge(RENTAL_LABEL[r.status], r.status)} 押金 ${badge(DEPOSIT_LABEL[r.deposit_status], r.deposit_status)}</dd>
    <dt>应还时间</dt><dd>${fmtTime(r.due_at)}${r.status === 'overdue' ? '（已超时）' : ''}</dd>
    <dt>押金</dt><dd>${money(r.deposit_amount)}</dd>
  </div>`;
}

function renderReturnPoints() {
  const r = state.returnRental;
  if (!r) return;
  $('#returnPointChips').innerHTML = state.points.map((p) => {
    const full = p.id !== r.rent_point_id && p.physical >= p.capacity;
    return `<button class="chip ${p.id === state.returnPointId ? 'sel' : ''} ${full ? 'full' : ''}"
      data-id="${p.id}" ${full ? 'disabled' : ''}
      title="${full ? '满仓，不可跨点归还' : ''}">${p.name}${p.id === r.rent_point_id ? '（原租借点）' : ''} ${p.physical}/${p.capacity}${full ? ' · 满仓' : ''}</button>`;
  }).join('');
  $$('#returnPointChips .chip').forEach((c) => c.addEventListener('click', () => {
    state.returnPointId = Number(c.dataset.id);
    renderReturnPoints();
  }));
}

bindCheckToggles('#returnFormCard', state.returnChecks, (key, val) => {
  state.returnChecks[key] = val;
  if (key === 'appearance') $('#damageFields').style.display = val === 'bad' ? '' : 'none';
});

$$('#missingChips .chip').forEach((c) => c.addEventListener('click', () => {
  const acc = c.dataset.acc;
  if (state.missing.has(acc)) { state.missing.delete(acc); c.classList.remove('sel'); }
  else { state.missing.add(acc); c.classList.add('sel'); }
}));

$('#damagePhotos').addEventListener('change', async (e) => {
  state.damagePhotos = [];
  $('#photoPreview').innerHTML = '';
  for (const f of e.target.files) {
    const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
    state.damagePhotos.push({ filename: f.name, dataBase64: dataUrl.split(',')[1] });
    $('#photoPreview').insertAdjacentHTML('beforeend', `<img src="${dataUrl}" alt="${f.name}">`);
  }
});

$('#btnDoReturn').addEventListener('click', async () => {
  const r = state.returnRental;
  if (!r) return;
  try {
    const res = await api('/api/returns', 'POST', {
      rentalCode: r.code,
      pointId: state.returnPointId,
      staff: '员工-前台',
      checks: { appearanceOk: state.returnChecks.appearance !== 'bad', brakeOk: state.returnChecks.brake !== 'bad' },
      missingAccessories: [...state.missing],
      damageNote: $('#damageNote').value,
      damageFee: Math.round(Number($('#damageFee').value || 0) * 100),
      damagePhotos: state.damagePhotos,
    });
    if (res.alreadyReturned) {
      $('#returnResult').innerHTML = `<div class="alert warn mt"><b>该单已归还</b>：退款回执 <span class="mono">${res.refund?.receiptNo || '—'}</span>，系统不会重复退款。</div>`;
      return;
    }
    const lines = [
      ['退款回执', `<span class="mono">${res.refund.receiptNo}</span>`],
      ['押金', money(res.rental.deposit_amount)],
    ];
    if (res.overtime.minutes > 0) lines.push([`超时 ${res.overtime.minutes} 分钟`, `-${money(res.overtime.fee)}`]);
    const missing = JSON.parse(res.rental.missing_accessories || '[]');
    if (missing.length) lines.push([`遗失配件 ${missing.length} 件`, `-${money(missing.length * 5000)}`]);
    if (res.rental.damage_note) lines.push([`损伤（${res.rental.damage_note}）`, '见扣款']);
    lines.push(['扣款合计', `-${money(res.deduction)}`]);
    $('#returnResult').innerHTML = `
      <div class="card mt" style="max-width:560px">
        <h3>${res.crossPoint ? '✅ 跨点归还成功' : '✅ 归还成功'}</h3>
        <div class="receipt">
          ${lines.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')}
          <div class="row total"><span>实退押金</span><span>${money(res.refund.amount)}</span></div>
        </div>
        <div class="hint mt">
          ${res.crossPoint ? '车辆归属已变更至归还服务点。' : ''}
          ${res.nextStatus === 'repair' ? '⚠️ 归还复核发现刹车异常，车辆已转维修。' : '车辆已进入清洁消毒队列，通过安全复检后恢复可借。'}
          ${res.photos?.length ? `损伤照片已存本地目录：${res.photos.join('、')}` : ''}
        </div>
      </div>`;
    $('#returnFormCard').style.display = 'none';
    toast('归还成功，押金已退');
    updateCounts();
  } catch (e) {
    $('#returnResult').innerHTML = `<div class="alert err mt"><b>${e.code || '错误'}</b>：${e.message}</div>`;
  }
});

// ---------- 清洁队列 ----------
async function loadCleaning() {
  const tasks = await api('/api/cleaning');
  const points = Object.fromEntries(state.points.map((p) => [p.id, p.name]));
  $('#cleaningRows').innerHTML = tasks.length ? tasks.map((t) => `
    <tr>
      <td class="mono">#${t.id}</td>
      <td class="mono"><b>${t.vehicle_code}</b></td>
      <td>${points[t.point_id] || t.point_id}</td>
      <td><span class="weight-max">≤ ${t.max_weight_kg} kg</span></td>
      <td>${badge({ queued: '待清洁', in_progress: '清洁中', done: '已完成' }[t.status], t.status)}</td>
      <td>${t.assignee || '—'}</td>
      <td>
        ${t.status === 'queued' ? `<button class="btn sm" data-start="${t.id}">开始清洁</button>` : ''}
        ${t.status !== 'done' ? `<button class="btn sm sun" data-finish="${t.id}">清洁完成</button>` : fmtTime(t.done_at)}
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-tip">清洁队列为空</td></tr>';
  $$('#cleaningRows [data-start]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/cleaning/${b.dataset.start}/start`, 'POST', { staff: '保洁-阿芳' }); loadCleaning(); updateCounts(); } catch (e) { toast(e.message, true); }
  }));
  $$('#cleaningRows [data-finish]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/cleaning/${b.dataset.finish}/finish`, 'POST', { staff: '保洁-阿芳' });
      toast('清洁完成，车辆待安全复检');
      loadCleaning(); updateCounts();
    } catch (e) { toast(e.message, true); }
  }));
}

// ---------- 车辆检查 ----------
async function loadInspect() {
  const vehicles = await api('/api/vehicles');
  const pending = vehicles.filter((v) => v.status === 'pending_inspect');
  $('#inspectList').innerHTML = pending.length ? pending.map((v) => `
    <div class="point-item">
      <div><div class="pname mono">${v.code}</div><div class="pmeta">体重上限 ≤ ${v.max_weight_kg}kg · ${vBadge(v.status)}</div></div>
    </div>`).join('') : '<div class="empty-tip">暂无待复检车辆</div>';
  $('#inspectVehicle').innerHTML = pending.map((v) => `<option value="${v.id}">${v.code}（≤${v.max_weight_kg}kg）</option>`).join('');

  const rows = await api('/api/inspections');
  const KIND = { pre_rental: '借出检查', post_clean: '清洁后复检', post_repair: '维修后复检' };
  $('#inspectionRows').innerHTML = rows.map((i) => `
    <tr>
      <td class="mono">${fmtTime(i.created_at)}</td>
      <td class="mono">${i.vehicle_code}</td>
      <td>${KIND[i.kind] || i.kind}</td>
      <td>${i.brake_ok ? '✅' : '❌'}</td><td>${i.belt_ok ? '✅' : '❌'}</td><td>${i.accessories_ok ? '✅' : '❌'}</td>
      <td>${badge(i.result === 'pass' ? '通过' : '未通过', i.result)}</td>
      <td>${i.inspector}${i.role === 'supervisor' ? '（主管）' : ''}</td>
    </tr>`).join('');
}

bindCheckToggles('#panel-inspect .card:nth-child(2)', state.inspectChecks, (k, v) => { state.inspectChecks[k] = v; });

$('#btnInspect').addEventListener('click', async () => {
  const vehicleId = Number($('#inspectVehicle').value);
  if (!vehicleId) { toast('暂无待复检车辆', true); return; }
  try {
    const res = await api('/api/inspections', 'POST', {
      vehicleId,
      kind: 'post_clean',
      brakeOk: state.inspectChecks.brake !== 'bad',
      beltOk: state.inspectChecks.belt !== 'bad',
      accessoriesOk: state.inspectChecks.accessories !== 'bad',
      inspector: $('#inspectorName').value,
      role: $('#inspectorRole').value,
      note: $('#inspectNote').value,
    });
    $('#inspectAlert').innerHTML = `<div class="alert ${res.result === 'pass' ? 'ok' : 'err'} mt">复检${res.result === 'pass' ? '通过，车辆恢复可借' : '未通过，车辆已转维修'}</div>`;
    loadInspect(); updateCounts();
  } catch (e) {
    $('#inspectAlert').innerHTML = `<div class="alert err mt"><b>${e.code || ''}</b> ${e.message}</div>`;
  }
});

// ---------- 维修工单 ----------
async function loadRepair() {
  const vehicles = await api('/api/vehicles');
  $('#repairVehicle').innerHTML = vehicles
    .filter((v) => !['rented', 'repair'].includes(v.status))
    .map((v) => `<option value="${v.id}">${v.code}（${STATUS_LABEL[v.status]}）</option>`).join('');
  const orders = await api('/api/repairs');
  $('#repairRows').innerHTML = orders.length ? orders.map((o) => `
    <tr>
      <td class="mono">#${o.id}</td>
      <td class="mono"><b>${o.vehicle_code}</b></td>
      <td>${o.point_name}</td>
      <td>${o.issue}</td>
      <td>${badge({ open: '待处理', in_repair: '维修中', fixed: '已修复' }[o.status], o.status)}</td>
      <td>${o.status !== 'fixed' ? `<button class="btn sm sun" data-fix="${o.id}">修复完成</button>` : fmtTime(o.resolved_at)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-tip">暂无维修工单</td></tr>';
  $$('#repairRows [data-fix]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/repairs/${b.dataset.fix}/fix`, 'POST', { staff: '维修-老赵' });
      toast('已修复，待主管安全复检');
      loadRepair(); updateCounts();
    } catch (e) { toast(e.message, true); }
  }));
}

$('#btnReportRepair').addEventListener('click', async () => {
  const vehicleId = Number($('#repairVehicle').value);
  if (!vehicleId) { toast('无可报修车辆', true); return; }
  try {
    await api('/api/repairs', 'POST', { vehicleId, issue: $('#repairIssue').value || '故障报修', staff: $('#repairStaff').value });
    $('#repairAlert').innerHTML = '<div class="alert ok mt">已报修，车辆转入维修状态</div>';
    loadRepair(); updateCounts();
  } catch (e) {
    $('#repairAlert').innerHTML = `<div class="alert err mt">${e.message}</div>`;
  }
});

// ---------- 押金复核 ----------
async function loadDeposit() {
  const rows = await api('/api/deposit-reviews');
  $('#depositRows').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td class="mono">#${r.id}</td>
      <td class="mono">${r.rental_code}</td>
      <td>${r.tourist_name}</td>
      <td>${money(r.deposit_amount)} / 扣 ${money(r.deduction)}</td>
      <td>${r.reason}</td>
      <td>${badge(r.status === 'pending' ? '待复核' : '已处理', r.status)}</td>
      <td>${r.status === 'pending' ? `<button class="btn sm" data-resolve="${r.id}">处理</button>` : (r.resolution || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-tip">暂无复核单</td></tr>';
  $$('#depositRows [data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    const input = prompt('处理意见（可前缀退款金额，如 "50 退还超时费" 表示追加退 ¥50）：', '退还超时扣款');
    if (input === null) return;
    const m = input.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
    const refundAmount = m ? Math.round(Number(m[1]) * 100) : 0;
    const resolution = m && m[2] ? m[2] : input;
    try {
      await api(`/api/deposit-reviews/${b.dataset.resolve}/resolve`, 'POST', { resolution, refundAmount, staff: '主管-李' });
      toast('复核已处理');
      loadDeposit(); updateCounts();
    } catch (e) { toast(e.message, true); }
  }));
}

$('#btnDispute').addEventListener('click', async () => {
  try {
    await api('/api/deposit-reviews', 'POST', {
      rentalCode: $('#disputeRental').value.trim(),
      reason: $('#disputeReason').value,
      staff: '员工-前台',
    });
    $('#depositAlert').innerHTML = '<div class="alert ok mt">已提交，等待主管复核</div>';
    loadDeposit(); updateCounts();
  } catch (e) {
    $('#depositAlert').innerHTML = `<div class="alert err mt">${e.message}</div>`;
  }
});

// ---------- 提醒（超时 / 调拨） ----------
async function loadNotifications() {
  const notes = await api('/api/notifications');
  $('#bellBadge').textContent = notes.length;
  const TYPE = { overdue: '⏰ 超时', transfer_reminder: '🔁 调拨', stockout: '⚠️ 缺车' };
  $('#bellPanel').innerHTML = notes.length
    ? notes.map((n) => `<div class="note"><span class="tag">${TYPE[n.type] || n.type}</span>${n.message}<div class="t">${fmtTime(n.created_at)}</div></div>`).join('')
    : '<div class="note">暂无提醒</div>';
}
$('#bellBtn').addEventListener('click', () => {
  $('#bellPanel').classList.toggle('open');
  loadNotifications();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.bell') && !e.target.closest('.bell-panel')) $('#bellPanel').classList.remove('open');
});

async function updateCounts() {
  const d = await api('/api/dashboard');
  $('#cntCleaning').textContent = d.cleaningBacklog || '';
  $('#cntInspect').textContent = d.points.reduce((s, p) => s + p.pending_inspect, 0) || '';
  $('#cntRepair').textContent = d.openRepairs || '';
  $('#cntDeposit').textContent = d.pendingReviews || '';
  $('#bellBadge').textContent = d.notifications.length;
}

// ---------- 启动 ----------
(async function init() {
  await loadInventory();
  await loadNotifications();
  setInterval(() => { updateCounts(); loadNotifications(); }, 15000);
})();
