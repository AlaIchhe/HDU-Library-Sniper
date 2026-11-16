package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hdu-library-sniper/internal/api"
)

func TestAPIEndpointContractCoverage(t *testing.T) {
	_, h := testRouter(t)

	seenNames := make(map[string]bool, len(api.Endpoints))
	seenRoutes := make(map[string]bool, len(api.Endpoints))

	for _, ep := range api.Endpoints {
		if ep.Name == "" || !strings.HasPrefix(ep.Path, "/api/") {
			t.Fatalf("invalid endpoint spec: %+v", ep)
		}
		if seenNames[ep.Name] {
			t.Fatalf("duplicate endpoint name %q", ep.Name)
		}
		seenNames[ep.Name] = true

		key := ep.Pattern()
		if seenRoutes[key] {
			t.Fatalf("duplicate route %q", key)
		}
		seenRoutes[key] = true

		if ep.ResponseType == nil {
			t.Fatalf("endpoint %q missing ResponseType", ep.Name)
		}

		// Populate path placeholders with syntactically valid values so ServeMux routes to the handler.
		target := ep.Path
		target = strings.ReplaceAll(target, "{id}", "missing-id")
		target = strings.ReplaceAll(target, "{uuid}", "missing-uuid")
		switch ep.Name {
		case "plansToggle":
			target = strings.ReplaceAll(target, "{action}", string(api.PlanActionEnable))
		case "bookingsAction":
			target = strings.ReplaceAll(target, "{action}", string(api.BookingActionCheckIn))
		}

		var body *strings.Reader
		if ep.RequestType != nil {
			body = strings.NewReader("{}")
		} else {
			body = strings.NewReader("")
		}

		req := httptest.NewRequest(ep.Method, target, body)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code == http.StatusMethodNotAllowed {
			t.Fatalf("route %s returned 405 Method Not Allowed", key)
		}
		if strings.TrimSpace(rec.Body.String()) == `{"detail":"not found"}` {
			t.Fatalf("route %s fell through to unknown /api/ 404 handler", key)
		}
		if !ep.Public && rec.Code != http.StatusUnauthorized {
			t.Fatalf("protected route %s expected 401 when unauthenticated, got %d (%s)", key, rec.Code, rec.Body.String())
		}
		if ep.Public && rec.Code == http.StatusUnauthorized {
			t.Fatalf("public route %s unexpectedly returned 401", key)
		}
	}
}
