/* 云栖谷婴儿车周转平台 —— 前端交互（原生 JS，无依赖） */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  points: [], vehicles: [], staff: [], reminders: [],
  actor: null, filterPoint: null, rentalTab: "active",
  rent: null,          // 借出流程上下文
  currentRental: null, // 归还上下文
};

const STATUS_TEXT = {
  available: "可借", reserved: "已锁定", on_rent: "在租",
  cleaning: "待清洁", maintenance: "维修中",
};
const POINT_NAME = id => state.points.find(p => p.id === id)?.name || id;

async function api(path, body) {
  const opt = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) };
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || "请求失败");
    e.code = data.error; e.extra = data.extra || {};
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3600);
}

const isSupervisor = () => state.actor?.role === "supervisor";

/* ---------------- 总览渲染 ---------------- */

async function loadOverview() {
  const d = await api("/api/overview");
  state.points = d.points; state.vehicles = d.vehicles;
  state.staff = d.staff; state.reminders = d.reminders;
  if (!state.actor) {
    $("#actor").innerHTML = d.staff.map(s =>
      `<option value="${s.id}">${s.name}（${s.role === "supervisor" ? "主管" : "员工"} · ${s.id}）</option>`).join("");
    state.actor = d.staff[0];
  }
  renderActor();
  renderMap();
  renderPoints();
  renderFleet();
  renderTasks(d.tasks);
  renderReminders();
}

async function loadSideLists() {
  const [cleaning, wos, rentals] = await Promise.all([
    api("/api/cleaning"),
    api("/api/workorders"),
    api(`/api/rentals?status=${rentalStatusParam()}`),
  ]);
  renderCleaning(cleaning);
  renderWorkOrders(wos);
  state.rentals = rentals;
  renderRentals(rentals);
}

function rentalStatusParam() {
  return { active: "active", disputed: "disputed", all: "" }[state.rentalTab];
}

function renderActor() {
  $("#actor").value = state.actor.id;
  $("#actorRole").textContent = isSupervisor() ? "点位主管" : "普通员工";
}

function renderMap() {
  const g = $("#mapPoints");
  g.innerHTML = state.points.map((p, i) => {
    const cls = p.available === 0 ? "soldout" : p.full ? "full" : "";
    const sel = state.filterPoint === p.id ? "selected" : "";
    return `<g class="map-point ${cls} ${sel}" data-point="${p.id}" transform="translate(${p.x},${p.y})">
      <circle class="ring" r="4.2"></circle>
      <text>${p.available}</text>
      <text class="pname" y="7.5">${p.name.replace("服务点", "")}</text>
    </g>`;
  }).join("");
  $$(".map-point", g).forEach(el => el.onclick = () => {
    state.filterPoint = state.filterPoint === el.dataset.point ? null : el.dataset.point;
    $("#fleetFilter").textContent = state.filterPoint
      ? POINT_NAME(state.filterPoint) : "全部点位";
    renderMap(); renderFleet();
  });
}

function renderPoints() {
  $("#pointList").innerHTML = state.points.map(p => {
    const cls = p.available === 0 ? "zero" : p.available <= 1 ? "warn" : "ok";
    const sel = state.filterPoint === p.id ? "selected" : "";
    return `<li class="${sel}" data-point="${p.id}">
      <div><div class="p-name">${p.name}</div>
      <div class="p-meta">在库 ${p.onsite}/${p.capacity}${p.full ? " · 已满仓" : ""}</div></div>
      <span class="stock-pill ${cls}">可借 ${p.available}</span>
    </li>`;
  }).join("");
  $$("#pointList li").forEach(li => li.onclick = () => {
    state.filterPoint = state.filterPoint === li.dataset.point ? null : li.dataset.point;
    $("#fleetFilter").textContent = state.filterPoint
      ? POINT_NAME(state.filterPoint) : "全部点位";
    renderMap(); renderFleet();
  });
}

function accessories(v) {
  const item = (ok, name) =>
    `<span class="accessory ${ok ? "ok" : "missing"}">${ok ? "✓" : "✕"}${name}</span>`;
  return item(v.canopy, "遮阳篷") + item(v.harness, "安全带") +
         item(v.rain_cover, "雨罩") + item(v.brakes_ok, "刹车");
}

