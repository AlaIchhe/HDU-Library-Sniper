package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/core"
)

func (s *Server) handleListPlans(w http.ResponseWriter, r *http.Request) {
	plans, err := s.Store.ListPlans()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.PlansListResponse{Plans: core.NonNil(plans)})
}

func (s *Server) handleGetPlan(w http.ResponseWriter, r *http.Request) {
	plan, err := s.Store.GetPlan(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if plan == nil {
		writeError(w, http.StatusNotFound, "方案不存在")
		return
	}
	writeJSON(w, http.StatusOK, api.PlanResponse{Plan: *plan})
}

func (s *Server) handleCreatePlan(w http.ResponseWriter, r *http.Request) {
	var in api.PlanUpsertRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	now := core.FormatISO(time.Now())
	plan := core.BookingPlan{
		ID:        core.NewUUID(),
		Slots:     []core.PlanSlot{},
		Weekdays:  []int{1, 2, 3, 4, 5, 6, 7},
		CreatedAt: now,
		UpdatedAt: now,
	}
	applyPlanPatch(&plan, &in)
	core.NormalizePlan(&plan)
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
	s.publishInvalidate(api.InvalidatePlans, api.InvalidateNextTarget)
	writeJSON(w, http.StatusCreated, api.PlanResponse{Plan: plan})
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
	var in api.PlanUpsertRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	updated := *cur
	applyPlanPatch(&updated, &in)
	updated.UpdatedAt = core.FormatISO(time.Now())
	core.NormalizePlan(&updated)
	if errs := core.ValidatePlan(&updated); len(errs) > 0 {
		writeError(w, http.StatusBadRequest, strings.Join(errs, "；"))
		return
	}
	if err := s.Store.SavePlan(&updated); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if updated.Enabled && !cur.Enabled {
		_, _ = s.Store.SetOnlyEnabled(updated.ID, true)
	}
	s.publishInvalidate(api.InvalidatePlans, api.InvalidateNextTarget)
	writeJSON(w, http.StatusOK, api.PlanResponse{Plan: updated})
}

func (s *Server) handleDeletePlan(w http.ResponseWriter, r *http.Request) {
	ok, err := s.Store.DeletePlan(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "方案不存在")
		return
	}
	s.publishInvalidate(api.InvalidatePlans, api.InvalidateNextTarget)
	writeJSON(w, http.StatusOK, api.SuccessResponse{Success: true})
}

func (s *Server) handleTogglePlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	action := api.PlanToggleAction(r.PathValue("action"))
	if action != api.PlanActionEnable && action != api.PlanActionDisable {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	plan, err := s.Store.GetPlan(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if plan == nil {
		writeError(w, http.StatusNotFound, "方案不存在")
		return
	}
	enable := action == api.PlanActionEnable
	disabled, err := s.Store.SetOnlyEnabled(id, enable)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	updated, err := s.Store.GetPlan(id)
	if err != nil || updated == nil {
		writeError(w, http.StatusInternalServerError, "方案读取失败")
		return
	}
	s.publishInvalidate(api.InvalidatePlans, api.InvalidateNextTarget)
	writeJSON(w, http.StatusOK, api.TogglePlanResponse{
		Plan:            *updated,
		DisabledPlanIDs: core.NonNil(disabled),
	})
}

func applyPlanPatch(dst *core.BookingPlan, in *api.PlanUpsertRequest) {
	if in.Name != nil {
		dst.Name = strings.TrimSpace(*in.Name)
	}
	if in.Slots != nil {
		slots := make([]core.PlanSlot, 0, len(in.Slots))
		for _, s := range in.Slots {
			slots = append(slots, core.PlanSlot{
				ID:            strings.TrimSpace(s.ID),
				RoomType:      strings.TrimSpace(s.RoomType),
				RoomQuery:     strings.TrimSpace(s.RoomQuery),
				FloorID:       s.FloorID,
				FloorName:     strings.TrimSpace(s.FloorName),
				SeatNum:       strings.TrimSpace(s.SeatNum),
				FallbackSeats: core.NonNil(s.FallbackSeats),
				StartHour:     s.StartHour,
				DurationHours: s.DurationHours,
			})
		}
		dst.Slots = slots
	}
	if in.Weekdays != nil {
		dst.Weekdays = core.ValidWeekdays(in.Weekdays)
	}
	if in.Enabled != nil {
		dst.Enabled = *in.Enabled
	}
}
