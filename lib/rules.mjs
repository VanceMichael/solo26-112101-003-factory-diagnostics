// 纯规则函数：前置条件、完整度、联合取件三条件、成套可行性与优先级。
// 网关不替我们决定这些依赖，全部规则集中在此，便于值班人复核。

// 资格条目语义：条目挂在实际执行的检查卡上，conclusion 是该检查的结论，
// permits 是被该结论放行的后置检查卡（同装配批次内有效）。
// 收集同批次内对某卡形成门控的全部条目：自身条目 + permits 引用它的条目。
function gatingEntries(eligibility, card, assembly) {
  const entries = [];
  for (const entry of eligibility.values()) {
    if (entry.assembly !== assembly) continue;
    if (entry.card === card || (entry.permits ?? []).includes(card)) entries.push(entry);
  }
  return entries;
}

// 某检查卡在某装配批次下是否具备有效前置结论。
// gatedCards 是历史上出现过的受控卡（自身有条目或被 permits 引用）：
// 它们在当前批次找不到 allow 门控即视为未放行，跨批次不会自动认领。
// 从未受控的卡（如 feed-check）按无前置条件处理。
export function prerequisiteStatus(eligibility, card, assembly, gatedCards) {
  const gates = gatingEntries(eligibility, card, assembly);
  if (!gates.length) {
    if (gatedCards && gatedCards.has(card)) {
      return { ok: false, reason: 'no-eligibility', detail: `检查卡 ${card} 在装配批次 ${assembly} 下没有有效前置结论` };
    }
    return { ok: true, checkId: null, entry: null, unconditional: true };
  }
  const withdrawn = gates.find(entry => entry.conclusion === 'withdrawn');
  if (withdrawn) {
    return { ok: false, reason: 'withdrawn', checkId: withdrawn.checkId, detail: `前置结论 ${withdrawn.checkId} 已作废` };
  }
  const disallowed = gates.find(entry => entry.conclusion !== 'allow');
  if (disallowed) {
    return { ok: false, reason: disallowed.conclusion, checkId: disallowed.checkId, detail: `前置结论为 ${disallowed.conclusion}` };
  }
  // 同批次全部门控均为 allow，取其中一个签发编号用于审计挂接。
  return { ok: true, checkId: gates[0].checkId, entry: gates[0] };
}

// 一张检查卡能否领取：委托包含该卡，且该卡在目标批次的门控结论全部有效。
export function cardPrerequisite(orders, eligibility, order, card, assembly, gatedCards) {
  if (!order.cards.includes(card)) {
    return { ok: false, reason: 'not-in-order', detail: `工单 ${order.order} 不包含检查卡 ${card}` };
  }
  return prerequisiteStatus(eligibility, card, assembly, gatedCards);
}

// 已有数据是否覆盖通道声明的信号完整度。
export function coversSignals(availableSignals, required) {
  return required.every(signal => availableSignals.includes(signal));
}

// 联合取件三条件（缺一不可）：
// 1) 源端证明同一样本（样本签发编号相同）；
// 2) 工厂委托仍允许领（工单包含该卡、装配批次一致、前置结论有效、停顿未超限）；
// 3) 已有/本次数据满足声明的完整度。
export function jointParticipants({ channel, orders, eligibility, gatedCards, evidence, gaps, pauseLedger, clock }) {
  const participants = [];
  const rejected = [];
  for (const order of orders.values()) {
    if (order.assembly !== channel.assembly) {
      rejected.push({ order: order.order, reason: 'assembly-mismatch', detail: `工单装配批次 ${order.assembly} 与通道 ${channel.assembly} 不一致` });
      continue;
    }
    const prerequisite = cardPrerequisite(orders, eligibility, order, channel.card, channel.assembly, gatedCards);
    if (!prerequisite.ok) {
      rejected.push({ order: order.order, reason: prerequisite.reason, detail: prerequisite.detail });
      continue;
    }
    // 该工单此卡已有完整证据时不再重复领取。
    const existing = findEvidenceForCard(evidence, order, channel.card);
    if (existing) {
      rejected.push({ order: order.order, reason: 'already-complete', detail: `样本 ${existing.sample} 已满足该检查卡` });
      continue;
    }
    const ledger = pauseLedger.get(order.order);
    const used = ledger ? ledger.occupied + ledger.settled - ledger.released : 0;
    if (used >= order.pauseLimit) {
      rejected.push({ order: order.order, reason: 'order-pause-limit', detail: `工单停顿上限 ${order.pauseLimit} 已用尽` });
      continue;
    }
    // 完整度以通道声明信号为准；若同一样本有缺项片段，本次领取需能补齐。
    const gap = [...gaps.values()].find(g => g.sample === channel.sample && g.assembly === channel.assembly);
    const available = gap ? gap.signals : [];
    if (available.length && !coversSignals([...new Set([...available, ...channel.signals])], channel.signals)) {
      rejected.push({ order: order.order, reason: 'incomplete-declaration', detail: '续领后仍无法覆盖通道声明信号' });
      continue;
    }
    participants.push({ orderId: order.order, prerequisiteCheckId: prerequisite.checkId });
  }
  return { participants, rejected };
}