function renderFleet() {
  const rows = state.vehicles.filter(v => !state.filterPoint || v.current_point_id === state.filterPoint);
  $("#fleetBody").innerHTML = rows.map(v => `
    <tr>
      <td class="vehicle-id">${v.id}</td>
      <td>${POINT_NAME(v.current_point_id).replace("服务点", "")}</td>
      <td class="weight-cell"><b>${v.weight_limit}</b> kg</td>
      <td>${accessories(v)}</td>
      <td><span class="clean-badge ${v.cleanliness}">${v.cleanliness === "clean" ? "已清洁" : "待清洁"}</span></td>
      <td><span class="status-chip ${v.status}">${STATUS_TEXT[v.status]}</span>
          ${v.open_work_orders ? `<span class="clean-badge dirty">工单×${v.open_work_orders}</span>` : ""}</td>
      <td>${fleetActions(v)}</td>
    </tr>`).join("");
  $$("#fleetBody button[data-act]").forEach(b => b.onclick = () => fleetAction(b));
}

function fleetActions(v) {
  const btns = [];
  if (v.status === "available")
    btns.push(`<button class="btn btn-green sm" data-act="rent" data-v="${v.id}">借出</button>`);
  if (v.status === "cleaning") {
    btns.push(`<button class="btn btn-yellow sm" data-act="clean" data-v="${v.id}"
      ${v.cleanliness === "clean" ? "disabled" : ""}>清洁完成</button>`);
    btns.push(`<button class="btn btn-green sm" data-act="recheck" data-v="${v.id}">安全复检</button>`);
  }
  if (v.status !== "maintenance" && v.status !== "on_rent" && v.status !== "reserved")
    btns.push(`<button class="btn btn-ghost sm" data-act="transfer" data-v="${v.id}">调拨</button>`);
  if (v.status !== "maintenance")
    btns.push(`<button class="btn btn-red sm" data-act="repair" data-v="${v.id}">报修</button>`);
  return btns.join(" ");
}

function fleetAction(btn) {
  const v = state.vehicles.find(x => x.id === btn.dataset.v);
  ({
    rent: () => openRent(v),
    clean: () => doClean(v),
    recheck: () => openRecheck(v),
    repair: () => openRepair(v),
    transfer: () => openTransfer(v),
  })[btn.dataset.act]();
}

function renderCleaning(list) {
  $("#cleaningList").innerHTML = list.length ? list.map(c => `
    <li><div class="row">
      <b>${c.vehicle_id}</b><span>${(c.point_name || "").replace("服务点", "")}</span>
    </div><div class="issue">归还于 ${c.returned_at || "—"} · 等待清洁消毒</div></li>`).join("")
    : `<li class="empty">清洁队列为空</li>`;
}

function renderWorkOrders(list) {
  $("#woList").innerHTML = list.length ? list.map(w => `
    <li><div class="row"><b>${w.vehicle_id}</b>
      <span class="status-chip maintenance">${w.status === "open" ? "待修" : "维修中"}</span></div>
      <div class="issue">${w.issue}</div>
      <div class="row"><span class="issue">报修 ${w.reported_by}</span>
        <button class="btn btn-green sm" data-wo="${w.id}" data-v="${w.vehicle_id}">维修完工${isSupervisor() ? "" : "（主管）"}</button>
      </div></li>`).join("") : `<li class="empty">暂无维修工单</li>`;
  $$("#woList button[data-wo]").forEach(b => b.onclick = () => {
    if (!isSupervisor()) return toast("维修完工须由点位主管确认", true);
    openResolve(b.dataset.wo, b.dataset.v);
  });
}

