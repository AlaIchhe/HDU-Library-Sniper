# 慧图 API 响应契约（Kotlin 形状参考）

真实脱敏样例见 `samples/*.json`;运行期结构校验见 `core/library` 的 commonTest 契约测试。
本文档仅作类型注解参考,不参与运行期校验——服务器响应字段以样例为准。

魔法路径与 `MSG_*` 常量的运行期定义在 `core/library` 的 `HuituResponses.kt`(单一源);
本文档不导入它(位于 docs/),避免双份漂移。

> 以下 Kotlin data class 仅为**人读形状规约**。运行期访问器(`HuituResponses.baseInfoData`
> 等)与 `MSG_*` 常量均在 `core/library`,本文件不再持有常量副本。

## HuituEnvelope

不带 LAB_JSON 的只读 GET / 写 POST 的通用信封。

```kotlin
@Serializable
data class HuituEnvelope(
    val CODE: JsonPrimitive,          // "ok" | "ParamError" | "请检查参数设置" | 1(限流)
    val MESSAGE: String = "",
    val DATA: JsonObject = JsonObject(emptyMap()),
    @SerialName("ui_type") val uiType: String = "",
    @SerialName("_debug_info") val debugInfo: List<String> = emptyList(),
)
```

## BaseInfoData

`/User/Center/baseInfo`(不带 LAB_JSON)的 DATA。

```kotlin
@Serializable
data class BaseInfoData(
    @SerialName("is_login") val isLogin: Boolean = false,
    val uid: String = "",             // 平台用户 id(签名用),如 "304174"
    val uname: String = "",
    val unickname: String = "",
    @SerialName("user_info") val userInfo: JsonObject = JsonObject(emptyMap()),
    @SerialName("lab_content_org_id") val labContentOrgId: String = "",
)
```

## RoomTypeItem

`/Space/Category/list` 的 `content.children[1].defaultItems[]`。

```kotlin
@Serializable
data class RoomTypeItem(
    val name: String = "",            // "自习室" 等
    @SerialName("engName") val engName: String = "",
    val link: Link = Link(),
) {
    @Serializable
    data class Link(
        val url: String = "",         // 含 space_category[category_id]=..&[content_id]=..
        val type: String = "push",
    )
}
```

## SeatPoi

座位图里的单个座位 `seatMap.POIs[]`。

```kotlin
@Serializable
data class SeatPoi(
    val id: String = "",              // seat_id,bookSeats 的 seats[0]
    val title: String = "",           // 座位号,findSeat 用它匹配 plan.seatNum
    val state: JsonPrimitive? = null, // 可用性状态(0/'1'/'3' 见过;含义未完全确定,'3' 对应某时刻已被占)
    val x: String = "",
    val y: String = "",
    val w: String = "",
    val h: String = "",
    @SerialName("have_socket") val haveSocket: String = "0",
    val gender: Int? = null,          // 可缺省
    val locker: List<JsonElement> = emptyList(),
)
```

## FloorItem

座位图楼层项 `allContent.children[2].children.children[]`。

```kotlin
@Serializable
data class FloorItem(
    @SerialName("roomName") val roomName: String = "",
    @SerialName("seatMap") val seatMap: SeatMap = SeatMap(),
    @SerialName("orderInfo") val orderInfo: JsonElement? = null,
    @SerialName("userInfo") val userInfo: JsonElement? = null,
    val collapsed: Boolean = false,
    @SerialName("ifAdjust") val ifAdjust: Boolean = false,
) {
    @Serializable
    data class SeatMap(
        val info: Info = Info(),
        @SerialName("POIs") val pois: List<SeatPoi> = emptyList(),
    ) {
        @Serializable
        data class Info(val id: String = "")  // 楼层 id
    }
}
```

## BookingOrderItem

`/Seat/Index/myBookingList` 的 order item。注意字段名。

```kotlin
@Serializable
data class BookingOrderItem(
    @SerialName("roomName") val roomName: String = "",
    @SerialName("seatNum") val seatNum: String = "",  // 座位号(= POI title,非 seat_id)
    val time: String = "",        // 预约开始时间戳(秒,字符串)
    val duration: String = "",    // 秒(字符串)
    val status: String = "",      // "1"/"4"/"7" 等
    @SerialName("ifSponsor") val ifSponsor: Boolean = false,
    @SerialName("limitSignAgo") val limitSignAgo: Int = 0,
    @SerialName("limitSignBack") val limitSignBack: Int = 0,
    @SerialName("limitLeftBack") val limitLeftBack: Int = 0,
    @SerialName("orderTime") val orderTime: String = "",
    val id: Long = 0,             // 预约记录 id
    @SerialName("nowTime") val nowTime: Long = 0,
    val link: Link = Link(),      // /Seat/Index/bookingInfo?bookingId=...
    @SerialName("spaceId") val spaceId: JsonElement? = null,
    val ibeacons: List<JsonElement> = emptyList(),
) {
    @Serializable
    data class Link(val url: String = "", val type: String = "push")
}
```

---

`MSG_*` 运行期定义在 `core/library` 的 `HuituResponses.kt`(单一源,与 `samples/book_seats.json` 实抓对齐);
本文档仅作类型注解参考,不再持有常量副本,避免双份漂移。
