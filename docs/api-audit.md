# 图书馆接口安全探测记录

探测日期：2026-07-31

## 结论

本次对 `提取接口结果.txt` 中的 52 条路径进行了匿名探测。没有携带 Cookie、Api-Token 或个人参数，也没有发送预约、借阅、取消、上传、定位等写请求。

| 结论 | 接口 | 说明 |
| --- | --- | --- |
| 已接入只读查询 | `GET /Seat/Index/bookingStatus?bookingId=` | 路由可达；适合读取单条预约的服务端状态 |
| 已接入只读查询 | `GET /Seat/Index/stepOutLatestComeBackTime?bookingId=` | 路由可达；适合读取暂离后的最晚返回时间 |
| 项目已有 | `GET /Space/Category/list`、`GET/POST /Seat/Index/searchSeats`、`GET /Seat/Index/myBookingList?fromType=web`、`GET /User/Center/baseInfo`、`POST /Seat/Index/bookSeats` | 已有客户端和契约测试，登录后可用于房间、座位、预约和预约记录 |
| 登录后待验证 | 共享图书、借阅、在线证件、扫码签到、锁座/解锁、志愿服务、人脸绑定等 | 路由能返回登录跳转或 JSON 外壳，但缺少请求参数/成功响应契约；贸然接入会有副作用或业务误判 |
| 疑似失效 | `/Bookshelf/BookshelfMgt/judgeCallNumber`、`/Bookshelf/BookshelfMgt/gridSave` | 在当前域名返回 HTTP 404 |
| 外部依赖失效 | `http://rtls1.palmap.cn:40400` | DNS 无法解析，暂不能作为定位增强能力接入 |

## 匿名探测结果

- 多数接口返回 HTTP 302 和 `text/html`，表示未登录请求被导向登录页；这证明不了接口失效。
- `libRegister`、`testWxShare`、`wxaH5Url`、`onlineCertificate` 等接口能返回 JSON，但响应仍包含登录状态字段，不能视为已取得个人业务数据。
- 使用项目约定的 `LAB_JSON=1` 后，房间、用户、预约记录和座位查询接口能返回 JSON/UI 响应；未登录时不会返回真实账户数据。

## 代码改动

新增了两个只读客户端方法，并通过应用层和本地 FastAPI 暴露：

- `GET /api/v1/bookings/{booking_id}/status`
- `GET /api/v1/bookings/{booking_id}/latest-comeback-time`

两条本地接口都要求现有登录态，只接受数字预约 ID，并且不会发送 `Api-Token` 或执行远程写操作。返回值保留图书馆原始响应，待有登录态后可根据真实字段继续完善 UI 展示。
