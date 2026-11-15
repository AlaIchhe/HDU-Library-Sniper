package core

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"slices"
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

// ValidatePlan validates a single booking plan's required fields and ranges.
func ValidatePlan(p *BookingPlan) []string {
	var errs []string
	if strings.TrimSpace(p.RoomType) == "" {
		errs = append(errs, "房间类型不能为空")
	}
	if strings.TrimSpace(p.RoomQuery) == "" {
		errs = append(errs, "房间查询参数不能为空")
	}
	if p.FloorID <= 0 {
		errs = append(errs, "楼层无效")
	}
	if strings.TrimSpace(p.SeatNum) == "" {
		errs = append(errs, "座位号不能为空")
	}
	if p.StartHour < 0 || p.StartHour > 23 {
		errs = append(errs, "开始时间无效")
	}
	if p.DurationHours <= 0 {
		errs = append(errs, "时长无效")
	}
	if len(ValidWeekdays(p.Weekdays)) == 0 {
		errs = append(errs, "至少选择一个星期")
	}
	return errs
}
