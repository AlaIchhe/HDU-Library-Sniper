package booking

import (
	"slices"
	"sort"
	"strings"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

func planMembers(item core.PlanListItem) (id, kind string, members []core.BookingPlan) {
	if item.Single != nil {
		return item.Single.ID, core.PlanKindSingle, []core.BookingPlan{*item.Single}
	}
	if item.Group != nil {
		m := make([]core.BookingPlan, len(item.Group.Members))
		copy(m, item.Group.Members)
		sort.SliceStable(m, func(i, j int) bool {
			return m[i].StartHour < m[j].StartHour
		})
		return item.Group.ID, core.PlanKindGroup, m
	}
	return "", "", nil
}

// MemberBegin computes the target reservation start timestamp in UTC, or false if excluded by weekdays.
func MemberBegin(plan *core.BookingPlan, now time.Time) (time.Time, bool) {
	localNow := now.In(core.Shanghai)
	offset := core.BookingDayOffsetFor(plan.RoomType)
	target := localNow.AddDate(0, 0, offset)
	weekday := int(target.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	if !slices.Contains(plan.Weekdays, weekday) {
		return time.Time{}, false
	}
	hour := int(max(0, min(23, plan.StartHour)))
	local := time.Date(target.Year(), target.Month(), target.Day(), hour, 0, 0, 0, core.Shanghai)
	return local.UTC(), true
}

func findFloorPOIs(floors []map[string]any, floorID int64) ([]any, bool) {
	for _, floor := range floors {
		if core.GetInt64(floor, "seatMap", "info", "id") == floorID {
			return core.AsSlice(core.Get(floor, "seatMap", "POIs")), true
		}
	}
	return nil, false
}

func seatIDFromFloors(floors []map[string]any, plan *core.BookingPlan, seatNum string) (string, bool) {
	pois, ok := findFloorPOIs(floors, plan.FloorID)
	if !ok {
		return "", false
	}
	for _, raw := range pois {
		seat := core.AsMap(raw)
		if seat == nil {
			continue
		}
		if strings.TrimSpace(core.ToString(seat["title"])) == seatNum {
			id := core.ToString(seat["id"])
			if id != "" {
				return id, true
			}
		}
	}
	return "", false
}

func seatIsFree(floors []map[string]any, plan *core.BookingPlan, seatNum string) bool {
	pois, ok := findFloorPOIs(floors, plan.FloorID)
	if !ok {
		return false
	}
	for _, raw := range pois {
		seat := core.AsMap(raw)
		if seat == nil {
			continue
		}
		if strings.TrimSpace(core.ToString(seat["title"])) == seatNum {
			return core.ToString(seat["state"]) == "0"
		}
	}
	return false
}

func responseMessage(resp map[string]any) string {
	msg := core.GetString(resp, "DATA", "msg")
	if msg == "" {
		msg = core.ToString(resp["MESSAGE"])
	}
	return msg
}

func bookingSucceeded(resp map[string]any) bool {
	if !strings.EqualFold(core.ToString(resp["CODE"]), "ok") {
		return false
	}
	res := core.GetString(resp, "DATA", "result")
	if strings.EqualFold(res, "success") {
		return true
	}
	return strings.Contains(core.GetString(resp, "DATA", "msg"), "成功")
}

func lockAccepted(resp map[string]any) bool {
	return strings.EqualFold(core.ToString(resp["CODE"]), "ok")
}

func lockEffective(resp map[string]any) bool {
	return lockAccepted(resp) && strings.EqualFold(core.GetString(resp, "DATA", "result"), "success")
}

func classifyFailure(msg string) string {
	switch {
	case strings.Contains(msg, "请求过于频繁") || strings.Contains(msg, "非手机端请求过于频繁"):
		return "ban"
	case strings.Contains(msg, "请求太频繁了"):
		return "throttle"
	case strings.Contains(msg, "订座流程异常"):
		return "flow"
	default:
		return ""
	}
}

func isDuplicateMessage(msg string) bool {
	return strings.Contains(msg, "已有预约") || strings.Contains(msg, "请勿重复") || strings.Contains(msg, "重复预约")
}

func isSeatQueryBlocked(err error) bool {
	return hdu.HTTPStatus(err) == 404 || hdu.IsRequestTimeout(err)
}

func isSeatUnavailableMessage(msg string) bool {
	return strings.Contains(msg, "座位无法预约") ||
		strings.Contains(msg, "已经被其他人锁定") ||
		strings.Contains(msg, "座位不可用") ||
		strings.Contains(msg, "已被占用")
}
