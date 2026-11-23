// 端到端本地演练：在同一进程内起演练来源，工作台完成联合取件、
// 前置作废交接、续领冲突与换装配批次后的重新规划。

import { startSources } from '../sources/server.mjs';
import { GatewayClient } from '../lib/gateway-client.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';

const line = title => console.log(`\n=== ${title} ===`);
const brief = value => JSON.stringify(value, null, 2);

const source = await startSources(Number(process.env.PORT ?? 4180));
const orchestrator = new Orchestrator(new GatewayClient(source.url));

try {
  line('阶段 initial：拉取工单约定与现场时标');
  await orchestrator.refresh();
  let plan = orchestrator.plan();
  console.log('计划顺序（按优先级、可成套性、窗口排序）：');
  for (const step of plan.steps) {
    console.log(`- ${step.channelId} / 卡 ${step.card} / 样本 ${step.sample} / 联合工单 ${step.participantOrders.map(p => p.orderId).join('+')}`);
  }
  console.log('被排除通道：', brief(plan.rejections));

  line('第一次领取：oil-main 一次停顿同时满足 W7、W8（同样本 OL-07 / 同批次 G2 / 完整度达标）');
  const oil = await orchestrator.read('oil-main');
  console.log(brief(oil));

  line('第二次领取：probe-alpha 被受理（202），停顿窗口持续占用');
  const pending = await orchestrator.read('probe-alpha');
  console.log(brief(pending));
  console.log('停顿账本：', brief(orchestrator.overview().globalPauses));

  line('最后一个全厂停顿：W7/W8 工单上限各 2 次已用尽，按规则交给唯一仍具备条件的 W9');
  const feed = await orchestrator.read('feed-side');
  console.log(brief(feed));

  line('顾问视图（字段按 visibleSignals 过滤）');
  console.log('设备商甲：', brief(orchestrator.advisorView('设备商甲')));
  console.log('设备商乙：', brief(orchestrator.advisorView('设备商乙')));

  line('阶段 invalidation：前置结论 V1 作废，H2 变为部分数据');
  await orchestrator.client.selectScenario('invalidation');
  await orchestrator.refresh();
  const partial = await orchestrator.pollReceipt('H2');
  console.log('H2 回执（部分数据只进缺项片段）：', brief(partial));
  const resumeResult = await orchestrator.resume('H2');
  console.log('续领结果（409 且 release=false，停顿继续占用）：', brief(resumeResult));
  console.log('drive-check 值班视图：', brief(orchestrator.cardView('drive-check')));
  console.log('设备商甲待换领提示：', brief(orchestrator.advisorView('设备商甲')));

  line('阶段 replacement：H2 失败并释放停顿，新前置 V2 属于 G3，旧批次 G2 样本不能自动认领');
  await orchestrator.client.selectScenario('replacement');
  await orchestrator.refresh();
  const failed = await orchestrator.pollReceipt('H2');
  console.log('H2 最终回执：', brief(failed));
  plan = orchestrator.plan();
  console.log('新计划（probe-next 因 G2/G3 批次不一致被排除，无可用步骤）：');
  console.log(brief({ steps: plan.steps.map(s => s.channelId), rejections: plan.rejections }));
  console.log('最终总览：', brief(orchestrator.overview()));
  console.log('\n演练结束。');
} finally {
  await source.close();
}
