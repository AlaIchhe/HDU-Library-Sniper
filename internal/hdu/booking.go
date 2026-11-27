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

func (c *LibraryClient) Bookings(ctx context.Context) ([]RawBooking, error) {
	var env bookingListEnvelope
	if err := c.requestInto(
		ctx,
		"/Seat/Index/myBookingList?fromType=web&LAB_JSON=1",
		http.MethodGet, nil, nil, false, &env,
	); err != nil {
		return nil, err
	}
	if env.Content == nil || env.Content.DefaultItems == nil {
		return nil, LibraryError("预约列表解析失败")
	}
	return env.Content.DefaultItems, nil
}

func (c *LibraryClient) BookSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (ActionResult, error) {
	uid := c.UID()
	if uid == "" {
		if !c.Validate(ctx) {
			return ActionResult{}, AuthExpired("图书馆登录状态已失效")
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
	var resp ActionResponse
	if err := c.requestInto(ctx, "/Seat/Index/bookSeats?LAB_JSON=1", http.MethodPost, form, headers, true, &resp); err != nil {
		return ActionResult{}, err
	}
	msg := resp.ErrorMessage("")
	ok := resp.IsOK() && (strings.EqualFold(resp.Result(), "success") || strings.Contains(msg, "成功"))
	return ActionResult{
		OK:      ok,
		Result:  resp.Result(),
		Message: msg,
	}, nil
}

func (c *LibraryClient) LockSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (ActionResult, error) {
	form := url.Values{}
	form.Set("beginTime", strconv.FormatInt(beginTime.Unix(), 10))
	form.Set("duration", strconv.FormatInt(durationHours*3600, 10))
	form.Set("is_recommend", "0")
	form.Set("api_time", strconv.FormatInt(time.Now().Unix(), 10))
	form.Set("seats[0]", seatID)

	var resp ActionResponse
	if err := c.requestInto(ctx, "/Seat/Index/lockSeats?LAB_JSON=1", http.MethodPost, form, nil, true, &resp); err != nil {
		return ActionResult{}, err
	}
	return ActionResult{
		OK:      resp.IsOK(),
		Result:  resp.Result(),
		Message: resp.ErrorMessage(""),
	}, nil
}

func (c *LibraryClient) UnlockAllSeats(ctx context.Context) (ActionResult, error) {
	var resp ActionResponse
	if err := c.requestInto(ctx, "/Seat/Index/unlockAllSeats?LAB_JSON=1", http.MethodPost, url.Values{}, nil, true, &resp); err != nil {
		return ActionResult{}, err
	}
	return ActionResult{
		OK:      resp.IsOK(),
		Result:  resp.Result(),
		Message: resp.ErrorMessage(""),
	}, nil
}

func (c *LibraryClient) Action(ctx context.Context, action Action, bookingID string) (ActionResult, error) {
	encoded := url.QueryEscape(bookingID)
	if action == ActionLeave {
		var latest ActionResponse
		if err := c.requestInto(
			ctx,
			"/Seat/Index/stepOutLatestComeBackTime?bookingId="+encoded+"&LAB_JSON=1",
			http.MethodPost, url.Values{}, nil, true, &latest,
		); err != nil {
			return ActionResult{}, err
		}
		if err := assertActionSuccess(&latest); err != nil {
			return ActionResult{}, err
		}
		var comeBack int64
		if latest.Data != nil {
			comeBack = int64(latest.Data.LatestComeBackTime)
		}
		if comeBack <= 0 {
			return ActionResult{}, LibraryError("暂离返回时间无效")
		}
		form := url.Values{}
		form.Set("comeBackTime", strconv.FormatInt(comeBack, 10))
		var resp ActionResponse
		if err := c.requestInto(
			ctx,
			"/Seat/Index/stepOut?bookingId="+encoded+"&LAB_JSON=1",
			http.MethodPost, form, nil, true, &resp,
		); err != nil {
			return ActionResult{}, err
		}
		if err := assertActionSuccess(&resp); err != nil {
			return ActionResult{}, err
		}
		return ActionResult{OK: true, Result: resp.Result(), Message: resp.ErrorMessage("")}, nil
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
		return ActionResult{}, LibraryError("不支持的操作类型")
	}
	var resp ActionResponse
	if err := c.requestInto(
		ctx,
		endpoint+"?bookingId="+encoded+"&LAB_JSON=1",
		http.MethodPost, url.Values{}, nil, true, &resp,
	); err != nil {
		return ActionResult{}, err
	}
	if err := assertActionSuccess(&resp); err != nil {
		return ActionResult{}, err
	}
	return ActionResult{OK: true, Result: resp.Result(), Message: resp.ErrorMessage("")}, nil
}

func assertActionSuccess(resp *ActionResponse) error {
	if resp.IsOK() && (resp.Result() == "" || strings.EqualFold(resp.Result(), "success")) {
		return nil
	}
	return LibraryError(resp.ErrorMessage("馆方操作失败"))
}

// BookingFromRaw maps a strongly-typed RawBooking into the frontend DTO, returning nil for historical states.
func BookingFromRaw(item RawBooking, now time.Time) *core.Booking {
	status := strings.TrimSpace(item.Status.String())
	switch status {
	case "3", "4", "5", "6", "7", "9":
		return nil
	}
	begin := int64(item.Time)
	if begin <= 0 {
		begin = now.Unix()
	}
	duration := int64(item.Duration)
	limitAgo := int64(item.LimitSignAgo)
	limitBack := int64(item.LimitSignBack)
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

	roomName := strings.TrimSpace(item.RoomName.String())
	if roomName == "" {
		roomName = "未知房间"
	}
	seatNum := strings.TrimSpace(item.SeatNum.String())
	if seatNum == "" {
		seatNum = "-"
	}
	var hours int64
	if duration > 0 {
		hours = duration / 3600
	}

	return &core.Booking{
		BookingID:    strings.TrimSpace(item.ID.String()),
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
