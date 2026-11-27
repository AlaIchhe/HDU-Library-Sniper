package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/app"
	"hdu-library-sniper/internal/events"
)

//go:embed resources/icon.png
var appIconPNG []byte

// DesktopConfig gives the WebView the local loopback HTTP/SSE endpoint and per-launch auth token.
type DesktopConfig struct {
	BaseURL string `json:"baseUrl"`
	Token   string `json:"token"`
}

// DesktopAPI exposes startup readiness and the local HTTP/SSE bridge address to the WebView.
type DesktopAPI struct {
	readyCh chan struct{}
	mu      sync.Mutex
	cfg     DesktopConfig
	initErr error
}

func newDesktopAPI() *DesktopAPI {
	return &DesktopAPI{readyCh: make(chan struct{})}
}

func (d *DesktopAPI) setReady(cfg DesktopConfig, err error) {
	d.mu.Lock()
	d.cfg = cfg
	d.initErr = err
	d.mu.Unlock()
	close(d.readyCh)
}

// Config resolves once the embedded local HTTP/SSE server is listening, or returns the startup error.
func (d *DesktopAPI) Config(ctx context.Context) (DesktopConfig, error) {
	select {
	case <-d.readyCh:
	case <-ctx.Done():
		return DesktopConfig{}, ctx.Err()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cfg, d.initErr
}

func generateDesktopToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
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
		mu          sync.Mutex
		rt          *app.Runtime
		httpSrv     *http.Server
		unsubEvents func()
		mainWin     *mygo.Window
		quitting    atomic.Bool
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
		unsub := unsubEvents
		unsubEvents = nil
		srv := httpSrv
		httpSrv = nil
		cur := rt
		mu.Unlock()
		if unsub != nil {
			unsub()
		}
		if srv != nil {
			shutCtx, shutCancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = srv.Shutdown(shutCtx)
			shutCancel()
		}
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
		token := generateDesktopToken()
		opened, err := app.Open(userDir, nil, app.Options{DesktopToken: token})
		if err != nil {
			desktop.setReady(DesktopConfig{}, err)
			log.Printf("backend startup error: %v", err)
		} else if ln, listenErr := net.Listen("tcp", "127.0.0.1:0"); listenErr != nil {
			_ = opened.Close()
			desktop.setReady(DesktopConfig{}, listenErr)
			log.Printf("local http listen error: %v", listenErr)
		} else {
			windowInFront := func() bool {
				mu.Lock()
				win := mainWin
				mu.Unlock()
				return win != nil && !win.IsDestroyed() && win.IsVisible() && win.IsFocused() && !win.IsMinimized()
			}
			unsub := opened.Events.OnPublish(func(msg events.Message) {
				if msg.Name != events.TopicAppEvent {
					return
				}
				ev, ok := msg.Payload.(api.AppEvent)
				if !ok || ev.Kind != api.AppEventNotification || ev.Notification == nil {
					return
				}
				if windowInFront() {
					return
				}
				notif := *ev.Notification
				go func() {
					_ = mygo.NewNotification(mygo.NotificationOptions{
						Title: notif.Title,
						Body:  notif.Body,
					}).Show()
				}()
			})

			srv := &http.Server{
				Handler:           opened.Handler,
				ReadHeaderTimeout: 10 * time.Second,
			}
			go func() {
				if serveErr := srv.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
					log.Printf("local http server error: %v", serveErr)
				}
			}()

			mu.Lock()
			rt = opened
			httpSrv = srv
			unsubEvents = unsub
			mu.Unlock()

			if pg.IsPackaged() {
				if done, _ := opened.Store.GetSetting("autostart_initialized"); done == "" {
					_ = pg.SetOpenAtLogin(true)
					_ = opened.Store.SetSetting("autostart_initialized", "1")
				}
			}

			opened.Start(ctx)
			desktop.setReady(DesktopConfig{
				BaseURL: "http://" + ln.Addr().String(),
				Token:   token,
			}, nil)
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
