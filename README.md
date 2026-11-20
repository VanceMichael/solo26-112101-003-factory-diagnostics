# 停顿受限时的联合诊断取件与顾问交付

厂内目录 `/gateway/channels` 提供通道、装配批次、样本声明及可占用的半开整数时段。单次操作最晚在时段终点完成，整个工厂同一时刻仅允许一个停顿。 `/gateway/clock` 返回现场时标。工单约定及更新由 `/desk/orders`、`/desk/eligibility` 提供，优先级数字小者靠前。同优先级优先能在承诺截止前完成的工单，允许把同优先且均可完成的先后留给值班人。优先级是否满足以成套交付可行性为准。 `requiredSignals` 定义证据最低范围，顾问实际可见字段在 `visibleSignals` 中。
 
领取通道用 `POST /gateway/read/通道`，查询已占用或已结算凭据用 `GET /gateway/receipt/编号`。读取报告的 `state`、`release` 和 `chunks` 分别表达结果、停顿是否返还及样本原件片段。持续占用仍算到工单或共用收件的全厂上限，已结算消耗不会退回。部分记录的续领入口由 `resume` 给出。样本值为演练数据，停顿时段使用演练时标，不需要真实生产设备。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t factory-diagnostics-sources .`，再执行 `docker run --rm factory-diagnostics-sources`。镜像准备完成后的验证不需要外网。