export function findEvidenceForCard(evidence, order, card) {
  for (const record of evidence.values()) {
    if (!record.orderIds.includes(order.order)) continue;
    if (record.card !== card) continue;
    if (record.stale) continue;
    return record;
  }
  return null;
}

// 通道窗口是否能在承诺时间前完成：最晚在时段终点完成，且不晚于工单截止。
export function channelFits(channel, clock, order) {
  const [start, end] = channel.window;
  const now = clock.now;
  if (now > end) return false;
  const begin = Math.max(now, start);
  const finish = begin + channel.duration;
  if (finish > end) return false;
  if (finish > order.due) return false;
  return true;
}

// 工单成套交付可行性：每张委托卡要么已有完整证据，要么至少还有一条可用通道。
export function orderFeasibility({ order, channels, eligibility, gatedCards, evidence, pauseLedger, clock }) {
  const blockers = [];
  for (const card of order.cards) {
    const existing = findEvidenceForCard(evidence, order, card);
    if (existing) continue;
    const prerequisite = cardPrerequisite(new Map([[order.order, order]]), eligibility, order, card, order.assembly, gatedCards);
    const options = [...channels.values()].filter(channel => {
      if (channel.card !== card || channel.assembly !== order.assembly) return false;
      if (!channelFits(channel, clock, order)) return false;
      const pre = cardPrerequisite(new Map([[order.order, order]]), eligibility, order, card, channel.assembly, gatedCards);
      if (!pre.ok) return false;
      const ledger = pauseLedger.get(order.order);
      const used = ledger ? ledger.occupied + ledger.settled - ledger.released : 0;
      return used < order.pauseLimit;
    });
    if (!prerequisite.ok) {
      blockers.push({ card, reason: prerequisite.reason, detail: prerequisite.detail });
    } else if (!options.length) {
      blockers.push({ card, reason: 'no-channel', detail: '当前没有在窗口内且停顿未超限的可用通道' });
    }
  }
  const ledger = pauseLedger.get(order.order);
  const used = ledger ? ledger.occupied + ledger.settled - ledger.released : 0;
  if (used >= order.pauseLimit && blockers.length) {
    blockers.push({ card: null, reason: 'order-pause-limit', detail: `工单停顿上限 ${order.pauseLimit} 已用尽，仍有缺卡` });
  }
  return { order: order.order, feasible: blockers.length === 0, blockers };
}

// 计划排序：工单优先级数字小者靠前；同优先级优先承诺截止前可完成；
// 再比窗口终点（不同可用窗口），最后给确定性次序。
export function rankSteps(a, b) {
  return (
    a.minPriority - b.minPriority ||
    // 可成套（allFeasible=true→1）需排前，因此反向相减。
    Number(b.allFeasible) - Number(a.allFeasible) ||
    a.earliestDue - b.earliestDue ||
    a.windowEnd - b.windowEnd ||
    a.channelId.localeCompare(b.channelId)
  );
}
