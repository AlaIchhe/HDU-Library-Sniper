package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveHomeDirPrecedence(t *testing.T) {
	t.Setenv("HDU_SNIPER_HOME", "/tmp/hdu-env-home")
	if got := ResolveHomeDir("/tmp/fallback"); got != "/tmp/hdu-env-home" {
		t.Fatalf("ResolveHomeDir with env = %q", got)
	}

	t.Setenv("HDU_SNIPER_HOME", "")
	if got := ResolveHomeDir("/tmp/fallback"); got != "/tmp/fallback" {
		t.Fatalf("ResolveHomeDir with fallback = %q", got)
	}
}

func TestOpenCreatesDatabaseAndServesHealth(t *testing.T) {
	t.Setenv("HDU_SNIPER_HOME", "")
	home := t.TempDir()
	rt, err := Open(home, nil)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer func() { _ = rt.Close() }()

	if _, err := os.Stat(filepath.Join(home, "data", "sniper.db")); err != nil {
		t.Fatalf("expected sniper.db in data dir: %v", err)
	}

	rec := httptest.NewRecorder()
	rt.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d", rec.Code)
	}
}
