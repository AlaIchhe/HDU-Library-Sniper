package core

import (
	"slices"
	"strings"
	"time"
	_ "time/tzdata"
)

const (
	BookingAnchorHour         = 20
	BookingPrelockLeadSeconds = 60
	BookingDayOffset          = 2
	WriteTimeout              = 30 * time.Second
	ReadTimeout               = 5 * time.Second
)

// Clock abstracts wall-clock reads for deterministic testing across scheduler and booking components.
type Clock interface {
	Now() time.Time
}

// RealClock returns the current system time.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

// Shanghai is the HDU campus timezone embedded via time/tzdata for scratch/Windows safety.
var Shanghai = mustLoadShanghai()

func mustLoadShanghai() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("Asia/Shanghai", 8*3600)
	}
	return loc
}

// BookingDayOffsetFor returns 1 for living-area study rooms (one-day ahead) and 2 otherwise.
func BookingDayOffsetFor(roomType string) int {
	if strings.Contains(roomType, "生活区") {
		return 1
	}
	return BookingDayOffset
}

func ISOWeekday(t time.Time) int {
	wd := int(t.Weekday())
	if wd == 0 {
		return 7
	}
	return wd
}

// NextPlanAnchor finds the next 20:00 Shanghai timestamp when at least one slot of plan will run.
func NextPlanAnchor(now time.Time, plan *BookingPlan) (time.Time, bool) {
	if plan == nil || len(plan.Slots) == 0 || len(plan.Weekdays) == 0 {
		return time.Time{}, false
	}
	localNow := now.In(Shanghai)
	todayAnchor := time.Date(
		localNow.Year(), localNow.Month(), localNow.Day(),
		BookingAnchorHour, 0, 0, 0, Shanghai,
	)
	startDay := 0
	if !localNow.Before(todayAnchor) {
		startDay = 1
	}
	for d := startDay; d < startDay+7; d++ {
		candidate := todayAnchor.AddDate(0, 0, d)
		for i := range plan.Slots {
			targetDay := candidate.AddDate(0, 0, BookingDayOffsetFor(plan.Slots[i].RoomType))
			if slices.Contains(plan.Weekdays, ISOWeekday(targetDay)) {
				return candidate, true
			}
		}
	}
	return time.Time{}, false
}

func ShanghaiSecondsOfDay(now time.Time) int64 {
	t := now.In(Shanghai)
	return int64(t.Hour()*3600 + t.Minute()*60 + t.Second())
}

func BookingAnchorDelaySeconds(secondsOfDay int64) int64 {
	anchor := int64(BookingAnchorHour * 3600)
	if secondsOfDay < anchor {
		return anchor - secondsOfDay
	}
	return 86400 - secondsOfDay + anchor
}

func BookingPrelockDelaySeconds(secondsOfDay, leadSeconds int64) int64 {
	prelock := int64(BookingAnchorHour*3600) - leadSeconds
	anchor := int64(BookingAnchorHour * 3600)
	if secondsOfDay < prelock {
		return prelock - secondsOfDay
	}
	if secondsOfDay < anchor {
		return 0
	}
	return 86400 - secondsOfDay + prelock
}

func FormatZh(t time.Time) string {
	return t.In(Shanghai).Format("2006/1/2 15:04:05")
}

func FormatZhUnix(seconds int64) string {
	return FormatZh(time.Unix(seconds, 0))
}

func FormatISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func FormatISOMillis(ms int64) string {
	return FormatISO(time.UnixMilli(ms))
}

func NonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
