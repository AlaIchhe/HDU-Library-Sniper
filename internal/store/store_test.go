package store

import (
	"slices"
	"testing"

	"hdu-library-sniper/internal/core"
)

func TestStorePlansGroupsSessionAudit(t *testing.T) {
	s, err := OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	p1 := &core.BookingPlan{
		ID:            "p1",
		Kind:          core.PlanKindSingle,
		RoomType:      "自习室",
		RoomQuery:     "q=1",
		FloorID:       3,
		FloorName:     "三楼",
		SeatNum:       "101",
		FallbackSeats: []string{"102"},
		StartHour:     8,
		DurationHours: 4,
		Weekdays:      []int{1, 2, 3},
		Enabled:       true,
		CreatedAt:     "2026-01-01T00:00:00.000Z",
		UpdatedAt:     "2026-01-01T00:00:00.000Z",
	}
	if err := s.SavePlan(p1); err != nil {
		t.Fatal(err)
	}
	p2 := *p1
	p2.ID = "p2"
	p2.StartHour = 12
	p2.Enabled = false
	if err := s.SavePlan(&p2); err != nil {
		t.Fatal(err)
	}

	g := &core.BookingGroup{
		ID:            "g1",
		Kind:          core.PlanKindGroup,
		Name:          "全天",
		MemberPlanIDs: []string{"p1", "p2"},
		Weekdays:      []int{1, 2, 3},
		Enabled:       true,
		CreatedAt:     "2026-01-01T00:00:01.000Z",
		UpdatedAt:     "2026-01-01T00:00:01.000Z",
	}
	if err := s.SaveGroup(g); err != nil {
		t.Fatal(err)
	}
	disabled, err := s.SetOnlyEnabled("g1", true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(disabled, []string{"p1"}) {
		t.Fatalf("expected p1 disabled, got %v", disabled)
	}

	items, err := s.ListPlanItems()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("expected 3 items, got %d", len(items))
	}
	refs, err := s.ReferencedPlanIDs("p1")
	if err != nil || !slices.Equal(refs, []string{"g1"}) {
		t.Fatalf("ReferencedPlanIDs = %v, %v", refs, err)
	}

	rec := &SessionRecord{
		UID:       "u1",
		Name:      "张三",
		Cookies:   `[{"name":"a","value":"b","domain":"hdu.huitu.zhishulib.com","path":"/"}]`,
		UpdatedAt: "2026-01-01T00:00:00.000Z",
	}
	if err := s.SaveSession(rec); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.LoadSession()
	if err != nil || loaded == nil || loaded.UID != "u1" {
		t.Fatalf("LoadSession = %+v, %v", loaded, err)
	}
	if err := s.WriteAudit("booking_run_finished", map[string]any{"success": true}); err != nil {
		t.Fatal(err)
	}
	audits, err := s.ListAudit(10)
	if err != nil || len(audits) != 1 || audits[0].Event != "booking_run_finished" {
		t.Fatalf("ListAudit = %+v, %v", audits, err)
	}
}
