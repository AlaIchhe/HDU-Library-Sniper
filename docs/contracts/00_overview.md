# 慧图图书馆 API 契约

基于真实抓包(2026-07-10,Playwright MCP 驱动浏览器,登录态 CAS)。所有字段来自观测,**不猜**。
原始抓包在 `fixtures/captures/`(含 uid 等本地值,gitignore);本文档及 `docs/contracts/**` 为脱敏版,可入库。

> 运行期魔法路径与 `MSG_*` 常量单一源在 `core/contract.py`(纯叶模块);本文档与
> `schemas.md` 仅作人读规约。`tests/test_contracts.py` 对每条 `contract.*` 访问器在
> 样例上断言——服务器改结构 → 样例更新 → 测试非零退出,提醒契约漂移。

## 通用信封

只读 `GET`(不带 `LAB_JSON`)与写 `POST` 返回干净 JSON 信封:

```json
{ "CODE": "ok" | "ParamError" | "请检查参数设置" | 1 | ..., "MESSAGE": "...", "DATA": { ... }, "ui_type": "com.Message" | ... , "_debug_info": ["..."] }
```

- 成功:`CODE="ok"`。
- 失败:`CODE="ParamError"`(多种错误共用此 CODE,**必须靠 MESSAGE 区分**),或 `CODE="请检查参数设置"`,或整数 `1`(限流)。
- `DATA` 在失败时常含 `result:"fail"` + `msg:<同 MESSAGE>`,以及用户基本信息(`uid`/`uname`/...)。
- 成功判定见 `core/sniper/retry.py:booking_failed`:`code != "ok"` 即失败。

## 认证模型

1. **Cookie**:慧图域 `hdu.huitu.zhishulib.com` 的会话 Cookie(经杭电 CAS `sso.hdu.edu.cn` 登录获得)。所有请求自动带。
2. **Api-Token(仅 bookSeats)**:`base64(md5(source))`,`source` 固定拼接:
   ```
   post&/Seat/Index/bookSeats?LAB_JSON=1&api_time{api_time}&beginTime{beginTime}&duration{duration}&is_recommend{is_recommend}&seatBookers[0]{uid}&seats[0]{seat_id}
   ```
   算法实现在 `utils/encrypt.py:generate_api_token`,**已对真实服务器验证通过**。`api_time` 为当前秒级时间戳,有轻微时钟偏差容忍。

## LAB_JSON 规则(关键)

Session 默认带 `LAB_JSON=1`(`core/client.py:DEFAULT_SESSION_PARAMS`)。对 `baseInfo` 这类端点:
- **不带 LAB_JSON** → 干净 `{CODE,MESSAGE,DATA}` 信封(`_debug_info:["没有指定LAB平台模板"]`)。`validate_cookie`/`resolve_uid` 用 `params={"LAB_JSON": None}` 达成(见 `contract.base_info_data`)。
- **带 LAB_JSON=1** → UI 页面树(`com.BackRefreshPage` 等),**不是数据信封**。

代码依赖"不带 LAB_JSON"取干净 DATA,见 `contract.base_info_data` 注释。

## 端点表

| 端点 | 方法 | 用途 | 代码调用处 | LAB_JSON |
|---|---|---|---|---|
| `/Space/Category/list` | GET | 房间类型列表 | `client.get_room_types` → `contract.room_types_from_response` | 1 |
| `/Seat/Index/searchSeats?{query}` | GET | 单房间详情(取 space_category) | `client.get_room_detail` → `contract.room_detail_from_response` | 1 |
| `/Seat/Index/searchSeats` | POST | 座位分布图(楼层+座位) | `client.get_seat_map` → `contract.floors_from_response` | 1 |
| `/User/Center/baseInfo` | GET | 用户信息(uid/is_login) | `client.validate_cookie`/`resolve_uid` → `contract.base_info_data` | **不带** |
| `/Seat/Index/bookSeats` | POST | 提交预约 | `client.book_seat`(签名 `utils/encrypt.py`) | 1 |
| `/Seat/Index/myBookingList?fromType=web` | GET | **今日/近期预约列表(真正的)** | `client.get_todays_bookings` → `contract.bookings_from_response` | 1 |
| `/Seat/Index/todayUserBookSeat` | GET | 返回字符串 `"todayUserBookSeatAction"`,**不是预约列表** | —(不再引用;原误用,Phase 3 已修) | — |

## 魔法路径验证表

