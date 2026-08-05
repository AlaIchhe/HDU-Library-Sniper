# 设计目录

本目录使用 EventStorming 方法记录 HDU-Library-Sniper 的业务行为。图以 Mermaid 为主，可以从 Mermaid Live Editor 或支持 Mermaid 的文档工具中渲染。

## 目录

- [需求与参与者](requirements.md)
- [事件风暴大图](big-picture.mmd)
- 关键流程
  - [抢座执行](processes/process-booking.mmd)
  - [自动签到](processes/process-checkin.mmd)
  - [系统调度](processes/process-scheduling.mmd)
- 数据模型
  - [ERD](data/erd.mmd)
  - [预约状态机](data/state-booking.mmd)
- 时序
  - [登录](flows/sequence-login.mmd)
  - [抢座](flows/sequence-book-seat.mmd)

## 配套分析

- [领域模型](../analysis/domain-model.md)
- [业务规则与边界](../analysis/business-rules.md)
- [异常与错误映射](../analysis/exception-map.md)
- [C4 架构图](../c4/README.md)
- [接口文档](../api/API.md)
- [测试用例矩阵](testing/test-case-matrix.md)

## Hotspots

- 座位 `POI.state` 的确切含义未完全确认，代码只按 title 定位。
- `cancelTimesLimit` 等取消限制接口未接入，取消后只按业务信封和列表状态复核。
- 限流响应 `CODE=1` 当前会判定为失败并 skip，未做指数退避。
- Web 模式是单租户；多用户/多实例需要拆分会话存储和任务协调。
