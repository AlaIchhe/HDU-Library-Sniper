package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"hdu-library-sniper/internal/core"
)

type planInput struct {
	RoomType      *string  `json:"roomType"`
	RoomQuery     *string  `json:"roomQuery"`
	FloorID       *int64   `json:"floorId"`
	FloorName     *string  `json:"floorName"`
	SeatNum       *string  `json:"seatNum"`
	FallbackSeats []string `json:"fallbackSeats"`
	StartHour     *int64   `json:"startHour"`
	DurationHours *int64   `json:"durationHours"`
	Weekdays      []int    `json:"weekdays"`
	Enabled       *bool    `json:"enabled"`
}

func (s *Server) handleListPlans(w http.ResponseWriter, r *http.Request) {
	items, err := s.Store.ListPlanItems()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plans": core.NonNil(items)})
}

func (s *Server) handleGetPlan(w http.ResponseWriter, r *http.Request) {
	item, err := s.Store.GetPlanItem(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if item == nil {
		writeError(w, http.StatusNotFound, "方案不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": item})
}

func (s *Server) handleCreatePlan(w http.ResponseWriter, r *http.Request) {
	var in planInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	now := core.FormatISO(time.Now())
	plan := core.BookingPlan{
		ID:            core.NewUUID(),
		Kind:          core.PlanKindSingle,
		FallbackSeats: []string{},
		Weekdays:      []int{1, 2, 3, 4, 5, 6, 7},
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	applyPlanPatch(&plan, &in)
	if errs := core.ValidatePlan(&plan); len(errs) > 0 {
		writeError(w, http.StatusBadRequest, strings.Join(errs, "；"))
		return
	}
	if err := s.Store.SavePlan(&plan); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if plan.Enabled {
		_, _ = s.Store.SetOnlyEnabled(plan.ID, true)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"plan": plan})
}

func (s *Server) handleUpdatePlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cur, err := s.Store.GetPlan(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if cur == nil {
		writeError(w, http.StatusNotFound, "方案不存在")
		return
	}
	var in planInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	updated := *cur
	applyPlanPatch(&updated, &in)
	updated.UpdatedAt = core.FormatISO(time.Now())
	if errs := core.ValidatePlan(&updated); len(errs) > 0 {
		writeError(w, http.StatusBadRequest, strings.Join(errs, "；"))
		return
	}
	if err := s.revalidateParentGroups(&updated); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.Store.SavePlan(&updated); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if updated.Enabled && !cur.Enabled {
		_, _ = s.Store.SetOnlyEnabled(updated.ID, true)
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": updated})
}

func (s *Server) handleDeletePlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	refs, err := s.Store.ReferencedPlanIDs(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(refs) > 0 {
		writeError(w, http.StatusConflict, "该方案正被组合方案引用，请先从组合中移除")
		return
	}
	ok, err := s.Store.DeletePlan(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "方案不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) handleTogglePlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	action := r.PathValue("action")
	if action != "enable" && action != "disable" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	item, err := s.Store.GetPlanItem(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if item == nil {
		writeError(w, http.StatusNotFound, "方案不存在")
		return
	}
	enabled := action == "enable"
	disabled, err := s.Store.SetOnlyEnabled(id, enabled)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	updated, _ := s.Store.GetPlanItem(id)
	writeJSON(w, http.StatusOK, map[string]any{
		"plan":            updated,
		"disabledPlanIds": core.NonNil(disabled),
	})
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name          string   `json:"name"`
		MemberPlanIDs []string `json:"memberPlanIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	members, weekdays, err := s.resolveAndValidateGroup(in.Name, in.MemberPlanIDs, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	now := core.FormatISO(time.Now())
	g := &core.BookingGroup{
		ID:            core.NewUUID(),
		Kind:          core.PlanKindGroup,
		Name:          strings.TrimSpace(in.Name),
		MemberPlanIDs: in.MemberPlanIDs,
		Members:       members,
		Weekdays:      weekdays,
		Enabled:       false,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.Store.SaveGroup(g); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"plan": g})
}

func (s *Server) handleGetGroup(w http.ResponseWriter, r *http.Request) {
	item, err := s.Store.GetPlanItem(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if item == nil || item.Group == nil {
		writeError(w, http.StatusNotFound, "组合方案不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": item.Group})
}

func (s *Server) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	item, err := s.Store.GetPlanItem(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if item == nil || item.Group == nil {
		writeError(w, http.StatusNotFound, "组合方案不存在")
		return
	}
	var in struct {
		Name          string   `json:"name"`
		MemberPlanIDs []string `json:"memberPlanIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	members, weekdays, err := s.resolveAndValidateGroup(in.Name, in.MemberPlanIDs, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	g := &core.BookingGroup{
		ID:            item.Group.ID,
		Kind:          core.PlanKindGroup,
		Name:          strings.TrimSpace(in.Name),
		MemberPlanIDs: in.MemberPlanIDs,
		Members:       members,
		Weekdays:      weekdays,
		Enabled:       item.Group.Enabled,
		CreatedAt:     item.Group.CreatedAt,
		UpdatedAt:     core.FormatISO(time.Now()),
	}
	if err := s.Store.SaveGroup(g); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": g})
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	ok, err := s.Store.DeleteGroup(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "组合方案不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) resolveAndValidateGroup(name string, memberIDs []string, override *core.BookingPlan) ([]core.BookingPlan, []int, error) {
	if strings.TrimSpace(name) == "" {
		return nil, nil, errors.New("组合名称不能为空")
	}
	if len(memberIDs) < 2 {
		return nil, nil, errors.New("至少选择两个方案")
	}
	seen := make(map[string]bool, len(memberIDs))
	members := make([]core.BookingPlan, 0, len(memberIDs))
	for _, mid := range memberIDs {
		if seen[mid] {
			return nil, nil, errors.New("不能重复添加同一方案")
		}
		seen[mid] = true
		var p *core.BookingPlan
		if override != nil && override.ID == mid {
			cp := *override
			p = &cp
		} else {
			loaded, err := s.Store.GetPlan(mid)
			if err != nil || loaded == nil {
				return nil, nil, errors.New("成员方案不存在")
			}
			p = loaded
		}
		members = append(members, *p)
	}
	baseDays := core.ValidWeekdays(members[0].Weekdays)
	for _, m := range members[1:] {
		if !slices.Equal(core.ValidWeekdays(m.Weekdays), baseDays) {
			return nil, nil, errors.New("组合成员的重复星期必须一致")
		}
	}
	sorted := make([]core.BookingPlan, len(members))
	copy(sorted, members)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].StartHour < sorted[j].StartHour
	})
	for i := 1; i < len(sorted); i++ {
		prev := sorted[i-1]
		if prev.StartHour+prev.DurationHours > sorted[i].StartHour {
			return nil, nil, errors.New("组合成员时间段不能重叠")
		}
	}
	return members, baseDays, nil
}

func (s *Server) revalidateParentGroups(updated *core.BookingPlan) error {
	groupIDs, err := s.Store.ReferencedPlanIDs(updated.ID)
	if err != nil {
		return err
	}
	for _, gid := range groupIDs {
		item, err := s.Store.GetPlanItem(gid)
		if err != nil || item == nil || item.Group == nil {
			continue
		}
		if _, _, err := s.resolveAndValidateGroup(item.Group.Name, item.Group.MemberPlanIDs, updated); err != nil {
			return err
		}
	}
	return nil
}

func applyPlanPatch(dst *core.BookingPlan, in *planInput) {
	if in.RoomType != nil {
		dst.RoomType = strings.TrimSpace(*in.RoomType)
	}
	if in.RoomQuery != nil {
		dst.RoomQuery = strings.TrimSpace(*in.RoomQuery)
	}
	if in.FloorID != nil {
		dst.FloorID = *in.FloorID
	}
	if in.FloorName != nil {
		dst.FloorName = strings.TrimSpace(*in.FloorName)
	}
	if in.SeatNum != nil {
		dst.SeatNum = strings.TrimSpace(*in.SeatNum)
	}
	if in.FallbackSeats != nil {
		cleaned := make([]string, 0, len(in.FallbackSeats))
		for _, s := range in.FallbackSeats {
			if t := strings.TrimSpace(s); t != "" {
				cleaned = append(cleaned, t)
			}
		}
		dst.FallbackSeats = cleaned
	}
	if in.StartHour != nil {
		dst.StartHour = *in.StartHour
	}
	if in.DurationHours != nil {
		dst.DurationHours = *in.DurationHours
	}
	if in.Weekdays != nil {
		dst.Weekdays = core.ValidWeekdays(in.Weekdays)
	}
	if in.Enabled != nil {
		dst.Enabled = *in.Enabled
	}
}