function renderRentals(list) {
  const el = $("#rentalList");
  if (!list.length) { el.innerHTML = `<li class="mini-list" style="padding:0"><div class="empty">暂无单据</div></li>`; return; }
  el.innerHTML = list.map(r => {
    const chip = r.status === "overdue"
      ? '<span class="status-chip maintenance">超时</span>'
      : r.status === "disputed"
      ? '<span class="status-chip maintenance">押金争议</span>'
      : r.status === "active"
      ? '<span class="status-chip on_rent">在租</span>'
      : `<span class="status-chip available">${r.status === "returned" ? "已归还" : r.status}</span>`;
    const cross = r.return_point_id && r.return_point_id !== r.pickup_point_id;
    return `<li>
      <div class="r-top"><span class="r-id">${r.id}</span>${chip}</div>
      <div class="r-detail">
        <span>🚗 ${r.vehicle_id}</span><span>👶 ${r.visitor_name} · ${r.visitor_weight}kg</span><br>
        <span>借：${POINT_NAME(r.pickup_point_id).replace("服务点", "")}</span>
        ${r.return_point_id ? `<span>还：${POINT_NAME(r.return_point_id).replace("服务点", "")}${cross ? "（跨点）" : ""}</span>` : ""}
        <span>应还 ${r.booked_to}</span><br>
        <span>押金 ¥${(r.deposit_cents / 100).toFixed(0)}${r.deposit_refunded ? " · 已退 " + (r.refund_ref || "") : " · 冻结中"}</span>
      </div>
      <div class="r-actions">${rentalActions(r)}</div>
    </li>`;
  }).join("");
  $$("#rentalList button[data-act]").forEach(b => b.onclick = () => rentalAction(b));
}

function rentalActions(r) {
  const btns = [];
  if (["active", "overdue"].includes(r.status))
    btns.push(`<button class="btn btn-green sm" data-act="return" data-r="${r.id}">办理归还</button>`);
  if (r.status === "disputed")
    btns.push(`<button class="btn btn-yellow sm" data-act="review" data-r="${r.id}"
      ${isSupervisor() ? "" : "disabled"}>押金复核${isSupervisor() ? "" : "（主管）"}</button>`);
  return btns.join(" ");
}

function rentalAction(btn) {
  const r = state.rentals?.find(x => x.id === btn.dataset.r) || { id: btn.dataset.r };
  if (btn.dataset.act === "return") openReturn(r.id);
  if (btn.dataset.act === "review") {
    if (!isSupervisor()) return toast("押金复核须点位主管处理", true);
    openReview(r.id);
  }
}

function renderTasks(tasks) {
  $("#taskList").innerHTML = tasks.length ? tasks.map(t => {
    const label = t.kind === "overdue" ? "⏰ 超时标记" : t.kind === "transfer_reminder" ? "🔁 调拨提醒" : "⚠ 任务异常";
    return `<li><b>${label}</b> ${t.at}：${t.result.map(x =>
      typeof x === "string" ? x : `${x.vehicle_id} → ${POINT_NAME(x.to_point).replace("服务点", "")}`).join("、")}</li>`;
  }).join("") : `<li>暂无后台任务触发</li>`;
}

