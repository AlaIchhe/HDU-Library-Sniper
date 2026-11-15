package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"hdu-library-sniper/internal/app"
)

func main() {
	port := envOr("HDU_WEB_PORT", "8000")
	for _, arg := range os.Args[1:] {
		if arg == "--healthcheck" {
			os.Exit(healthcheck(port))
		}
	}

	var frontend fs.FS
	staticDir := envOr("HDU_STATIC_DIR", "dist/web")
	if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
		frontend = os.DirFS(staticDir)
	} else {
		log.Printf("warning: static directory %q not found; serving API only", staticDir)
	}

	rt, err := app.Open("", frontend)
	if err != nil {
		log.Fatalf("startup failed: %v", err)
	}
	defer func() { _ = rt.Close() }()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	rt.Start(ctx)

	host := envOr("HDU_WEB_HOST", "127.0.0.1")
	addr := host + ":" + port
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           rt.Handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	log.Printf("HDU Library Sniper server listening on http://%s", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func healthcheck(port string) int {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/health")
	if err != nil {
		return 1
	}
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return 0
	}
	return 1
}
