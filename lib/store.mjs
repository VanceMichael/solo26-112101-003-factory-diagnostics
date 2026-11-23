// 工作台的内存状态。所有跨会话的记录都在这里集中管理：
// 停顿账本、领取回执、原件证据、缺项片段、成套资料与审计事件。

export function createInitialStore() {
  return {
    clock: null,
    channels: new Map(),
    orders: new Map(),
    eligibility: new Map(),
    gatedCards: new Set(),
    // 停顿账本：全局唯一停顿 + 每个工单各自的停顿上限。
    globalPauses: { limit: 0, occupied: 0, settled: 0, released: 0 },
    orderPauses: new Map(),
    receipts: new Map(),
    // key: 样本签发编号。同一编号在多个工单间共享同一条原件证据。
    evidence: new Map(),
    // 部分读取只作为缺项片段保留，绝不进入顾问成套资料。
    gaps: new Map(),
    // key: 工单号。
    kits: new Map(),
    events: [],
  };
}

export class WorkbenchStore {
  constructor() {
    this.state = createInitialStore();
  }

  reset() {
    this.state = createInitialStore();
  }

  recordEvent(type, detail) {
    const event = {
      seq: this.state.events.length + 1,
      at: this.state.clock?.now ?? null,
      type,
      detail,
    };
    this.state.events.push(event);
    return event;
  }

  replaceSnapshot({ clock, channels, orders, eligibility }) {
    if (clock) this.state.clock = clock;
    if (channels) {
      this.state.channels = new Map(channels.map(channel => [channel.id, channel]));
    }
    if (orders) {
      this.state.orders = new Map(orders.map(order => [order.order, order]));
      for (const order of orders) {
        if (!this.state.orderPauses.has(order.order)) {
          this.state.orderPauses.set(order.order, {
            limit: order.pauseLimit,
            occupied: 0,
            settled: 0,
            released: 0,
          });
        }
      }
      if (clock) this.state.globalPauses.limit = clock.pauseLimit;
    }
    if (eligibility) {
      // 同一检查卡同一装配批次只保留当前快照里的最新结论。
      this.state.eligibility = new Map(
        eligibility.map(entry => [`${entry.card}@${entry.assembly}`, entry]),
      );
      // 受控卡跨刷新累积：自身有条目或被 permits 引用的卡，
      // 批次切换后若在新批次查不到 allow 门控，即视为未放行。
      for (const entry of eligibility) {
        this.state.gatedCards.add(entry.card);
        for (const permitted of entry.permits ?? []) this.state.gatedCards.add(permitted);
      }
    }
  }

  orderPause(orderId) {
    if (!this.state.orderPauses.has(orderId)) {
      this.state.orderPauses.set(orderId, { limit: 0, occupied: 0, settled: 0, released: 0 });
    }
    return this.state.orderPauses.get(orderId);
  }

  // 一次领取（含联合取件）在受理时占用一次停顿。
  occupyPause(orderIds) {
    const global = this.state.globalPauses;
    global.occupied += 1;
    for (const orderId of orderIds) {
      this.orderPause(orderId).occupied += 1;
    }
  }

  // 受理后当次即结算：把占用中的停顿直接转为已结算，不退回再占用。
  // release=true 时同时释放占用窗口；已结算消耗本身始终不退回。
  settleFromOccupied(receiptId, release) {
    const receipt = this.state.receipts.get(receiptId);
    if (!receipt || receipt.settled) return receipt;
    receipt.settled = true;
    receipt.release = release;
    const global = this.state.globalPauses;
    global.occupied -= 1;
    global.settled += 1;
    if (release) global.released += 1;
    for (const orderId of receipt.orderIds) {
      const ledger = this.orderPause(orderId);
      ledger.occupied -= 1;
      ledger.settled += 1;
      if (release) ledger.released += 1;
    }
    return receipt;
  }

  // 结算：已结算消耗不退回；release=true 仅表示占用窗口释放。
  // pending/partial 的回执不在此登记，只有 complete/failed 才算结算。
  settleReceipt(receiptId, release) {
    const receipt = this.state.receipts.get(receiptId);
    if (!receipt || receipt.settled) return receipt;
    receipt.settled = true;
    receipt.release = release;
    const global = this.state.globalPauses;
    global.settled += 1;
    if (release) {
      global.occupied -= 1;
      global.released += 1;
    }
    for (const orderId of receipt.orderIds) {
      const ledger = this.orderPause(orderId);
      ledger.settled += 1;
      if (release) {
        ledger.occupied -= 1;
        ledger.released += 1;
      }
    }
    return receipt;
  }

  saveReceipt(record) {
    this.state.receipts.set(record.receiptId, record);
    return record;
  }

  getReceipt(receiptId) {
    return this.state.receipts.get(receiptId);
  }

  saveEvidence(record) {
    this.state.evidence.set(record.sample, record);
    return record;
  }

  getEvidence(sample) {
    return this.state.evidence.get(sample);
  }

  saveGap(record) {
    this.state.gaps.set(record.receiptId, record);
    return record;
  }

  saveKit(orderId, kit) {
    this.state.kits.set(orderId, kit);
    return kit;
  }

  getKit(orderId) {
    return this.state.kits.get(orderId);
  }

  // 输出给接口层时把 Map 转成普通数组，避免序列化细节外泄。
  snapshot() {
    const s = this.state;
    return {
      clock: s.clock,
      globalPauses: { ...s.globalPauses },
      orderPauses: Object.fromEntries(s.orderPauses),
      channels: [...s.channels.values()],
      orders: [...s.orders.values()],
      eligibility: [...s.eligibility.values()],
      receipts: [...s.receipts.values()],
      evidence: [...s.evidence.values()],
      gaps: [...s.gaps.values()],
      kits: [...s.kits.values()],
      events: [...s.events],
    };
  }
}
