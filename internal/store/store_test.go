package store

import (
	"slices"
	"testing"

	"hdu-library-sniper/internal/core"
)

func TestStorePlansSessionCheckInsAndAudit(t *testing.T) {
	s, err := OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	p1 := &core.BookingPlan{
		ID:   "p1",
		Name: "早八自习",
		Slots: []core.PlanSlot{
			{
				ID:            "s1",
				RoomType:      "自习室",
				RoomQuery:     "q=1",
				FloorID:       3,
				FloorName:     "三楼",
				SeatNum:       "101",
				FallbackSeats: []string{"102"},
				StartHour:     8,
				DurationHours: 4,
			},
		},
		Weekdays:  []int{1, 2, 3},
		Enabled:   true,
		CreatedAt: "2026-01-01T00:00:00.000Z",
		UpdatedAt: "2026-01-01T00:00:00.000Z",
	}
	if err := s.SavePlan(p1); err != nil {
		t.Fatal(err)
	}
	p2 := &core.BookingPlan{
		ID:   "p2",
		Name: "全天双时段",
		Slots: []core.PlanSlot{
			{ID: "s2a", RoomType: "自习室", RoomQuery: "q=1", FloorID: 3, SeatNum: "101", StartHour: 8, DurationHours: 4},
			{ID: "s2b", RoomType: "自习室", RoomQuery: "q=1", FloorID: 3, SeatNum: "102", StartHour: 13, DurationHours: 4},
		},
		Weekdays:  []int{1, 2, 3},
		Enabled:   false,
		CreatedAt: "2026-01-01T00:00:01.000Z",
		UpdatedAt: "2026-01-01T00:00:01.000Z",
	}
	if err := s.SavePlan(p2); err != nil {
		t.Fatal(err)
	}

	disabled, err := s.SetOnlyEnabled("p2", true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(disabled, []string{"p1"}) {
		t.Fatalf("expected p1 disabled, got %v", disabled)
	}

	plans, err := s.ListPlans()
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 2 || len(plans[1].Slots) != 2 {
		t.Fatalf("expected 2 plans with 2 slots on p2, got %+v", plans)
	}
	enabled, err := s.EnabledPlan()
	if err != nil || enabled == nil || enabled.ID != "p2" {
		t.Fatalf("EnabledPlan = %+v, %v", enabled, err)
	}

	// Persistent pending check-in round-trip
	if err := s.UpsertPendingCheckIn(core.PendingCheckIn{
		BookingID: "b1", BeginMs: 1000, DeadlineMs: 2000, Attempts: 1, NextAtMs: 1500,
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := s.ListPendingCheckIns()
	if err != nil || len(pending) != 1 || pending[0].BookingID != "b1" {
		t.Fatalf("ListPendingCheckIns = %+v, %v", pending, err)
	}

	// Explicit catalog cache round-trip
	if err := s.SetCatalogCache("room_types", `[{"id":"1"}]`, 12345); err != nil {
		t.Fatal(err)
	}
	payload, fetchedAt, ok, err := s.GetCatalogCache("room_types")
	if err != nil || !ok || fetchedAt != 12345 || payload == "" {
		t.Fatalf("GetCatalogCache = %q %d %v %v", payload, fetchedAt, ok, err)
	}

	rec := &SessionRecord{
		UID:               "u1",
		Name:              "张三",
		Cookies:           `[{"name":"a","value":"b","domain":"hdu.huitu.zhishulib.com","path":"/"}]`,
		CredentialsEnc:    "ciphertext",
		CredentialsScheme: "aes256gcm-file",
		UpdatedAt:         "2026-01-01T00:00:00.000Z",
	}
	if err := s.SaveSession(rec); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.LoadSession()
	if err != nil || loaded == nil || loaded.UID != "u1" || loaded.CredentialsEnc != "ciphertext" {
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
