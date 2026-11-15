package main

import (
	"context"
	_ "embed"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"

	"hdu-library-sniper/internal/app"
	"hdu-library-sniper/internal/core"
)

//go:embed resources/icon.png
var appIconPNG []byte

// APIResponse mirrors the HTTP status and response body returned over desktop IPC.
type APIResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// DesktopAPI exposes the embedded Go HTTP handler to the desktop WebView via mygo.Bind.
type DesktopAPI struct {
	readyCh chan struct{}
	mu      sync.Mutex
	handler http.Handler
	initErr error
}

func newDesktopAPI() *DesktopAPI {
	return &DesktopAPI{readyCh: make(chan struct{})}
}

func (d *DesktopAPI) setReady(handler http.Handler, err error) {
	d.mu.Lock()
	d.handler = handler
	d.initErr = err
	d.mu.Unlock()
	close(d.readyCh)
}

func (d *DesktopAPI) waitReady(ctx context.Context) (http.Handler, error) {
	select {
	case <-d.readyCh:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.handler, d.initErr
}

// Ready resolves once backend initialization completes, or returns the startup error.
func (d *DesktopAPI) Ready(ctx context.Context) error {
	_, err := d.waitReady(ctx)
	return err
}

// Request dispatches a /api/* request directly into the shared net/http handler in memory.
func (d *DesktopAPI) Request(ctx context.Context, method, path, body string) (APIResponse, error) {
	h, err := d.waitReady(ctx)
	if err != nil {
		return APIResponse{}, err
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
	req.Host = "localhost"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return APIResponse{
		Status: rec.Code,
		Body:   rec.Body.String(),
	}, nil
}

func main() {
	pg := mygo.App
	pg.SetName("HDU Library Sniper")
	if os.Getenv("MYGO_GENERATE") == "" && !pg.RequestSingleInstanceLock() {
		return
	}

	mygo.Use(updater.Plugin)
	mygo.Updater.SetPrereleases(strings.Contains(pg.Version(), "-"))
	desktop := newDesktopAPI()
	mygo.Bind(desktop)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var (
		mu       sync.Mutex
		rt       *app.Runtime
		mainWin  *mygo.Window
		quitting atomic.Bool
	)

	showWindow := func() {
		mu.Lock()
		win := mainWin
		if win != nil && !win.IsDestroyed() {
			mu.Unlock()
			if win.IsMinimized() {
				win.Restore()
			}
			win.Show()
			win.Focus()
			return
		}
		mu.Unlock()

		win = mygo.NewWindow(mygo.WindowOptions{
			Title:           "HDU Library Sniper",
			URL:             "/",
			Width:           1180,
			Height:          760,
			MinWidth:        760,
			MinHeight:       560,
			Hidden:          pg.WasOpenedAtLogin() || slices.Contains(os.Args[1:], "--background"),
			StateKey:        "main",
			BackgroundColor: "light-dark(#f8fafc, #09090b)",
		})
		win.OnClose(func(e *mygo.CloseEvent) {
			if !quitting.Load() {
				e.PreventDefault()
				win.Hide()
			}
		})
		mu.Lock()
		mainWin = win
		mu.Unlock()
	}

	pg.OnSecondInstance(func(_ []string, _ string) { showWindow() })
	pg.OnActivate(func(hasVisible bool) {
		if !hasVisible {
			showWindow()
		}
	})
	pg.OnWindowAllClosed(func() {})
	pg.OnBeforeQuit(func(*mygo.QuitEvent) { quitting.Store(true) })
	pg.OnQuit(func() {
		cancel()
		mu.Lock()
		cur := rt
		mu.Unlock()
		if cur != nil {
			_ = cur.Close()
		}
	})

	pg.WhenReady(func() {
		if runtime.GOOS == "darwin" {
			pg.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
				{Label: "HDU Library Sniper", Submenu: []*mygo.MenuItem{
					{Role: mygo.RoleAbout},
					updater.MenuItem(),
					mygo.Separator(),
					{Role: mygo.RoleHide},
					{Role: mygo.RoleHideOthers},
					{Role: mygo.RoleUnhide},
					mygo.Separator(),
					{Role: mygo.RoleQuit},
				}},
				{Role: mygo.RoleEditMenu},
				{Role: mygo.RoleWindowMenu},
			}))
		}

		userDir, _ := pg.Path(mygo.PathUserData)
		opened, err := app.Open(userDir, nil)
		if err != nil {
			desktop.setReady(nil, err)
			log.Printf("backend startup error: %v", err)
		} else {
			mu.Lock()
			rt = opened
			mu.Unlock()

			if pg.IsPackaged() {
				if done, _ := opened.Store.GetMeta("autostart_initialized"); done == "" {
					_ = pg.SetOpenAtLogin(true)
					_ = opened.Store.SetMeta("autostart_initialized", "1")
				}
			}

			opened.Store.SetOnAudit(notifyAuditEvent)
			opened.Start(ctx)
			desktop.setReady(opened.Handler, nil)
		}

		showWindow()

		tray, trayErr := mygo.NewTray(mygo.TrayOptions{
			ID:      "main",
			Icon:    appIconPNG,
			ToolTip: "HDU Library Sniper",
			Menu: mygo.NewMenu([]*mygo.MenuItem{
				{Label: "显示窗口", Click: func(*mygo.MenuItem, *mygo.Window) { showWindow() }},
				{
					Label:   "开机自启动",
					Type:    mygo.MenuItemCheckbox,
					Checked: pg.OpenAtLogin(),
					Click: func(item *mygo.MenuItem, _ *mygo.Window) {
						_ = pg.SetOpenAtLogin(item.Checked)
					},
				},
				{Label: "检查更新…", Click: func(*mygo.MenuItem, *mygo.Window) { updater.CheckForUpdates() }},
				mygo.Separator(),
				{Label: "退出", Click: func(*mygo.MenuItem, *mygo.Window) {
					quitting.Store(true)
					pg.Quit()
				}},
			}),
		})
		if trayErr != nil {
			log.Printf("tray setup warning: %v", trayErr)
		} else {
			tray.OnClick(func() { showWindow() })
		}
	})

	if err := pg.Run(); err != nil {
		log.Fatal(err)
	}
}

func notifyAuditEvent(event string, payload map[string]any) {
	var title, body string
	switch event {
	case "booking_run_finished":
		msg := core.ToString(payload["message"])
		if core.ToBool(payload["success"]) {
			title = "预约成功"
		} else {
			title = "预约失败"
		}
		body = msg
	case "checkin_succeeded":
		title = "自动签到成功"
		body = "预约 " + core.ToString(payload["bookingId"]) + " 已完成签到"
	case "checkin_missed":
		title = "自动签到超时"
		body = core.ToString(payload["reason"])
	case "checkin_failed":
		if core.ToBool(payload["terminal"]) {
			title = "自动签到已停止"
			body = core.ToString(payload["error"])
		}
	}
	if title != "" {
		_ = mygo.NewNotification(mygo.NotificationOptions{Title: title, Body: body}).Show()
	}
}
