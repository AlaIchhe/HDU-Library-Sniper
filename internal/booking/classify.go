package booking

import (
	"slices"
	"sort"
	"strings"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

func sortedSlots(plan *core.BookingPlan) []core.PlanSlot {
	slots := make([]core.PlanSlot, len(plan.Slots))
	copy(slots, plan.Slots)
	sort.SliceStable(slots, func(i, j int) bool {
		return slots[i].StartHour < slots[j].StartHour
	})
	return slots
}

// SlotBegin computes the target reservation start timestamp in UTC, or false if excluded by weekdays.
func SlotBegin(slot *core.PlanSlot, weekdays []int, now time.Time) (time.Time, bool) {
	localNow := now.In(core.Shanghai)
	offset := core.BookingDayOffsetFor(slot.RoomType)
	target := localNow.AddDate(0, 0, offset)
	if !slices.Contains(weekdays, core.ISOWeekday(target)) {
		return time.Time{}, false
	}
	hour := int(max(0, min(23, slot.StartHour)))
	local := time.Date(target.Year(), target.Month(), target.Day(), hour, 0, 0, 0, core.Shanghai)
	return local.UTC(), true
}

func findFloor(floors []hdu.FloorNode, floorID int64) (hdu.FloorNode, bool) {
	for _, f := range floors {
		if f.FloorID() == floorID {
			return f, true
		}
	}
	return hdu.FloorNode{}, false
}

func seatIDFromFloors(floors []hdu.FloorNode, floorID int64, seatNum string) (string, bool) {
	f, ok := findFloor(floors, floorID)
	if !ok {
		return "", false
	}
	return f.SeatID(seatNum)
}

func seatIsFree(floors []hdu.FloorNode, floorID int64, seatNum string) bool {
	f, ok := findFloor(floors, floorID)
	if !ok {
		return false
	}
	return f.SeatIsFree(seatNum)
}

func lockEffective(res hdu.ActionResult) bool {
	return res.OK && strings.EqualFold(res.Result, "success")
}
