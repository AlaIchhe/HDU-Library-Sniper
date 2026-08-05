# 业务分析

本目录基于 `src/hdu_sniper`、`docs/contracts` 和现有测试整理，回答三类问题：

- 领域模型：有哪些实体、聚合、值对象和状态机。
- 业务规则：哪些规则是产品硬约束，哪些是安全边界。
- 异常场景：异常从哪来，如何映射到本地 API。

## 文档

- [领域模型](domain-model.md)
- [业务规则与边界](business-rules.md)
- [异常与错误映射](exception-map.md)
- [事件风暴](../design-catalog/README.md)
- [C4 架构图](../c4/README.md)
- [接口文档](../api/API.md)
- [测试用例矩阵](../design-catalog/testing/test-case-matrix.md)
