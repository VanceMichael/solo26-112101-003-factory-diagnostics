import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardPrerequisite,
  channelFits,
  coversSignals,
  jointParticipants,
  orderFeasibility,
  rankSteps,
} from '../lib/rules.mjs';

const eligibility = new Map([
  ['oil-check@G2', { card: 'oil-check', assembly: 'G2', conclusion: 'allow', checkId: 'V1', permits: ['drive-check'] }],
  // G3 新门控只放行 oil-check 自身，未对 drive-check 签发。
  ['oil-check@G3', { card: 'oil-check', assembly: 'G3', conclusion: 'allow', checkId: 'V2', permits: [] }],
]);
const gatedCards = new Set(['oil-check', 'drive-check']);
const orders = new Map([
  ['W7', { order: 'W7', advisor: '甲', assembly: 'G2', priority: 1, due: 31, pauseLimit: 2, cards: ['oil-check', 'drive-check'], requiredSignals: [], visibleSignals: [] }],
  ['W9', { order: 'W9', advisor: '值班', assembly: 'F9', priority: 3, due: 22, pauseLimit: 1, cards: ['feed-check'], requiredSignals: [], visibleSignals: [] }],
]);

test('受控卡跨批次查不到门控即拒绝，从未受控的卡无条件放行', () => {
  assert.equal(cardPrerequisite(orders, eligibility, orders.get('W7'), 'drive-check', 'G2', gatedCards).ok, true);
  const g3 = cardPrerequisite(orders, eligibility, orders.get('W7'), 'drive-check', 'G3', gatedCards);
  assert.equal(g3.ok, false);
  assert.equal(g3.reason, 'no-eligibility');
  // feed-check 从未出现在资格表中，按无前置条件处理。
  assert.equal(cardPrerequisite(orders, eligibility, orders.get('W9'), 'feed-check', 'F9', gatedCards).ok, true);
});

test('withdrawn 门控阻止同批次放行', () => {
  const map = new Map([
    ['oil-check@G2', { card: 'oil-check', assembly: 'G2', conclusion: 'withdrawn', checkId: 'V1', permits: ['drive-check'] }],
  ]);
  const result = cardPrerequisite(orders, map, orders.get('W7'), 'drive-check', 'G2', gatedCards);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'withdrawn');
  assert.equal(result.checkId, 'V1');
});

test('通道窗口必须在时段终点与工单截止前完成', () => {
  const channel = { window: [10, 24], duration: 3 };
  assert.equal(channelFits(channel, { now: 16 }, { due: 31 }), true);
  assert.equal(channelFits(channel, { now: 22 }, { due: 31 }), false);
  assert.equal(channelFits({ window: [16, 22], duration: 2 }, { now: 22 }, { due: 22 }), false);
});

test('完整度按声明信号集合判定', () => {
  assert.equal(coversSignals(['rpm', 'torque'], ['rpm']), true);
  assert.equal(coversSignals(['rpm'], ['rpm', 'torque']), false);
});

test('联合取件：同样本同批次且门控有效才组队，批次不符逐家拒绝', () => {
  const channel = { id: 'c1', card: 'oil-check', assembly: 'G2', sample: 'OL-07', signals: ['pressure'], window: [10, 24], duration: 3 };
  const result = jointParticipants({
    channel,
    orders,
    eligibility,
    gatedCards,
    evidence: new Map(),
    gaps: new Map(),
    pauseLedger: new Map([['W7', { occupied: 0, settled: 0, released: 0 }]]),
    clock: { now: 16 },
  });
  assert.deepEqual(result.participants.map(p => p.orderId), ['W7']);
  assert.ok(result.rejected.some(r => r.order === 'W9' && r.reason === 'assembly-mismatch'));
});

test('可行性：门控失效时以前置原因阻塞，而非虚假的无通道', () => {
  // G2 门控已作废：drive-check 即使存在窗口内通道，也应报前置阻塞。
  const withdrawn = new Map([
    ['oil-check@G2', { card: 'oil-check', assembly: 'G2', conclusion: 'withdrawn', checkId: 'V1', permits: ['drive-check'] }],
  ]);
  const result = orderFeasibility({
    order: orders.get('W7'),
    channels: new Map([['c', { card: 'drive-check', assembly: 'G2', window: [14, 25], duration: 4 }]]),
    eligibility: withdrawn,
    gatedCards,
    evidence: new Map(),
    pauseLedger: new Map([['W7', { occupied: 0, settled: 0, released: 0 }]]),
    clock: { now: 16 },
  });
  assert.equal(result.feasible, false);
  assert.ok(result.blockers.some(b => b.card === 'drive-check' && b.reason === 'withdrawn'));
});

test('排序：优先级优先，其次成套可行性、截止与窗口终点', () => {
  // a、b 同优先级，b 可成套故先于 a；c 优先级低排最后。
  const a = { minPriority: 1, allFeasible: false, earliestDue: 31, windowEnd: 24, channelId: 'a' };
  const b = { minPriority: 1, allFeasible: true, earliestDue: 31, windowEnd: 31, channelId: 'b' };
  const c = { minPriority: 2, allFeasible: true, earliestDue: 22, windowEnd: 22, channelId: 'c' };
  assert.deepEqual([c, a, b].sort(rankSteps).map(s => s.channelId), ['b', 'a', 'c']);
});
