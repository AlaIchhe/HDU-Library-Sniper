package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/events"
)

// sseHeartbeatInterval keeps proxies from closing an idle stream. It is a var so
// tests can shorten it instead of waiting out a 25 second tick.
var sseHeartbeatInterval = 25 * time.Second

func (s *Server) publishInvalidate(targets ...api.InvalidateTarget) {
	if s.Events == nil || len(targets) == 0 {
		return
	}
	s.Events.Publish(events.TopicAppEvent, api.AppEvent{
		Kind:       api.AppEventInvalidate,
		Invalidate: targets,
	})
}

func prepareSSE(w http.ResponseWriter) *http.ResponseController {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	return http.NewResponseController(w)
}

func writeSSEComment(w http.ResponseWriter, rc *http.ResponseController, comment string) error {
	if _, err := fmt.Fprintf(w, ": %s\n\n", comment); err != nil {
		return err
	}
	_ = rc.Flush()
	return nil
}

func writeSSEEvent(w http.ResponseWriter, rc *http.ResponseController, event string, data []byte) error {
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data); err != nil {
		return err
	}
	_ = rc.Flush()
	return nil
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if s.Events == nil {
		writeError(w, http.StatusServiceUnavailable, "events unavailable")
		return
	}
	ch, unsub := s.Events.Subscribe(events.TopicAppEvent)
	defer unsub()

	rc := prepareSSE(w)
	if err := writeSSEComment(w, rc, "connected"); err != nil {
		return
	}

	if s.Auth != nil {
		sess := s.Auth.Status()
		if raw, err := json.Marshal(api.AppEvent{Kind: api.AppEventSession, Session: &sess}); err == nil {
			if err := writeSSEEvent(w, rc, events.TopicAppEvent, raw); err != nil {
				return
			}
		}
		if !sess.Authenticated {
			return
		}
	}
	if s.Scheduler != nil {
		rt := s.Scheduler.Status()
		if raw, err := json.Marshal(api.AppEvent{Kind: api.AppEventRuntime, Runtime: &rt}); err == nil {
			if err := writeSSEEvent(w, rc, events.TopicAppEvent, raw); err != nil {
				return
			}
		}
	}

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.Events.Done():
			return
		case <-ticker.C:
			if err := writeSSEComment(w, rc, "keepalive"); err != nil {
				return
			}
		case msg := <-ch:
			if err := writeSSEEvent(w, rc, events.TopicAppEvent, msg.RawJSON); err != nil {
				return
			}
			if ev, ok := msg.Payload.(api.AppEvent); ok && ev.Kind == api.AppEventSession && ev.Session != nil && !ev.Session.Authenticated {
				return
			}
		}
	}
}

func (s *Server) handleSessionQREvents(w http.ResponseWriter, r *http.Request) {
	uuid := r.PathValue("uuid")
	var ch <-chan events.Message
	var done <-chan struct{}
	if s.Events != nil {
		var unsub func()
		ch, unsub = s.Events.Subscribe(events.TopicQrStatus)
		defer unsub()
		done = s.Events.Done()
	}
	endWatch := s.Auth.BeginQrWatch(uuid)
	defer endWatch()

	rc := prepareSSE(w)
	initial := s.Auth.QrStatus(uuid)
	initialPayload := api.QrStatusEvent{
		UUID:    uuid,
		Status:  api.QrLoginPhase(initial.Status),
		Message: initial.Message,
		Session: initial.Session,
	}
	raw, err := json.Marshal(initialPayload)
	if err != nil {
		return
	}
	if err := writeSSEEvent(w, rc, events.TopicQrStatus, raw); err != nil {
		return
	}
	if initialPayload.Status != api.QrLoginPending || ch == nil {
		return
	}

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-done:
			return
		case <-ticker.C:
			if err := writeSSEComment(w, rc, "keepalive"); err != nil {
				return
			}
		case msg := <-ch:
			// The bus filters by topic; the uuid scopes us to this browser tab's QR session.
			ev, ok := msg.Payload.(api.QrStatusEvent)
			if !ok {
				if err := json.Unmarshal(msg.RawJSON, &ev); err != nil {
					continue
				}
			}
			if ev.UUID != uuid {
				continue
			}
			if err := writeSSEEvent(w, rc, events.TopicQrStatus, msg.RawJSON); err != nil {
				return
			}
			if ev.Status != api.QrLoginPending {
				return
			}
		}
	}
}
