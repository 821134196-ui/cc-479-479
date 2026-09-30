'use strict';
// 进程内任务调度：周期性处理游客超时与调拨提醒（service.tick）。
function createScheduler({ service, tickMs = 15000 }) {
  let timer = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          const r = service.tick();
          if (r.overdue || r.reminders || r.locksReleased) {
            console.log(`[scheduler] 超时 ${r.overdue}，调拨提醒 ${r.reminders}，释放锁定 ${r.locksReleased}`);
          }
        } catch (e) {
          console.error('[scheduler] tick 失败:', e);
        }
      }, tickMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce() {
      return service.tick();
    },
  };
}

module.exports = { createScheduler };
