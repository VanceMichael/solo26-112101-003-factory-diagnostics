import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { GatewayClient } from '../lib/gateway-client.mjs';
import { Orchestrator, PlanRejectedError, ReadRejectedError } from '../lib/orchestrator.mjs';

async function harness() {
  const source = await startSources();
  const orchestrator = new Orchestrator(new GatewayClient(source.url));
  return {
    source,
    orchestrator,
    async stage(name) {
      await orchestrator.client.selectScenario(name);
      return orchestrator.refresh();
    },
  };
}

test('initial：联合取件一次停顿满足两个委托，计划按优先级与成套性排序', async () => {
  const { source, orchestrator, stage } = await harness();
  try {
    await stage('initial');
    const plan = orchestrator.plan();
    // probe-mirror 是同卡同样本的替代通道，一并出现在计划中，alpha 窗口更早排前。
    assert.deepEqual(plan.steps.map(step => step.channelId), ['oil-main', 'probe-alpha', 'probe-mirror', 'feed-side']);
    const oilStep = plan.steps[0];
    assert.deepEqual(oilStep.participantOrders.map(p => p.orderId), ['W7', 'W8']);
    assert.equal(oilStep.minPriority, 1);

    const oil = await orchestrator.read('oil-main');
    assert.equal(oil.state, 'complete');
    assert.deepEqual(oil.orders, ['W7', 'W8']);
    const global = orchestrator.overview().globalPauses;
    assert.equal(global.settled, 1);
    assert.equal(global.used, 1);
    // 联合取件对每个工单只记一次工单级停顿，全局也只占一次。
    assert.equal(orchestrator.overview().orderPauses.W7.used, 1);
    assert.equal(orchestrator.overview().orderPauses.W8.used, 1);

    // 同一样本只有一条原件证据，两个工单共享挂接。
    const evidence = orchestrator.store.state.evidence.get('OL-07');
    assert.deepEqual(evidence.orderIds, ['W7', 'W8']);
    assert.deepEqual(evidence.signals, ['pressure']);
  } finally {
    await source.close();
  }
});

test('initial：pending 持续占用停顿，最后一个停顿按工单上限交给 W9', async () => {
  const { source, orchestrator, stage } = await harness();
  try {
    await stage('initial');
    // run 在 probe-alpha 返回 pending 后停下，不擅自占用下一个停顿。
    const firstRun = await orchestrator.run();
    assert.deepEqual(firstRun.executed.map(step => step.channelId), ['oil-main', 'probe-alpha']);
    let overview = orchestrator.overview();
    assert.deepEqual(overview.globalPauses, {
      limit: 3, occupied: 1, settled: 1, released: 0, used: 2,
    });
    assert.equal(overview.orderPauses.W7.used, 2);
    assert.equal(overview.orderPauses.W8.used, 2);
    assert.equal(overview.orderPauses.W9.used, 0);

    // 此时 W7/W8 工单停顿上限已用尽，最后一个全厂停顿交给仍具备条件的 W9。
    const feed = await orchestrator.read('feed-side');
    assert.equal(feed.state, 'complete');
    overview = orchestrator.overview();
    assert.deepEqual(overview.globalPauses, {
      limit: 3, occupied: 1, settled: 2, released: 0, used: 3,
    });
    assert.equal(overview.orderPauses.W9.used, 1);

    const h2 = orchestrator.store.getReceipt('H2');
    assert.equal(h2.state, 'pending');
    assert.equal(h2.settled, false);

    // 全厂停顿已用尽，再次领取被拒。
    await assert.rejects(() => orchestrator.read('probe-mirror'), error => {
      assert.ok(error instanceof ReadRejectedError);
      assert.equal(error.reason, 'global-pause-limit');
      return true;
    });
    // probe-mirror 还应在计划排除原因里体现 W7/W8 工单停顿上限。
    const rejection = orchestrator.plan().rejections.find(r => r.channel === 'probe-mirror' && r.reason === 'order-pause-limit');
    assert.ok(rejection);
  } finally {
    await source.close();
  }
});

test('invalidation：前置作废后成套资料待换领，部分数据只作缺项片段', async () => {
  const { source, orchestrator, stage } = await harness();
  try {
    await stage('initial');
    await orchestrator.run();
    await orchestrator.read('feed-side');
    await stage('invalidation');

    const partial = await orchestrator.pollReceipt('H2');
    assert.equal(partial.state, 'partial');
    assert.equal(partial.gapOnly, true);
    const gap = orchestrator.store.state.gaps.get('H2');
    assert.deepEqual(gap.signals, ['rpm']);

    const resume = await orchestrator.resume('H2');
    assert.equal(resume.ok, false);
    assert.equal(resume.receipt.release, false);
    // 续领冲突且未释放：占用停顿不变。
    assert.equal(orchestrator.overview().globalPauses.occupied, 1);

    const kitW7 = orchestrator.store.getKit('W7');
    assert.equal(kitW7.status, 'awaiting-replacement');
    const driveItem = kitW7.items.find(item => item.card === 'drive-check');
    assert.equal(driveItem.status, 'missing');
    // oil-check 原件仍在独立证据清单中，但已标记 stale。
    const independent = kitW7.independentEvidence.find(item => item.sample === 'OL-07');
    assert.equal(independent.usableIndependently, true);
    assert.equal(independent.stale, true);
    // 缺项片段不能作为完整检查送给顾问。
    assert.ok(kitW7.gapFragments.some(fragment => fragment.card === 'drive-check'));
  } finally {
    await source.close();
  }
});

