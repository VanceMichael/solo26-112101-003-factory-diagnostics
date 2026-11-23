# 停顿受限时的联合诊断取件与顾问交付

厂内目录 `/gateway/channels` 提供通道、装配批次、样本声明及可占用的半开整数时段。单次操作最晚在时段终点完成，整个工厂同一时刻仅允许一个停顿。 `/gateway/clock` 返回现场时标。工单约定及更新由 `/desk/orders`、`/desk/eligibility` 提供，优先级数字小者靠前。同优先级优先能在承诺截止前完成的工单，允许把同优先且均可完成的先后留给值班人。优先级是否满足以成套交付可行性为准。 `requiredSignals` 定义证据最低范围，顾问实际可见字段在 `visibleSignals` 中。
 
领取通道用 `POST /gateway/read/通道`，查询已占用或已结算凭据用 `GET /gateway/receipt/编号`。读取报告的 `state`、`release` 和 `chunks` 分别表达结果、停顿是否返还及样本原件片段。持续占用仍算到工单或共用收件的全厂上限，已结算消耗不会退回。部分记录的续领入口由 `resume` 给出。样本值为演练数据，停顿时段使用演练时标，不需要真实生产设备。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t factory-diagnostics-sources .`，再执行 `docker run --rm factory-diagnostics-sources`。镜像准备完成后的验证不需要外网。

## 值班工作台

工作台在来源之上实现联合取件与值班交接，全部依赖判定集中在 `lib/rules.mjs`，网关只发原件与回执：

- **联合取件三条件**：源端证明同一样本（样本签发编号一致）、委托仍允许领（同装配批次、检查卡在委托内、门控结论有效、停顿未超限）、数据覆盖通道声明的完整度，三者同时满足才用一次停顿服务多个委托，同一样本只存一条原件证据并挂接多个工单。
- **前置门控**：资格条目挂在实际检查卡上，`permits` 表示其放行的后置卡。受控卡在当前批次找不到 `allow` 门控即不可领；前置 `withdrawn` 后原件不删除，标记为待换领并列出仍可独立引用的证据；新批次门控不会自动认领旧装配批次样本。从未出现在资格表中的卡按无前置条件处理。
- **停顿账本**：区分占用中（pending/partial）、已结算（complete/failed，不退回）与 `release=true` 的窗口释放；全局唯一停顿与各工单上限分别记账。自动值班遇到 pending 立即停下，由回执轮询/续领推进。
- **部分数据**：`partial` 回执与 `resume` 续领凭据只登记为缺项片段供现场查缺，绝不进入顾问成套资料；续领 409 且 `release=false` 时停顿继续占用。
- **计划排序**：工单优先级 → 可成套交付 → 承诺截止 → 窗口终点，每条被排除通道都给出逐工单原因。
- **顾问交付**：`visibleSignals` 之外的字段在工作台侧过滤，无可见字段的卡不计成套、不暴露空原件；缺项只给现场待查提示。

启动方式（两个终端或同一网络命名空间）：

```bash
npm run sources                         # 演练来源，默认 127.0.0.1:4180
SOURCE_URL=http://127.0.0.1:4180 npm run workbench   # 工作台，默认 127.0.0.1:4181
```

对回环地址的请求走 `node:http` 直连，避免环境代理变量拦截本地来源。接口：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /workbench/refresh` | 拉取时标、通道、工单与门控结论，复核既有资料状态 |
| `GET /workbench/plan` | 取件计划与全部排除原因 |
| `GET /workbench/plan/strict` | 同计划，但无可用步骤时返回 409 与排除原因 |
| `POST /workbench/run` | 按计划自动领取，遇 pending 自动停下 |
| `POST /workbench/read` | 按通道领取，可在 `orderIds` 指定联合工单 |
| `POST /workbench/receipt/poll` | 轮询回执，登记 partial/failed 与停顿释放 |
| `POST /workbench/resume` | 凭回执中的续领凭据续领 |
| `GET /workbench/cards/:card` | 检查卡视图：未满足条件、剩余通道、停顿与领件记录 |
| `GET /workbench/advisors/:advisor` | 顾问视图：仅含其有权查看字段的成套资料 |
| `GET /workbench/events` | 审计事件流 |
| `GET /workbench/overview` | 停顿账本、工单可行性与成套资料总览 |

`npm run drill` 在单进程内起来源并跑通 initial → invalidation → replacement 三阶段：联合取件、pending 占停顿、前置作废待换领、续领冲突、失败释放与跨批次不认领。
