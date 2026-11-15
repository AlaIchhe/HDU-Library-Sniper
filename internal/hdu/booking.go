package hdu

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"hdu-library-sniper/internal/core"
)

type Action string

const (
	ActionCancel   Action = "cancel"
	ActionCheckIn  Action = "checkin"
	ActionComeBack Action = "comeback"
	ActionSignOut  Action = "signout"
	ActionLeave    Action = "leave"
)

func (c *LibraryClient) Bookings(ctx context.Context) ([]map[string]any, error) {
	body, err := c.requestJSON(ctx, "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1", http.MethodGet, nil, nil, false)
	if err != nil {
		return nil, err
	}
	items := core.AsSlice(core.Get(body, "content", "defaultItems"))
	if items == nil {
		return nil, LibraryError("预约列表解析失败")
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m := core.AsMap(it); m != nil {
			out = append(out, m)
		}
	}
	return out, nil
}

func (c *LibraryClient) BookSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (map[string]any, error) {
	uid := c.UID()
	if uid == "" {
		if !c.Validate(ctx) {
			return nil, AuthExpired("图书馆登录状态已失效")
		}
		uid = c.UID()
	}
	begin := beginTime.Unix()
	duration := durationHours * 3600
	apiTime := time.Now().Unix()

	form := url.Values{}
	form.Set("beginTime", strconv.FormatInt(begin, 10))
	form.Set("duration", strconv.FormatInt(duration, 10))
	form.Set("is_recommend", "0")
	form.Set("api_time", strconv.FormatInt(apiTime, 10))
	form.Set("seats[0]", seatID)
	form.Set("seatBookers[0]", uid)

	headers := http.Header{}
	headers.Set("Api-Token", ApiToken(seatID, uid, begin, duration, apiTime))
	return c.requestJSON(ctx, "/Seat/Index/bookSeats?LAB_JSON=1", http.MethodPost, form, headers, true)
}

func (c *LibraryClient) LockSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (map[string]any, error) {
	form := url.Values{}
	form.Set("beginTime", strconv.FormatInt(beginTime.Unix(), 10))
	form.Set("duration", strconv.FormatInt(durationHours*3600, 10))
	form.Set("is_recommend", "0")
	form.Set("api_time", strconv.FormatInt(time.Now().Unix(), 10))
	form.Set("seats[0]", seatID)
	return c.requestJSON(ctx, "/Seat/Index/lockSeats?LAB_JSON=1", http.MethodPost, form, nil, true)
}

func (c *LibraryClient) UnlockAllSeats(ctx context.Context) (map[string]any, error) {
	return c.requestJSON(ctx, "/Seat/Index/unlockAllSeats?LAB_JSON=1", http.MethodPost, url.Values{}, nil, true)
}

func (c *LibraryClient) Action(ctx context.Context, action Action, bookingID string) (map[string]any, error) {
	encoded := url.QueryEscape(bookingID)
	if action == ActionLeave {
		latest, err := c.requestJSON(
			ctx,
			"/Seat/Index/stepOutLatestComeBackTime?bookingId="+encoded+"&LAB_JSON=1",
			http.MethodPost, url.Values{}, nil, true,
		)
		if err != nil {
			return nil, err
		}
		if err := AssertActionSuccess(latest); err != nil {
			return nil, err
		}
		comeBack := core.GetInt64(latest, "DATA", "latest_come_back_time")
		if comeBack <= 0 {
			return nil, LibraryError("暂离返回时间无效")
		}
		form := url.Values{}
		form.Set("comeBackTime", strconv.FormatInt(comeBack, 10))
		resp, err := c.requestJSON(
			ctx,
			"/Seat/Index/stepOut?bookingId="+encoded+"&LAB_JSON=1",
			http.MethodPost, form, nil, true,
		)
		if err != nil {
			return nil, err
		}
		if err := AssertActionSuccess(resp); err != nil {
			return nil, err
		}
		return resp, nil
	}

	var endpoint string
	switch action {
	case ActionCancel:
		endpoint = "/Seat/Index/cancelBooking"
	case ActionCheckIn:
		endpoint = "/Seat/Index/checkIn"
	case ActionComeBack:
		endpoint = "/Seat/Index/comeBack"
	case ActionSignOut:
		endpoint = "/Seat/Index/checkOut"
	default:
		return nil, LibraryError("不支持的操作类型")
	}
	resp, err := c.requestJSON(
		ctx,
		endpoint+"?bookingId="+encoded+"&LAB_JSON=1",
		http.MethodPost, url.Values{}, nil, true,
	)
	if err != nil {
		return nil, err
	}
	if err := AssertActionSuccess(resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// AssertActionSuccess validates HDU action responses, tolerating empty DATA.result (as in cancelBooking).
func AssertActionSuccess(body map[string]any) error {
	code := core.ToString(body["CODE"])
	result := core.GetString(body, "DATA", "result")
	if strings.EqualFold(code, "ok") && (result == "" || strings.EqualFold(result, "success")) {
		return nil
	}
	return LibraryError(responseErrorMessage(body, "馆方操作失败"))
}

func responseErrorMessage(body map[string]any, fallback string) string {
	msg := strings.TrimSpace(core.GetString(body, "DATA", "msg"))
	if msg == "" {
		msg = strings.TrimSpace(core.ToString(body["MESSAGE"]))
	}
	if msg == "" || strings.EqualFold(msg, "ok") || strings.EqualFold(msg, "success") {
		return fallback
	}
	return msg
}

// BookingFromRaw maps a raw myBookingList entry into the frontend DTO, returning nil for historical states.
func BookingFromRaw(item map[string]any, now time.Time) *core.Booking {
	status := strings.TrimSpace(core.ToString(item["status"]))
	switch status {
	case "3", "4", "5", "6", "7", "9":
		return nil
	}
	begin := core.ToInt64(item["time"])
	if begin <= 0 {
		begin = now.Unix()
	}
	duration := core.ToInt64(item["duration"])
	limitAgo := core.ToInt64(item["limitSignAgo"])
	limitBack := core.ToInt64(item["limitSignBack"])
	nowSec := now.Unix()
	canCheckIn := status == "0" && nowSec >= begin-limitAgo && nowSec <= begin+limitBack

	state := "pending"
	statusLabel := "待签到"
	if canCheckIn {
		state = "check_in"
		statusLabel = "可签到"
	} else {
		switch status {
		case "1":
			state = "in_use"
			statusLabel = "使用中"
		case "2":
			state = "away"
			statusLabel = "暂离中"
		}
	}

	roomName := strings.TrimSpace(core.ToString(item["roomName"]))
	if roomName == "" {
		roomName = "未知房间"
	}
	seatNum := strings.TrimSpace(core.ToString(item["seatNum"]))
	if seatNum == "" {
		seatNum = "-"
	}
	var hours int64
	if duration > 0 {
		hours = duration / 3600
	}

	return &core.Booking{
		BookingID:    core.ToString(item["id"]),
		RoomName:     roomName,
		SeatNum:      seatNum,
		StartText:    core.FormatZhUnix(begin),
		DurationText: strconv.FormatInt(hours, 10) + " 小时",
		Status:       status,
		State:        state,
		StatusLabel:  statusLabel,
		CanCancel:    status == "0",
		CanCheckIn:   canCheckIn,
		CanSignOut:   status == "1" || status == "2",
		CanLeave:     status == "1",
		CanRenew:     status == "2",
	}
}