test('顾问只能取回 visibleSignals 范围内的字段', async () => {
  const { source, orchestrator, stage } = await harness();
  try {
    await stage('initial');
    await orchestrator.read('oil-main');
    const advisorA = orchestrator.advisorView('设备商甲');
    const advisorB = orchestrator.advisorView('设备商乙');
    const oilA = advisorA.items.find(item => item.card === 'oil-check');
    const oilB = advisorB.items.find(item => item.card === 'oil-check');
    assert.deepEqual(oilA.chunks, [{ pressure: 172 }]);
    // 设备商乙只能看 torque：原件存在但对其无可见字段，不能计入成套。
    assert.equal(oilB.status, 'not-visible');
    assert.ok(!JSON.stringify(advisorB).includes('"pressure":172'));
    assert.throws(() => orchestrator.advisorView('不存在的顾问'), /没有委托/);
  } finally {
    await source.close();
  }
});

test('replacement：失败回执释放停顿，G3 新前置不能认领 G2 旧批次委托', async () => {
  const { source, orchestrator, stage } = await harness();
  try {
    await stage('initial');
    await orchestrator.run();
    await orchestrator.read('feed-side');
    await stage('invalidation');
    await orchestrator.pollReceipt('H2');
    await stage('replacement');

    const failed = await orchestrator.pollReceipt('H2');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.release, true);
    const overview = orchestrator.overview();
    // 已结算消耗不退回（settled 仍为 3），但占用窗口释放，used 下降。
    assert.equal(overview.globalPauses.settled, 3);
    assert.equal(overview.globalPauses.occupied, 0);
    assert.equal(overview.globalPauses.used, 2);

    const plan = orchestrator.plan();
    assert.deepEqual(plan.steps, []);
    // probe-next 属 G3，W7/W8 是 G2 委托：逐工单记录批次不符，不能跨批次认领。
    const next = plan.rejections.find(r => r.channel === 'probe-next' && r.reason === 'assembly-mismatch');
    assert.ok(next, '应给出 assembly-mismatch 拒绝原因');
    // feed-side 窗口 [16,22) 在 now=22 已关闭。
    assert.ok(plan.rejections.some(r => r.channel === 'feed-side' && r.reason === 'window-or-due'));

    const feasibility = overview.feasibility.find(f => f.order === 'W7');
    assert.equal(feasibility.feasible, false);
    // G2 批次已无有效门控，两张卡均以前置失效为阻塞，而非自动改用 G3 通道。
    assert.deepEqual(feasibility.blockers.map(b => b.reason), ['no-eligibility', 'no-eligibility']);
    assert.ok(feasibility.blockers.every(b => b.detail.includes('G2')));

    // 严格计划在无步骤时抛出带排除原因的错误。
    assert.throws(() => orchestrator.planOrThrow(), error => {
      assert.ok(error instanceof PlanRejectedError);
      assert.ok(error.rejections.some(r => r.channel === 'probe-next' && r.reason === 'assembly-mismatch'));
      return true;
    });
  } finally {
    await source.close();
  }
});

test('联合取件三条件缺一即拒绝组队，并给出逐家原因', async () => {
  const { source, orchestrator, stage } = await harness();
  try {
    await stage('replacement');
    // G3 通道对 G2 工单装配批次不一致，强制指定也会被拒。
    await assert.rejects(
      () => orchestrator.read('probe-next', ['W7']),
      error => {
        assert.equal(error.reason, 'participant-not-eligible');
        assert.ok(error.rejections.some(r => r.order === 'W7' && r.reason === 'assembly-mismatch'));
        return true;
      },
    );
    // feed-side 属于 F9，W7/W8 是 G2，无相关委托，通道不可用。
    const rejection = orchestrator.plan().rejections.find(r => r.channel === 'feed-side' && r.reason === 'window-or-due');
    assert.ok(rejection);
  } finally {
    await source.close();
  }
});

test('值班检查卡视图能回答未满足条件、剩余通道、停顿与领件记录', async () => {
  const { source, orchestrator, stage } = await harness();
  try {
    await stage('initial');
    await orchestrator.run();
    const view = orchestrator.cardView('drive-check');
    assert.deepEqual(view.channels.map(c => c.channelId), ['probe-alpha', 'probe-mirror']);
    const alpha = view.channels.find(c => c.channelId === 'probe-alpha');
    assert.equal(alpha.available, false);
    const receipt = view.receipts.find(r => r.receiptId === 'H2');
    assert.deepEqual(receipt.orders, ['W7', 'W8']);
    assert.equal(receipt.state, 'pending');
    assert.ok(view.rejections.some(r => r.reason === 'order-pause-limit'));
  } finally {
    await source.close();
  }
});