| 访问器(单一源) | 路径 | 真实结构 | 验证 |
|---|---|---|---|
| `contract.room_types_from_response` | `content.children[1].defaultItems` | `children`=[Ridge, List, null],`[1]`=com.List,`.defaultItems`=房间类型项 | ✅ 正确 |
| `contract.room_detail_from_response` | `response.data`(小写)→ `data.space_category.{category_id,content_id}` | `data`=com.Raw,含 `space_category`(喂 `get_seat_map`) | ✅ 正确(sample: room_detail.json) |
| `contract.floors_from_response` | `allContent.children[2].children.children` | `allContent.children`=[,,com.CatCon],`[2].children.children`=楼层数组 | ✅ 正确 |
| `contract.floor_id` / `floor_seats` / `seat_title` / `seat_id` | `seatMap.info.id` / `seatMap.POIs` / `POI.title` / `POI.id` | 楼层 id + 座位项(座位号=title,预约用 id) | ✅ 正确 |
| `contract.base_info_data` → `base_info_is_login`/`base_info_uid` | `DATA.is_login` / `DATA.uid` | uid(平台 id,签名用) ≠ user_info.cardno(学号) | ✅ 正确 |
| `contract.bookings_from_response` + `contract.booking_begin_ts` | `content.defaultItems[]` → `item.time` | order item 真实字段 `seatNum`(座位号,非 seat_id)+ `time`(开始戳)+ `id` | ✅ 正确(Phase 3 已修,原 seat_id/beginTime 多键回退 ❌ 已删) |

## 关键发现

1. **`find_confirmed_booking` 已修复(Phase 3)**:端点改 `myBookingList?fromType=web`(原误用 `todayUserBookSeat`,只返回字符串拿不到数据);匹配字段改 `time`(±1s,原 `seat_id`/`beginTime` 多键回退全错——真实字段是 `seatNum`(座位号≠seat_id)+ `time`);弃用的 `seat_id` 形参已移除(`time` 单字段即可唯一识别,因 bookSeats 若真超时此前不应有同 begin_ts 预约,否则会立即返回 duplicate)。见 `contract.bookings_from_response` / `contract.booking_begin_ts` 与 `client.find_confirmed_booking`。

2. **子串匹配是必要的,不是偷懒**:`CODE=ParamError` 被 time_out_of_range / past_time / duplicate / seat_unavailable **共用**。无法仅靠 CODE 区分 → `retry.py` 用 MESSAGE 子串判定**正确**。保留子串匹配(用 `contract.MSG_*` 已验证字符串),**不要**改成"只看 CODE"。

3. **uid ≠ 学号**(`baseInfo.DATA`):`uid="304174"`(平台用户 id,`bookSeats` 签名用它),`user_info.cardno/name="23320116"`(学号)。`resolve_uid` 取 `DATA.uid` **正确**(`contract.base_info_uid`)。原"学号误当 uid"事故的根因现已钉死在契约里。

4. **限流响应**:`CODE=1`(整数!)`MESSAGE="请求太频繁了,请稍后再试"`。`booking_failed` 把它当失败 → `default_retry_decider` 落到 SKIP。可考虑改为退避重试(非必须)。

5. **seat 对象**:`{id=seat_id, title=座位号, state, x/y/w/h, have_socket, gender, locker}`。`RoomBrowser.find_seat` 用 `title`(`contract.seat_title`)匹配 `seat_num`,返回后用 `id`(`contract.seat_id`)作 `seats[0]`——**正确**。`state` 含义(0/'1'/'3' 哪个=可用)**未完全确定**,只知 '3' 在某查询时刻对应已被占。

6. **bookSeats success 形状未实抓**:探测的每个时段都撞 duplicate(时段冲突)或 seat_unavailable(被占),**未产生任何真实预约**(无需取消)。`CODE="ok"` 由 baseInfo 信封一致性推断;如需实抓,在 web UI 约一个确实空的座,看 network 响应即可。

## 文件

- `schemas.md` — 各端点 TypedDict(类型参考,doc-only;不持有 `MSG_*`,运行期常量在 `core/contract.py`)。
- `samples/<endpoint>.json` — 脱敏样例(入库,供测试):`room_types`/`room_detail`/`seat_map`/`baseInfo`/`book_seats`/`myBookingList`。
- `../../core/contract.py` — 运行期单一契约入口:魔法路径访问器 + `MSG_*`(纯叶模块,被 `client`/`room_browser`/`retry` 导入)。
- `../../tests/test_contracts.py` — 结构断言:对每条 `contract.*` 访问器在样例上校验,服务器改结构即非零退出。
- `../../fixtures/captures/` — 原始抓包(本地,gitignore,含真实 uid)。
