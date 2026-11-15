package core

import (
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
