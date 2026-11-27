package core

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"slices"
	"sort"
	"strings"
)

// NewUUID generates a random RFC 4122 v4 UUID string without external dependencies.
func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

// ValidWeekdays keeps ISO weekdays 1..7 sorted and deduplicated.
func ValidWeekdays(days []int) []int {
	out := make([]int, 0, len(days))
	for _, d := range days {
		if d >= 1 && d <= 7 && !slices.Contains(out, d) {
			out = append(out, d)
		}
	}
	slices.Sort(out)
	return out
}

// NormalizePlan trims text fields, assigns missing slot IDs, deduplicates weekdays, and defaults empty Name.
func NormalizePlan(p *BookingPlan) {
	p.Name = strings.TrimSpace(p.Name)
	p.Weekdays = ValidWeekdays(p.Weekdays)
	for i := range p.Slots {
		s := &p.Slots[i]
		if strings.TrimSpace(s.ID) == "" {
			s.ID = NewUUID()
		}
		s.RoomType = strings.TrimSpace(s.RoomType)
		s.RoomQuery = strings.TrimSpace(s.RoomQuery)
		s.FloorName = strings.TrimSpace(s.FloorName)
		s.SeatNum = strings.TrimSpace(s.SeatNum)
		cleaned := make([]string, 0, len(s.FallbackSeats))
		for _, fb := range s.FallbackSeats {
			if t := strings.TrimSpace(fb); t != "" {
				cleaned = append(cleaned, t)
			}
		}
		s.FallbackSeats = cleaned
	}
	if p.Name == "" && len(p.Slots) > 0 {
		p.Name = p.Slots[0].RoomType
	}
}

// ValidatePlan validates a unified booking plan's slots, non-overlapping time windows, and weekdays.
func ValidatePlan(p *BookingPlan) []string {
	var errs []string
	if len(p.Slots) == 0 {
		errs = append(errs, "至少添加一个预约时段")
	}
	if len(p.Slots) > 1 && strings.TrimSpace(p.Name) == "" {
		errs = append(errs, "多时段方案名称不能为空")
	}
	for i, s := range p.Slots {
		prefix := ""
		if len(p.Slots) > 1 {
			prefix = fmt.Sprintf("时段 %d：", i+1)
		}
		if strings.TrimSpace(s.RoomType) == "" {
			errs = append(errs, prefix+"房间类型不能为空")
		}
		if strings.TrimSpace(s.RoomQuery) == "" {
			errs = append(errs, prefix+"房间查询参数不能为空")
		}
		if s.FloorID <= 0 {
			errs = append(errs, prefix+"楼层无效")
		}
		if strings.TrimSpace(s.SeatNum) == "" {
			errs = append(errs, prefix+"座位号不能为空")
		}
		if s.StartHour < 0 || s.StartHour > 23 {
			errs = append(errs, prefix+"开始时间无效")
		}
		if s.DurationHours <= 0 {
			errs = append(errs, prefix+"时长无效")
		}
	}
	if len(p.Slots) > 1 {
		sorted := make([]PlanSlot, len(p.Slots))
		copy(sorted, p.Slots)
		sort.SliceStable(sorted, func(i, j int) bool {
			return sorted[i].StartHour < sorted[j].StartHour
		})
		for i := 1; i < len(sorted); i++ {
			prev := sorted[i-1]
			if prev.StartHour+prev.DurationHours > sorted[i].StartHour {
				errs = append(errs, "方案内各时段不能重叠")
				break
			}
		}
	}
	if len(ValidWeekdays(p.Weekdays)) == 0 {
		errs = append(errs, "至少选择一个星期")
	}
	return errs
}
