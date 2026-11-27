package hdu

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// FlexString unmarshals a JSON string, number, or bool into a trimmed string.
type FlexString string

func (s *FlexString) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		*s = ""
		return nil
	}
	if data[0] == '"' {
		var str string
		if err := json.Unmarshal(data, &str); err != nil {
			return err
		}
		*s = FlexString(str)
		return nil
	}
	*s = FlexString(string(data))
	return nil
}

func (s FlexString) String() string { return string(s) }

// FlexInt64 unmarshals a JSON integer, float, or numeric string into int64.
type FlexInt64 int64

func (n *FlexInt64) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		*n = 0
		return nil
	}
	if data[0] == '"' {
		var str string
		if err := json.Unmarshal(data, &str); err != nil {
			return nil
		}
		str = strings.TrimSpace(str)
		if i, err := strconv.ParseInt(str, 10, 64); err == nil {
			*n = FlexInt64(i)
			return nil
		}
		if f, err := strconv.ParseFloat(str, 64); err == nil {
			*n = FlexInt64(int64(f))
		}
		return nil
	}
	if i, err := strconv.ParseInt(string(data), 10, 64); err == nil {
		*n = FlexInt64(i)
		return nil
	}
	if f, err := strconv.ParseFloat(string(data), 64); err == nil {
		*n = FlexInt64(int64(f))
	}
	return nil
}

// FlexBool unmarshals a JSON bool, number, or "true"/"1" string into bool.
type FlexBool bool

func (b *FlexBool) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		*b = false
		return nil
	}
	if data[0] == '"' {
		var str string
		if err := json.Unmarshal(data, &str); err != nil {
			return nil
		}
		str = strings.TrimSpace(str)
		*b = FlexBool(strings.EqualFold(str, "true") || str == "1")
		return nil
	}
	if bytes.Equal(data, []byte("true")) {
		*b = true
		return nil
	}
	if bytes.Equal(data, []byte("false")) {
		*b = false
		return nil
	}
	if f, err := strconv.ParseFloat(string(data), 64); err == nil {
		*b = FlexBool(f != 0)
	}
	return nil
}

// RedirectEnvelope detects HDU's com.Redirect JSON auth-expired responses.
type RedirectEnvelope struct {
	UIType FlexString `json:"ui_type"`
	Href   FlexString `json:"href"`
}

// BaseInfoResponse models /User/Center/baseInfo.
type BaseInfoResponse struct {
	Data *struct {
		IsLogin  FlexBool   `json:"is_login"`
		UID      FlexString `json:"uid"`
		UserInfo *struct {
			Name FlexString `json:"name"`
		} `json:"user_info"`
	} `json:"DATA"`
}

// ActionResponse models HDU write/action JSON envelopes (bookSeats, lockSeats, checkIn, etc.).
type ActionResponse struct {
	Code    FlexString `json:"CODE"`
	Message FlexString `json:"MESSAGE"`
	Data    *struct {
		Result             FlexString `json:"result"`
		Msg                FlexString `json:"msg"`
		LatestComeBackTime FlexInt64  `json:"latest_come_back_time"`
	} `json:"DATA"`
}

func (r *ActionResponse) ErrorMessage(fallback string) string {
	if r == nil {
		return fallback
	}
	msg := ""
	if r.Data != nil {
		msg = strings.TrimSpace(r.Data.Msg.String())
	}
	if msg == "" {
		msg = strings.TrimSpace(r.Message.String())
	}
	if msg == "" || strings.EqualFold(msg, "ok") || strings.EqualFold(msg, "success") {
		return fallback
	}
	return msg
}

func (r *ActionResponse) IsOK() bool {
	return r != nil && strings.EqualFold(strings.TrimSpace(r.Code.String()), "ok")
}

func (r *ActionResponse) Result() string {
	if r == nil || r.Data == nil {
		return ""
	}
	return strings.TrimSpace(r.Data.Result.String())
}

// ActionResult is the typed outcome of a book/lock/action call.
type ActionResult struct {
	OK      bool
	Result  string
	Message string
}

// RawBooking is a strongly-typed entry from /Seat/Index/myBookingList.
type RawBooking struct {
	ID            FlexString `json:"id"`
	RoomName      FlexString `json:"roomName"`
	SeatNum       FlexString `json:"seatNum"`
	Time          FlexInt64  `json:"time"`
	Duration      FlexInt64  `json:"duration"`
	Status        FlexString `json:"status"`
	LimitSignAgo  FlexInt64  `json:"limitSignAgo"`
	LimitSignBack FlexInt64  `json:"limitSignBack"`
}

type bookingListEnvelope struct {
	Content *struct {
		DefaultItems []RawBooking `json:"defaultItems"`
	} `json:"content"`
}

// SeatPOI represents one seat in a floor's seatMap.POIs.
type SeatPOI struct {
	ID    FlexString `json:"id"`
	Title FlexString `json:"title"`
	State FlexString `json:"state"`
}

// FloorInfo holds floor metadata inside seatMap.info.
type FloorInfo struct {
	ID    FlexInt64  `json:"id"`
	Title FlexString `json:"title"`
	Name  FlexString `json:"name"`
}

// FloorNode is a strongly-typed floor node returned by /Seat/Index/searchSeats.
type FloorNode struct {
	RoomName FlexString `json:"roomName"`
	SeatMap  *struct {
		Info *FloorInfo `json:"info"`
		POIs []SeatPOI  `json:"POIs"`
	} `json:"seatMap"`
}

// SeatID finds the seat ID matching title on this floor.
func (f FloorNode) SeatID(seatNum string) (string, bool) {
	if f.SeatMap == nil {
		return "", false
	}
	for _, seat := range f.SeatMap.POIs {
		if strings.TrimSpace(seat.Title.String()) == seatNum {
			if id := strings.TrimSpace(seat.ID.String()); id != "" {
				return id, true
			}
		}
	}
	return "", false
}

// SeatIsFree reports whether the named seat on this floor currently has state == "0".
func (f FloorNode) SeatIsFree(seatNum string) bool {
	if f.SeatMap == nil {
		return false
	}
	for _, seat := range f.SeatMap.POIs {
		if strings.TrimSpace(seat.Title.String()) == seatNum {
			return strings.TrimSpace(seat.State.String()) == "0"
		}
	}
	return false
}

// FloorID returns seatMap.info.id or 0.
func (f FloorNode) FloorID() int64 {
	if f.SeatMap == nil || f.SeatMap.Info == nil {
		return 0
	}
	return int64(f.SeatMap.Info.ID)
}