function renderReminders() {
  $("#reminderList").innerHTML = state.reminders.length ? state.reminders.map(t =>
    `<li>🔁 <b>${t.vehicle_id}</b> ${POINT_NAME(t.from_point).replace("服务点", "")} →
     ${POINT_NAME(t.to_point).replace("服务点", "")}
     <button class="btn btn-green sm" data-tr="${t.id}" data-v="${t.vehicle_id}" data-to="${t.to_point}">立即调拨</button></li>`
  ).join("") : `<li>暂无调拨提醒</li>`;
  $$("#reminderList button[data-tr]").forEach(b => b.onclick = async () => {
    try {
      await api("/api/transfer", { vehicle_id: b.dataset.v, to_point_id: b.dataset.to,
                                   actor_id: state.actor.id });
      toast(`已调拨 ${b.dataset.v} 至${POINT_NAME(b.dataset.to)}`);
      refreshAll();
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------------- 借出流程 ---------------- */

function openDrawer(id) { $("#" + id).classList.remove("hidden"); }
function closeDrawer(id) { $("#" + id).classList.add("hidden"); }
$$("[data-close]").forEach(b => b.onclick = () => closeDrawer(b.dataset.close));

function openRent(v) {
  state.rent = { vehicle: v, step: 1, checks: { brakes_ok: true, harness_ok: true,
                                               canopy_ok: true, rain_cover_ok: true } };
  openDrawer("rentDrawer");
  renderRentStep();
}

function renderRentStep() {
  const ctx = state.rent;
  const v = ctx.vehicle;
  const wrap = $("#rentStepWrap");
  if (ctx.step === 1) {
    wrap.innerHTML = `<h2>借出 · 第 1 步 / 扫码核验</h2>
      <p class="sign-meta">已选车辆 <b>${v.id}</b>（${POINT_NAME(v.current_point_id)}），也可扫码确认：</p>
      <div class="form-row"><input id="qrInput" placeholder="扫描车辆二维码，如 VHC-${v.id}" value="VHC-${v.id}"></div>
      <div class="step-result">车辆：${v.id}　承重上限 <b>${v.weight_limit}kg</b><br>
        配件：${accessories(v)}</div>
      <button class="btn btn-green" id="scanBtn">扫码确认</button>
      <button class="btn btn-ghost" id="skipScan">车辆无误，下一步</button>`;
    $("#skipScan").onclick = () => { ctx.step = 2; renderRentStep(); };
    $("#scanBtn").onclick = async () => {
      try {
        const r = await api("/api/scan", { qr: $("#qrInput").value.trim() });
        if (r.vehicle_id !== v.id) { toast("二维码与所选车辆不一致", true); return; }
        ctx.vehicle = r.vehicle;
        ctx.step = 2; renderRentStep();
      } catch (e) { toast(e.message, true); }
    };
  }
  if (ctx.step === 2) {
    wrap.innerHTML = `<h2>借出 · 第 2 步 / 游客信息与资格</h2>
      <div class="form-row"><label>游客姓名（样例）</label>
        <input id="visitorName" placeholder="如：林朵朵" value="林朵朵（样例）"></div>
      <div class="form-row"><label>宝宝体重 kg（用于承重核验）</label>
        <input id="visitorWeight" type="number" step="0.5" value="12"></div>
      <div id="eligResult"></div>
      <button class="btn btn-green" id="eligBtn">核验资格</button>
      <button class="btn btn-ghost" id="back2">上一步</button>`;
    $("#back2").onclick = () => { ctx.step = 1; renderRentStep(); };
    $("#eligBtn").onclick = async () => {
      try {
        const r = await api("/api/eligibility", {
          vehicle_id: v.id, visitor_weight: parseFloat($("#visitorWeight").value),
          pickup_point_id: v.current_point_id });
        ctx.visitor_name = $("#visitorName").value.trim() || "样例游客";
        ctx.visitor_weight = parseFloat($("#visitorWeight").value);
        if (r.eligible) {
          $("#eligResult").innerHTML =
            `<div class="step-result">✓ 体重、库存、雨罩、刹车均符合，可以检查车辆</div>`;
          ctx.step = 3; renderRentStep();
        } else {
          $("#eligResult").innerHTML = r.problems.map(p =>
            `<div class="step-result err">✕ ${p.message}</div>`).join("");
        }
      } catch (e) { toast(e.message, true); }
    };
  }
  if (ctx.step === 3) {
    const c = ctx.checks;
    wrap.innerHTML = `<h2>借出 · 第 3 步 / 车辆安全检查</h2>
      <p class="sign-meta">请逐项试用并点击图上标注位置，向游客确认后锁定车辆。</p>
      ${silhouetteSvg(c)}
      ${checkRow("brakes_ok", "刹车", "捏下刹车，确认两轮刹停、不溜车", c)}
      ${checkRow("harness_ok", "安全带", "五点式卡扣扣合，拉紧不松脱", c)}
      ${checkRow("canopy_ok", "遮阳篷", "篷布完整无破洞，支架开合顺畅", c)}
      ${checkRow("rain_cover_ok", "雨罩", "雨罩在车筐内，无缺失破损", c)}
      <div class="form-row"><textarea id="inspectNote" placeholder="检查备注（可选）"></textarea></div>
      <button class="btn btn-green" id="inspectBtn">检查无误，提交检查</button>
      <button class="btn btn-ghost" id="back3">上一步</button>
      <div id="inspectResult"></div>`;
    bindSilhouette(c, () => renderRentStep());
    $("#back3").onclick = () => { ctx.step = 2; renderRentStep(); };
    $("#inspectBtn").onclick = async () => {
      try {
        await api("/api/inspect/pre", {
          vehicle_id: v.id, pickup_point_id: v.current_point_id,
          brakes_ok: c.brakes_ok, harness_ok: c.harness_ok,
          canopy_ok: c.canopy_ok, rain_cover_ok: c.rain_cover_ok,
          note: $("#inspectNote").value, actor_id: state.actor.id });
        ctx.step = 4; renderRentStep();
      } catch (e) {
        toast(e.message, true);
        if (e.code === "inspection_failed") { closeDrawer("rentDrawer"); refreshAll(); }
      }
    };
  }
  if (ctx.step === 4) {
    wrap.innerHTML = `<h2>借出 · 第 4 步 / 锁定与押金</h2>
      <div class="step-result">检查已通过。点击锁定后，车辆将为本单保留（其他终端无法再借），
        并预授权押金 <b>¥300.00</b>（模拟付款回执）。</div>
      <button class="btn btn-yellow" id="lockBtn" style="width:100%;padding:14px;font-size:16px">
        确认锁定车辆并预授权押金</button>
      <div id="lockResult"></div>`;
    $("#lockBtn").onclick = async () => {
      try {
        const r = await api("/api/lock", {
          vehicle_id: v.id, visitor_name: ctx.visitor_name,
          visitor_weight: ctx.visitor_weight, pickup_point_id: v.current_point_id,
          actor_id: state.actor.id });
        ctx.rental_id = r.rental_id; ctx.receipt = r.deposit_receipt;
        ctx.slot = `${r.booked_from} ～ ${r.booked_to}`;
        closeDrawer("rentDrawer");
        $("#signMeta").textContent =
          `${v.id} · 单号 ${r.rental_id} · 时段 ${r.booked_from} ～ ${r.booked_to} · 押金回执 ${r.deposit_receipt}`;
        $("#signName").value = ctx.visitor_name.replace("（样例）", "");
        openDrawer("signPage");
        refreshAll();
      } catch (e) {
        toast(e.message, true);
        if (["no_stock", "rain_cover_missing", "inspection_failed"].includes(e.code))
          closeDrawer("rentDrawer");
        refreshAll();
      }
    };
  }
}

function checkRow(key, title, hint, c) {
  const stateCls = c[key] ? "" : "bad";
  return `<label class="check-row ${stateCls}">
    <input type="checkbox" data-check="${key}" ${c[key] ? "checked" : ""}>
    <span><b>${title}</b><span class="hint">${hint}</span></span></label>`;
}

/* 车辆轮廓：标注刹车、篷布（遮阳篷）、安全带、雨罩位置 */
function silhouetteSvg(c) {
  const cls = key => c[key] ? "checked" : "fault";
  return `<svg class="silhouette" viewBox="0 0 200 130">
    <!-- 地面 -->
    <line x1="6" y1="108" x2="194" y2="108" stroke="#cfe0d5" stroke-width="1.5" stroke-dasharray="4 4"/>
    <!-- 推把 -->
    <path d="M150 46 L176 30" stroke="#2f6b4f" stroke-width="4" fill="none" stroke-linecap="round"/>
    <!-- 遮阳篷 -->
    <path d="M52 52 C58 24, 118 22, 128 52 Z" fill="#dfeee2" stroke="#2f6b4f" stroke-width="2.2"/>
    <!-- 雨罩（前挂） -->
    <path d="M46 54 C36 66, 40 86, 56 90 L78 90 L78 56 Z" fill="#eef5fb" stroke="#356a8f" stroke-width="1.8" stroke-dasharray="3 2"/>
    <!-- 车筐/座椅 -->
    <path d="M56 54 L132 54 L142 92 L60 92 Z" fill="#f6c945" stroke="#224f3a" stroke-width="2.2"/>
    <!-- 安全带（五点式） -->
    <path d="M86 56 L96 78 M108 56 L98 78 M80 80 L116 80" stroke="#224f3a" stroke-width="2.4" fill="none"/>
    <rect x="92" y="74" width="10" height="8" rx="2" fill="#224f3a"/>
    <!-- 车架 -->
    <path d="M70 92 L84 106 M126 92 L112 106" stroke="#224f3a" stroke-width="3"/>
    <!-- 轮子 -->
    <circle cx="84" cy="108" r="11" fill="none" stroke="#224f3a" stroke-width="3"/>
    <circle cx="112" cy="108" r="11" fill="none" stroke="#224f3a" stroke-width="3"/>
    <!-- 刹车（后轮旁） -->
    <path d="M72 104 L60 98" stroke="#c44b3f" stroke-width="3" stroke-linecap="round"/>
    <!-- 标注热点 -->
    <g class="part ${cls("canopy_ok")}" data-part="canopy_ok" transform="translate(92,32)">
      <circle r="9"/><text>篷</text></g>
    <text class="part-label" x="92" y="20" text-anchor="middle">遮阳篷</text>
    <g class="part ${cls("harness_ok")}" data-part="harness_ok" transform="translate(98,68)">
      <circle r="9"/><text>带</text></g>
    <text class="part-label" x="98" y="62" text-anchor="middle" style="font-size:8px">安全带</text>
    <g class="part ${cls("brakes_ok")}" data-part="brakes_ok" transform="translate(52,96)">
      <circle r="9"/><text>刹</text></g>
    <text class="part-label" x="52" y="118" text-anchor="middle">刹车</text>
    <g class="part ${cls("rain_cover_ok")}" data-part="rain_cover_ok" transform="translate(56,64)">
      <circle r="9"/><text>罩</text></g>
    <text class="part-label" x="46" y="46" text-anchor="middle">雨罩</text>
  </svg>`;
}

function bindSilhouette(c, onChange) {
  $$("#rentStepWrap input[data-check]").forEach(i => i.onchange = () => {
    c[i.dataset.check] = i.checked; onChange();
  });
  $$("#rentStepWrap .part[data-part]").forEach(p => p.onclick = () => {
    c[p.dataset.part] = !c[p.dataset.part]; onChange();
  });
}

/* 签署交车 */
$("#signConfirm").onclick = async () => {
  const signature = $("#signName").value.trim();
  if (!signature) return toast("请游客输入签名", true);
  try {
    await api("/api/checkout", { rental_id: state.rent.rental_id, signature,
                                 actor_id: state.actor.id });
    closeDrawer("signPage");
    toast(`交车成功：${state.rent.rental_id}，祝游玩愉快！`);
    refreshAll();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- 归还流程 ---------------- */

async function openReturn(rentalId) {
  const all = await api("/api/rentals?status=");
  const r = all.find(x => x.id === rentalId);
  if (!r) return toast("租借单不存在", true);
  state.currentRental = r;
  openDrawer("returnDrawer");
  const v = state.vehicles.find(x => x.id === r.vehicle_id) || { current_point_id: r.pickup_point_id };
  const crossPoints = state.points.filter(p => p.id !== v.current_point_id);
  $("#returnStepWrap").innerHTML = `
    <div class="step-result">单号 <b>${r.id}</b> · 车辆 ${r.vehicle_id} · ${r.visitor_name}<br>
      借出点：${POINT_NAME(r.pickup_point_id)}　应还：${r.booked_to}
      ${r.status === "overdue" ? "<br><b style='color:#c44b3f'>该单已超时，将按规定收取超时费 ¥50</b>" : ""}</div>
    <div class="form-row"><label>归还服务点（可跨点）</label>
      <select id="returnPoint">
        ${state.points.map(p => `<option value="${p.id}" ${p.id === v.current_point_id ? "selected" : ""}
          ${p.full ? "disabled" : ""}>${p.name}${p.full ? "（满仓，不可还入）" : `（在库 ${p.onsite}/${p.capacity}）`}</option>`).join("")}
      </select></div>
    <label class="check-row"><input type="checkbox" id="appearance" checked>
      <span><b>外观完好</b><span class="hint">车身、车轮、推把无新增磕碰损坏</span></span></label>
    <label class="check-row"><input type="checkbox" id="accessories" checked>
      <span><b>附件齐全</b><span class="hint">遮阳篷、安全带、雨罩均在且完好</span></span></label>
    <label class="check-row"><input type="checkbox" id="dispute">
      <span><b>游客对扣费/损坏有异议</b><span class="hint">勾选后押金冻结，转点位主管复核</span></span></label>
    <div class="form-row"><textarea id="damageNote" placeholder="损伤 / 争议备注（可选）"></textarea></div>
    <button class="btn btn-green" id="returnBtn" style="width:100%;padding:13px">确认归还并复核退款</button>`;
  $("#returnBtn").onclick = submitReturn;
}

async function submitReturn() {
  const r = state.currentRental;
  try {
    const res = await api("/api/return", {
      rental_id: r.id, return_point_id: $("#returnPoint").value,
      actor_id: state.actor.id,
      appearance_ok: $("#appearance").checked,
      accessories_ok: $("#accessories").checked,
      damage_note: $("#damageNote").value,
      dispute: $("#dispute").checked,
    });
    closeDrawer("returnDrawer");
    toast(res.message + (res.idempotent ? "（幂等）" : ""), res.status === "disputed");
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 清洁 / 复检 / 维修 / 调拨 / 押金 ---------------- */

async function doClean(v) {
  try {
    const r = await api("/api/cleaning/complete", { vehicle_id: v.id,
                                                    actor_id: state.actor.id });
    toast(r.message);
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

function openRecheck(v) {
  $("#actionWrap").innerHTML = `<h2>安全复检 · ${v.id}</h2>
    ${!isSupervisor() ? `<div class="step-result err">安全复检仅点位主管可执行，请切换主管账号（M01/M02）。</div>` : `
    ${v.cleanliness !== "clean" ? `<div class="step-result err">车辆尚未完成清洁消毒，复检不能通过（清洁阻断）。请先完成清洁。</div>` : ""}
    <label class="check-row"><input type="checkbox" id="reBrakes" checked>
      <span><b>刹车复检正常</b><span class="hint">清洁后再次确认制动有效</span></span></label>
    <div class="form-row"><textarea id="reNote" placeholder="复检备注（可选）"></textarea></div>
    <div class="sign-actions">
      <button class="btn btn-green big" id="rePass">复检通过，恢复可借</button>
      <button class="btn btn-red big" id="reFail">不通过，转维修</button>
    </div>`}`;
  openDrawer("actionDrawer");
  if (!isSupervisor()) return;
  $("#rePass")?.addEventListener("click", () => submitRecheck(v, true));
  $("#reFail")?.addEventListener("click", () => submitRecheck(v, false));
}

async function submitRecheck(v, passed) {
  try {
    const r = await api("/api/recheck", { vehicle_id: v.id, actor_id: state.actor.id,
      passed, brakes_ok: $("#reBrakes").checked, note: $("#reNote").value });
    closeDrawer("actionDrawer");
    toast(passed ? `${v.id} 复检通过，已恢复可借` : `${v.id} 复检未过，已转维修`);
    refreshAll();
  } catch (e) { toast(e.message, true); }
}

function openRepair(v) {
  $("#actionWrap").innerHTML = `<h2>报修 · ${v.id}</h2>
    <p class="sign-meta">普通员工即可报修；报修后车辆进入维修，不能调拨、不能借出。</p>
    <div class="form-row"><label>故障描述</label>
      <textarea id="repairIssue" placeholder="如：刹车疲软，捏到底仍溜车"></textarea></div>
    <button class="btn btn-red" id="repairBtn" style="width:100%">提交报修工单</button>`;
  openDrawer("actionDrawer");
  $("#repairBtn").onclick = async () => {
    try {
      const r = await api("/api/repair", { vehicle_id: v.id,
        issue: $("#repairIssue").value, actor_id: state.actor.id });
      closeDrawer("actionDrawer");
      toast(`已开工单 ${r.work_order_id}，车辆转维修`);
      refreshAll();
    } catch (e) { toast(e.message, true); }
  };
}

function openResolve(woId, vid) {
  $("#actionWrap").innerHTML = `<h2>维修完工 · ${vid}</h2>
    <p class="sign-meta">工单 ${woId}。修复后车辆进入待清洁，完成清洁并复检通过后才可再借。</p>
    <label class="check-row"><input type="checkbox" id="coverFitted">
      <span><b>已补装雨罩</b><span class="hint">若原车雨罩缺失/损坏且已换新请勾选</span></span></label>
    <button class="btn btn-green" id="resolveBtn" style="width:100%">主管确认完工</button>`;
  openDrawer("actionDrawer");
  $("#resolveBtn").onclick = async () => {
    try {
      await api("/api/repair/resolve", { work_order_id: woId, actor_id: state.actor.id,
        rain_cover_fitted: $("#coverFitted").checked });
      closeDrawer("actionDrawer");
      toast("工单已完工，车辆进入清洁队列");
      refreshAll();
    } catch (e) { toast(e.message, true); }
  };
}

function openTransfer(v) {
  $("#actionWrap").innerHTML = `<h2>调拨 · ${v.id}</h2>
    <p class="sign-meta">当前位于${POINT_NAME(v.current_point_id)}。维修中车辆不可调拨。</p>
    <div class="form-row"><label>目标服务点</label><select id="toPoint">
      ${state.points.filter(p => p.id !== v.current_point_id).map(p =>
        `<option value="${p.id}" ${p.full ? "disabled" : ""}>${p.name}
          ${p.full ? "（满仓）" : `（在库 ${p.onsite}/${p.capacity}）`}</option>`).join("")}
    </select></div>
    <button class="btn btn-green" id="transferBtn" style="width:100%">确认调拨</button>`;
  openDrawer("actionDrawer");
  $("#transferBtn").onclick = async () => {
    try {
      await api("/api/transfer", { vehicle_id: v.id, to_point_id: $("#toPoint").value,
                                   actor_id: state.actor.id });
      closeDrawer("actionDrawer");
      toast("调拨完成，归属位置已更新");
      refreshAll();
    } catch (e) { toast(e.message, true); }
  };
}

async function openReview(rentalId) {
  const all = await api("/api/rentals?status=disputed");
  const r = all.find(x => x.id === rentalId);
  $("#actionWrap").innerHTML = `<h2>押金复核 · ${rentalId}</h2>
    <div class="step-result">押金 ¥${(r.deposit_cents / 100).toFixed(0)} 冻结中。
      请核对损伤照片与备注后决定扣除金额。</div>
    <div class="form-row"><label>扣除金额（元）</label>
      <input id="deduct" type="number" min="0" max="300" step="10" value="0"></div>
    <div class="form-row"><textarea id="reviewNote" placeholder="复核说明（可选）"></textarea></div>
    <button class="btn btn-yellow" id="reviewBtn" style="width:100%">主管确认并退还余额</button>`;
  openDrawer("actionDrawer");
  $("#reviewBtn").onclick = async () => {
    try {
      const res = await api("/api/deposit/review", { rental_id: rentalId,
        actor_id: state.actor.id, deduct_cents: Math.round(parseFloat($("#deduct").value || 0) * 100),
        note: $("#reviewNote").value });
      closeDrawer("actionDrawer");
      toast(`复核完成，退款回执：${res.refund_ref}`);
      refreshAll();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- 事件与刷新 ---------------- */

$("#actor").onchange = () => {
  state.actor = state.staff.find(s => s.id === $("#actor").value);
  renderActor(); renderFleet(); loadSideLists();
};

$$(".tab").forEach(t => t.onclick = () => {
  $$(".tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  state.rentalTab = t.dataset.tab;
  loadSideLists();
});

async function refreshAll() {
  await loadOverview();
  await loadSideLists();
}

(async function init() {
  try {
    await refreshAll();
    setInterval(refreshAll, 5000);  // 轮询库存/队列/后台提醒
  } catch (e) { toast("初始化失败：" + e.message, true); }
})();
