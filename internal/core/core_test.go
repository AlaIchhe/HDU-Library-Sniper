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
		Name: "单时段",
		Slots: []PlanSlot{
			{
				RoomType:      "自习室",
				RoomQuery:     "x=1",
				FloorID:       1,
				SeatNum:       "101",
				StartHour:     8,
				DurationHours: 2,
			},
		},
		Weekdays: []int{},
	}
	if errs := ValidatePlan(&p); !slices.Contains(errs, "至少选择一个星期") {
		t.Fatalf("expected weekday validation error, got %v", errs)
	}
	p.Weekdays = []int{1}
	if errs := ValidatePlan(&p); len(errs) != 0 {
		t.Fatalf("unexpected validation errors: %v", errs)
	}

	// Overlapping multi-slot plan must fail validation.
	p.Name = "重叠方案"
	p.Slots = append(p.Slots, PlanSlot{
		RoomType:      "自习室",
		RoomQuery:     "x=1",
		FloorID:       1,
		SeatNum:       "102",
		StartHour:     9,
		DurationHours: 2,
	})
	if errs := ValidatePlan(&p); !slices.Contains(errs, "方案内各时段不能重叠") {
		t.Fatalf("expected overlap validation error, got %v", errs)
	}
}

func TestNextPlanAnchorRespectsWeekdays(t *testing.T) {
	// 2026-11-02 is Monday (ISO weekday 1) in Asia/Shanghai.
	// At 18:00 Monday, BookingDayOffset=2 targets Wednesday (ISO weekday 3).
	now := time.Date(2026, 11, 2, 18, 0, 0, 0, Shanghai)
	plan := &BookingPlan{
		ID:   "p1",
		Name: "周五专场",
		Slots: []PlanSlot{
			{RoomType: "主馆自习室", StartHour: 8, DurationHours: 4},
		},
		// Target day Friday (5) -> must book on Wednesday (2026-11-04) at 20:00!
		Weekdays: []int{5},
	}
	anchor, ok := NextPlanAnchor(now, plan)
	if !ok {
		t.Fatal("expected anchor")
	}
	want := time.Date(2026, 11, 4, 20, 0, 0, 0, Shanghai)
	if !anchor.Equal(want) {
		t.Fatalf("NextPlanAnchor = %v, want %v", anchor, want)
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

func TestTimeoutInvariants(t *testing.T) {
	if BookingPrelockLeadSeconds <= int64(WriteTimeout.Seconds()) {
		t.Fatalf("prelock lead %ds must exceed write timeout %v", BookingPrelockLeadSeconds, WriteTimeout)
	}
	if ReadTimeout >= WriteTimeout || ReadTimeout < 3*time.Second {
		t.Fatalf("expected 3s <= ReadTimeout (%v) < WriteTimeout (%v)", ReadTimeout, WriteTimeout)
	}
}
