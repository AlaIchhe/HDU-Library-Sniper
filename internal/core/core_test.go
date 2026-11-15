package core

import (
	"slices"
	"testing"
	"time"
)

func TestValidWeekdaysAndValidatePlan(t *testing.T) {
	got := ValidWeekdays([]int{7, 3, 3, 9, 0, 1})
	if !slices.Equal(got, []int{1, 3, 7}) {
		t.Fatalf("ValidWeekdays = %v", got)
	}

	p := BookingPlan{
		RoomType:      "自习室",
		RoomQuery:     "x=1",
		FloorID:       1,
		SeatNum:       "101",
		StartHour:     8,
		DurationHours: 2,
		Weekdays:      []int{},
	}
	if errs := ValidatePlan(&p); !slices.Contains(errs, "至少选择一个星期") {
		t.Fatalf("expected weekday validation error, got %v", errs)
	}
	p.Weekdays = []int{1}
	if errs := ValidatePlan(&p); len(errs) != 0 {
		t.Fatalf("unexpected validation errors: %v", errs)
	}
}

func TestTimeHelpers(t *testing.T) {
	if BookingDayOffsetFor("生活区自习室") != 1 {
		t.Fatal("expected living area offset 1")
	}
	if BookingDayOffsetFor("主馆自习室") != 2 {
		t.Fatal("expected main library offset 2")
	}
	ts := time.Date(2026, 11, 6, 6, 13, 20, 0, Shanghai)
	if got := FormatZh(ts); got != "2026/11/6 06:13:20" {
		t.Fatalf("FormatZh = %q", got)
	}
	if got := BookingPrelockDelaySeconds(19*3600+58*60, 60); got != 60 {
		t.Fatalf("prelock before 19:59 = %d", got)
	}
	if got := BookingPrelockDelaySeconds(19*3600+59*60+30, 60); got != 0 {
		t.Fatalf("prelock at 19:59:30 = %d", got)
	}
	if got := BookingAnchorDelaySeconds(20*3600 + 1); got != 86399 {
		t.Fatalf("anchor after 20:00 = %d", got)
	}
}
