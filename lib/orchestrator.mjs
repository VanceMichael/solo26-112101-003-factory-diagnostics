// 联合取件与值班交接编排引擎。
// 引擎只消费网关原件与回执，所有依赖判定走 lib/rules.mjs 的显式规则。

import { WorkbenchStore } from './store.mjs';
import {
  cardPrerequisite,
  channelFits,
  coversSignals,
  findEvidenceForCard,
  jointParticipants,
  orderFeasibility,
  rankSteps,
} from './rules.mjs';

function dedupe(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class PlanRejectedError extends Error {
  constructor(rejections) {
    super('没有可执行的取件计划');
    this.name = 'PlanRejectedError';
    this.rejections = rejections;
  }
}

export class ReadRejectedError extends Error {
  constructor(reason, detail, extra = {}) {
    super(detail);
    this.name = 'ReadRejectedError';
    this.reason = reason;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

export class Orchestrator {
  constructor(client, store = new WorkbenchStore()) {
    this.client = client;
    this.store = store;
  }

  // 从来源重新拉取工单约定、通道、前置结论与现场时标，并复核既有资料状态。
  async refresh() {
    const [clock, channels, orders, eligibility] = await Promise.all([
      this.client.getClock(),
      this.client.getChannels(),
      this.client.getOrders(),
      this.client.getEligibility(),
    ]);
    this.store.replaceSnapshot({ clock, channels, orders, eligibility });
    this.#revalidateEvidence();
    this.#rebuildAllKits();
    this.store.recordEvent('refresh', { now: clock.now });
    return this.overview();
  }

  // 前置结论变化后重新标注证据：作废不删除原件，只标记待换领，
  // 并明确它仍可作为独立证据还是被链路阻塞。
  #revalidateEvidence() {
    const s = this.store.state;
    for (const record of s.evidence.values()) {
      const pre = cardPrerequisite(s.orders, s.eligibility, { cards: [record.card] }, record.card, record.assembly, s.gatedCards);
      const previous = record.stale;
      record.stale = !pre.ok;
      record.staleReason = pre.ok ? null : pre.reason;
      record.staleCheckId = pre.ok ? null : pre.checkId;
      if (!previous && record.stale) {
        this.store.recordEvent('evidence-stale', {
          sample: record.sample,
          card: record.card,
          assembly: record.assembly,
          reason: pre.reason,
          checkId: pre.checkId,
        });
      }
    }
    for (const gap of s.gaps.values()) {
      const pre = cardPrerequisite(s.orders, s.eligibility, { cards: [gap.card] }, gap.card, gap.assembly, s.gatedCards);
      gap.blocked = !pre.ok;
      gap.blockedReason = pre.ok ? null : pre.reason;
    }
  }

  // 停顿账本统一口径：占用中 + 已结算 - 已释放。
  #pauseUsed(ledger) {
    return ledger.occupied + ledger.settled - ledger.released;
  }

  // 生成取件计划：列出候选步骤与每条被排除通道的原因。
  plan() {
    const s = this.store.state;
    if (!s.clock) throw new Error('请先 refresh 拉取现场时标与工单约定');
    const rejections = [];
    const steps = [];
    for (const channel of s.channels.values()) {
      const feasibility = this.#evaluateChannel(channel, rejections);
      if (!feasibility) continue;
      steps.push(feasibility);
    }
    steps.sort(rankSteps);
    return { now: s.clock.now, steps, rejections: dedupe(rejections) };
  }

  // 计划为空时抛出带全部排除原因的错误，供接口层向值班人解释为何无法取件。
  planOrThrow() {
    const plan = this.plan();
    if (!plan.steps.length) throw new PlanRejectedError(plan.rejections);
    return plan;
  }

  #evaluateChannel(channel, rejections) {
    const s = this.store.state;
    const relevantOrders = [...s.orders.values()].filter(order =>
      order.cards.includes(channel.card) && order.assembly === channel.assembly);
    if (!relevantOrders.length) {
      // 不直接返回：继续走联合评估，保留逐工单的批次/前置等具体拒绝原因。
      rejections.push({ channel: channel.id, reason: 'no-order', detail: '没有同装配批次的委托需要这张检查卡' });
    }
    // 全局停顿时仍继续评估并记录各工单级原因，便于值班人看清下一步被谁挡住。
    if (this.#pauseUsed(s.globalPauses) >= s.globalPauses.limit) {
      rejections.push({ channel: channel.id, reason: 'global-pause-limit', detail: `全厂停顿上限 ${s.globalPauses.limit} 已用尽` });
    }
    for (const order of relevantOrders) {
      if (!channelFits(channel, s.clock, order)) {
        rejections.push({ channel: channel.id, order: order.order, reason: 'window-or-due', detail: `通道窗口 ${channel.window.join('-')} 无法在截止 ${order.due} 前完成` });
      }
      const pre = cardPrerequisite(s.orders, s.eligibility, order, channel.card, channel.assembly, s.gatedCards);
      if (!pre.ok) {
        rejections.push({ channel: channel.id, order: order.order, reason: pre.reason, detail: pre.detail });
      }
      const ledger = this.store.orderPause(order.order);
      if (this.#pauseUsed(ledger) >= order.pauseLimit) {
        rejections.push({ channel: channel.id, order: order.order, reason: 'order-pause-limit', detail: `工单停顿上限 ${order.pauseLimit} 已用尽` });
      }
    }
    const joint = jointParticipants({
      channel,
      orders: s.orders,
      eligibility: s.eligibility,
      gatedCards: s.gatedCards,
      evidence: s.evidence,
      gaps: s.gaps,
      pauseLedger: s.orderPauses,
      clock: s.clock,
    });
    for (const rejection of joint.rejected) rejections.push({ channel: channel.id, ...rejection });
    if (!joint.participants.length) return null;
    // 窗口/截止仍未满足的参与者不能计入本步骤。
    const participantOrders = joint.participants
      .map(p => s.orders.get(p.orderId))
      .filter(order => channelFits(channel, s.clock, order));
    if (!participantOrders.length) return null;

    const feasibilities = participantOrders.map(order => orderFeasibility({
      order,
      channels: s.channels,
      eligibility: s.eligibility,
      gatedCards: s.gatedCards,
      evidence: s.evidence,
      pauseLedger: s.orderPauses,
      clock: s.clock,
    }));
    return {
      channelId: channel.id,
      card: channel.card,
      sample: channel.sample,
      assembly: channel.assembly,
      window: channel.window,
      duration: channel.duration,
      pauseCost: channel.pauseCost,
      participantOrders: joint.participants,
      minPriority: Math.min(...participantOrders.map(o => o.priority)),
      earliestDue: Math.min(...participantOrders.map(o => o.due)),
      windowEnd: channel.window[1],
      allFeasible: feasibilities.every(f => f.feasible),
      feasibility: feasibilities,
    };
  }

  // 执行一次领取。participantOrderIds 为空时按联合取件规则自动组队。
  async read(channelId, participantOrderIds) {
    const s = this.store.state;
    const channel = s.channels.get(channelId);
    if (!channel) throw new ReadRejectedError('unknown-channel', `未知通道 ${channelId}`);
    if (this.#pauseUsed(s.globalPauses) >= s.globalPauses.limit) {
      throw new ReadRejectedError('global-pause-limit', `全厂停顿上限 ${s.globalPauses.limit} 已用尽`);
    }
    const joint = jointParticipants({
      channel,
      orders: s.orders,
      eligibility: s.eligibility,
      gatedCards: s.gatedCards,
      evidence: s.evidence,
      gaps: s.gaps,
      pauseLedger: s.orderPauses,
      clock: s.clock,
    });
    let participants = joint.participants;
    if (participantOrderIds) {
      const allowed = new Set(joint.participants.map(p => p.orderId));
      const forbidden = participantOrderIds.filter(id => !allowed.has(id));
      if (forbidden.length) {
        const detail = joint.rejected.find(r => forbidden.includes(r.order))?.detail
          ?? `工单 ${forbidden.join('、')} 不满足联合取件条件`;
        throw new ReadRejectedError('participant-not-eligible', detail, { rejections: joint.rejected });
      }
      participants = joint.participants.filter(p => participantOrderIds.includes(p.orderId));
    }
    if (!participants.length) {
      throw new ReadRejectedError('no-participant', '没有委托满足联合取件三条件', { rejections: joint.rejected });
    }
    for (const participant of participants) {
      const order = s.orders.get(participant.orderId);
      if (!channelFits(channel, s.clock, order)) {
        throw new ReadRejectedError('window-or-due', `通道无法在工单 ${order.order} 截止前完成`);
      }
    }

    const orderIds = participants.map(p => p.orderId);
    this.store.occupyPause(orderIds);
    let response;
    try {
      response = await this.client.read(channelId);
    } catch (error) {
      // 网关未受理：退回本次占用，保持账本可信。
      this.#rollbackOccupy(orderIds);
      throw error;
    }
    const report = response.data;
    const record = this.store.saveReceipt({
      receiptId: report.receipt,
      channelId,
      card: channel.card,
      orderIds,
      state: report.state,
      release: report.release ?? false,
      settled: false,
      acceptedAt: report.acceptedAt ?? s.clock.now,
      sample: report.sample ?? channel.sample,
      assembly: report.assembly ?? channel.assembly,
    });
    this.store.recordEvent('read-accepted', {
      receipt: record.receiptId,
      channel: channelId,
      orders: orderIds,
      state: record.state,
      joint: orderIds.length > 1,
    });
    if (response.status === 200 && report.state === 'complete') {
      this.#materializeComplete(channel, record, report, participants);
    } else if (report.state === 'pending') {
      this.store.recordEvent('pause-occupied', { receipt: record.receiptId, orders: orderIds });
    }
    this.#rebuildAllKits();
    return this.#receiptView(record);
  }

  #rollbackOccupy(orderIds) {
    const global = this.store.state.globalPauses;
    global.occupied -= 1;
    for (const orderId of orderIds) {
      const ledger = this.store.orderPause(orderId);
      ledger.occupied -= 1;
    }
  }

  #materializeComplete(channel, receipt, report, participants) {
    const s = this.store.state;
    // 源端证明：回执样本/批次必须与通道声明一致，防止张冠李戴。
    if (report.sample !== channel.sample || report.assembly !== channel.assembly) {
      throw new ReadRejectedError('source-attestation-mismatch',
        `回执样本 ${report.sample}/${report.assembly} 与通道声明 ${channel.sample}/${channel.assembly} 不一致`);
    }
    const signals = [...new Set(report.chunks.flatMap(chunk => Object.keys(chunk)))];
    if (!coversSignals(signals, channel.signals)) {
      throw new ReadRejectedError('incomplete-declaration',
        `回执只含 ${signals.join('、')}，未覆盖通道声明 ${channel.signals.join('、')}`);
    }
    // 同一样本只保存一条原件证据，后续工单联合挂接，保留独立签发编号。
    let evidence = s.evidence.get(report.sample);
    if (!evidence) {
      evidence = this.store.saveEvidence({
        sample: report.sample,
        assembly: report.assembly,
        card: channel.card,
        channelId: channel.id,
        receiptId: receipt.receiptId,
        checkIds: participants.map(p => ({ order: p.orderId, checkId: p.prerequisiteCheckId })),
        chunks: report.chunks,
        signals,
        orderIds: [],
        stale: false,
        staleReason: null,
        staleCheckId: null,
      });
    }
    for (const participant of participants) {
      if (!evidence.orderIds.includes(participant.orderId)) evidence.orderIds.push(participant.orderId);
    }
    this.store.settleFromOccupied(receipt.receiptId, report.release ?? false);
    this.store.recordEvent('evidence-complete', {
      sample: evidence.sample,
      card: evidence.card,
      assembly: evidence.assembly,
      orders: evidence.orderIds,
      receipt: receipt.receiptId,
    });
  }

  // 查询回执：pending 继续占停顿；partial 只登记缺项片段；failed 按 release 释放窗口。
  async pollReceipt(receiptId) {
    const record = this.store.getReceipt(receiptId);
    if (!record) throw new ReadRejectedError('unknown-receipt', `未知回执 ${receiptId}`);
    const report = await this.client.getReceipt(receiptId);
    record.state = report.state;
    record.release = report.release ?? record.release;
    if (report.sample) record.sample = report.sample;
    if (report.assembly) record.assembly = report.assembly;
    if (report.state === 'partial' && report.resume) {
      const signals = [...new Set((report.chunks ?? []).flatMap(chunk => Object.keys(chunk)))];
      this.store.saveGap({
        receiptId,
        card: record.card,
        sample: report.sample,
        assembly: report.assembly,
        signals,
        chunks: report.chunks ?? [],
        resume: report.resume,
        blocked: false,
        blockedReason: null,
      });
      this.store.recordEvent('partial-gap', {
        receipt: receiptId,
        sample: report.sample,
        missing: this.#missingSignals(receiptId, signals),
        resume: report.resume,
      });
    }
    if (report.state === 'failed' || (report.state === 'complete' && !record.settled)) {
      this.store.settleReceipt(receiptId, report.release ?? false);
      this.store.recordEvent(report.state === 'failed' ? 'receipt-failed' : 'receipt-settled', {
        receipt: receiptId,
        release: record.release,
      });
      if (report.state === 'failed') {
        const gap = this.store.state.gaps.get(receiptId);
        if (gap) gap.blocked = true;
      }
    }
    this.#revalidateEvidence();
    this.#rebuildAllKits();
    return this.#receiptView(record);
  }

  #missingSignals(receiptId, signals) {
    const channel = this.store.state.channels.get(this.store.getReceipt(receiptId).channelId);
    if (!channel) return [];
    return channel.signals.filter(signal => !signals.includes(signal));
  }

  // 凭续领凭据续领；失败且 release=false 时停顿窗口继续被占用。
  async resume(receiptId) {
    const record = this.store.getReceipt(receiptId);
    if (!record) throw new ReadRejectedError('unknown-receipt', `未知回执 ${receiptId}`);
    const gap = this.store.state.gaps.get(receiptId);
    if (!gap?.resume) throw new ReadRejectedError('no-resume-credential', `回执 ${receiptId} 没有可用续领凭据`);
    let response;
    try {
      response = await this.client.resume(gap.resume);
    } catch (error) {
      if (error.status === 409) {
        record.state = 'partial';
        record.release = error.body?.release ?? record.release;
        this.store.recordEvent('resume-conflict', {
          receipt: receiptId,
          reason: error.body?.reason ?? '续领冲突',
          release: record.release,
        });
        return { ok: false, receipt: this.#receiptView(record), reason: error.body?.reason ?? '续领冲突' };
      }
      throw error;
    }
    const report = response.data;
    const channel = this.store.state.channels.get(record.channelId);
    if (report.state === 'complete' && channel) {
      this.#materializeComplete(channel, record, report,
        record.orderIds.map(orderId => ({
          orderId,
          prerequisiteCheckId: this.#checkIdFor(orderId, record.card, record.assembly),
        })));
      this.store.state.gaps.delete(receiptId);
    }
    this.#rebuildAllKits();
    return { ok: true, receipt: this.#receiptView(record) };
  }

  #checkIdFor(orderId, card, assembly) {
    const order = this.store.state.orders.get(orderId);
    const pre = cardPrerequisite(this.store.state.orders, this.store.state.eligibility, order, card, assembly, this.store.state.gatedCards);
    return pre.checkId ?? null;
  }

  #receiptView(record) {
    return {
      receiptId: record.receiptId,
      channelId: record.channelId,
      card: record.card,
      orders: record.orderIds,
      state: record.state,
      release: record.release,
      settled: record.settled,
      sample: record.sample,
      assembly: record.assembly,
      gapOnly: this.store.state.gaps.has(record.receiptId),
    };
  }

  // 重建某工单成套资料：完整证据成套，前置失效则待换领并列出仍独立可用的证据。
  // 成套与否还要过顾问可见范围：某卡对该顾问没有任何可见字段时不计成套。
  #rebuildKit(order) {
    const s = this.store.state;
    const visible = new Set(order.visibleSignals);
    const items = [];
    const independent = [];
    let complete = true;
    let stale = false;
    for (const card of order.cards) {
      const evidence = findEvidenceForCard(s.evidence, order, card);
      const allForCard = [...s.evidence.values()].filter(e => e.card === card && e.orderIds.includes(order.order));
      if (evidence) {
        const visibleSignals = evidence.signals.filter(signal => visible.has(signal));
        if (visibleSignals.length) {
          items.push({ card, status: 'complete', sample: evidence.sample, assembly: evidence.assembly, receipt: evidence.receiptId, checkIds: evidence.checkIds, visibleSignals });
        } else {
          complete = false;
          items.push({ card, status: 'not-visible', sample: evidence.sample, detail: `顾问 ${order.advisor} 无权查看该卡任何字段，不能计入成套交付` });
        }
      } else if (allForCard.some(e => e.stale)) {
        const staleRecord = allForCard.find(e => e.stale);
        complete = false;
        stale = true;
        items.push({ card, status: 'awaiting-replacement', sample: staleRecord.sample, reason: staleRecord.staleReason, checkId: staleRecord.staleCheckId });
      } else {
        complete = false;
        items.push({ card, status: 'missing' });
      }
      for (const record of allForCard) {
        // 完整原件即使前置失效，仍是可独立引用的证据，但不能再算成套交付。
        independent.push({
          card,
          sample: record.sample,
          assembly: record.assembly,
          receipt: record.receiptId,
          signals: record.signals,
          usableIndependently: true,
          stale: record.stale,
          staleReason: record.staleReason,
        });
      }
    }
    const kit = {
      order: order.order,
      advisor: order.advisor,
      status: complete ? 'ready' : stale ? 'awaiting-replacement' : 'incomplete',
      items,
      independentEvidence: independent,
      gapFragments: [...s.gaps.values()].filter(gap =>
        order.assembly === gap.assembly && order.cards.includes(gap.card)).map(gap => ({
        receipt: gap.receiptId,
        card: gap.card,
        sample: gap.sample,
        signals: gap.signals,
        blocked: gap.blocked,
        blockedReason: gap.blockedReason,
        note: '部分数据仅供现场查明缺项，不能作为完整检查送给顾问',
      })),
    };
    return this.store.saveKit(order.order, kit);
  }

  #rebuildAllKits() {
    for (const order of this.store.state.orders.values()) this.#rebuildKit(order);
  }

  // 值班人总览：工单可行性、停顿账本与计划。
  overview() {
    const s = this.store.state;
    const feasibility = [...s.orders.values()].map(order => orderFeasibility({
      order,
      channels: s.channels,
      eligibility: s.eligibility,
      gatedCards: s.gatedCards,
      evidence: s.evidence,
      pauseLedger: s.orderPauses,
      clock: s.clock,
    }));
    return {
      clock: s.clock,
      globalPauses: { ...s.globalPauses, used: this.#pauseUsed(s.globalPauses) },
      orderPauses: Object.fromEntries([...s.orderPauses.entries()].map(([id, ledger]) => [id, { ...ledger, used: this.#pauseUsed(ledger) }])),
      feasibility,
      kits: [...s.kits.values()],
      plan: s.clock ? this.plan() : null,
    };
  }

  // 值班人检查卡视图：未满足条件、剩余通道、停顿消耗、领件记录。
  cardView(card) {
    const s = this.store.state;
    const channels = [...s.channels.values()].filter(channel => channel.card === card);
    const rejections = [];
    const channelViews = channels.map(channel => {
      const feasibility = this.#evaluateChannel(channel, rejections);
      return {
        channelId: channel.id,
        sample: channel.sample,
        assembly: channel.assembly,
        window: channel.window,
        duration: channel.duration,
        available: Boolean(feasibility),
        participantOrders: feasibility?.participantOrders ?? [],
      };
    });
    const evidence = [...s.evidence.values()].filter(record => record.card === card).map(record => ({
      sample: record.sample,
      assembly: record.assembly,
      receipt: record.receiptId,
      orderIds: record.orderIds,
      signals: record.signals,
      stale: record.stale,
      staleReason: record.staleReason,
    }));
    const receipts = [...s.receipts.values()].filter(record => record.card === card).map(record => ({
      receiptId: record.receiptId,
      channelId: record.channelId,
      orders: record.orderIds,
      state: record.state,
      release: record.release,
      settled: record.settled,
    }));
    return {
      card,
      now: s.clock?.now ?? null,
      channels: channelViews,
      rejections: dedupe(rejections.filter(r => channels.some(c => c.id === r.channel))),
      evidence,
      receipts,
    };
  }

  // 顾问视图：只返回其有权查看字段的成套资料。
  advisorView(advisor) {
    const s = this.store.state;
    const order = [...s.orders.values()].find(candidate => candidate.advisor === advisor);
    if (!order) throw new ReadRejectedError('unknown-advisor', `顾问 ${advisor} 没有委托`);
    const kit = s.kits.get(order.order);
    const visible = new Set(order.visibleSignals);
    const filterChunks = chunks => chunks.map(chunk => Object.fromEntries(
      Object.entries(chunk).filter(([signal]) => visible.has(signal))));
    return {
      advisor,
      order: order.order,
      assembly: order.assembly,
      kitStatus: kit?.status ?? 'incomplete',
      requiredSignals: order.requiredSignals,
      visibleSignals: order.visibleSignals,
      items: (kit?.items ?? []).map(item => {
        if (item.status !== 'complete') return item;
        const record = s.evidence.get(item.sample);
        return {
          ...item,
          signals: record.signals.filter(signal => visible.has(signal)),
          chunks: filterChunks(record.chunks),
        };
      }),
      // 无可见字段的证据不暴露给该顾问，避免空对象泄露原件存在性之外的信息。
      independentEvidence: (kit?.independentEvidence ?? [])
        .map(record => ({
          ...record,
          signals: record.signals.filter(signal => visible.has(signal)),
          chunks: filterChunks(s.evidence.get(record.sample).chunks),
        }))
        .filter(record => record.signals.length > 0),
      awaitingReplacement: kit?.status === 'awaiting-replacement',
      // 缺项片段不送给顾问，只告知存在现场待查缺项。
      gapNotice: (kit?.gapFragments ?? []).map(gap => ({
        card: gap.card,
        blocked: gap.blocked,
        note: gap.note,
      })),
    };
  }

  // 自动值班：按计划逐步领取；遇到 pending（停顿仍被占用）立即停下，
  // 由值班人通过回执轮询/续领推进，避免擅自占用下一个停顿窗口。
  async run({ maxSteps = 20 } = {}) {
    const executed = [];
    for (let i = 0; i < maxSteps; i += 1) {
      const { steps } = this.plan();
      if (!steps.length) break;
      const step = steps[0];
      const receipt = await this.read(step.channelId);
      executed.push({ channelId: step.channelId, receipt });
      if (receipt.state === 'pending') break;
    }
    return { executed, overview: this.overview() };
  }
}
