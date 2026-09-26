package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func defaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".pi", "agent")
}

// 默认值都挂在 ~/.pi/agent 下：这台机器上 pi 的所有机级状态都在这儿，
// 换机器只要搬这一个目录。
func main() {
	base := defaultDir()
	addr := flag.String("addr", "0.0.0.0:8787", "局域网 HTTP 监听地址（手机访问这个）")
	socketPath := flag.String("socket", filepath.Join(base, "run", "photo.sock"), "Unix socket 路径")
	stateDir := flag.String("state", filepath.Join(base, "photo-state"), "落盘目录（queue / archive / token）")
	stale := flag.Duration("stale", 30*time.Second, "holder 心跳超期时长，超过就判假死")
	tick := flag.Duration("tick", 5*time.Second, "扫假死 holder、重推积压的间隔")
	flag.Parse()

	st, err := newStore(*stateDir)
	if err != nil {
		log.Fatal(err)
	}
	srv := newServer(st, *socketPath, *stale)
	if err := srv.Listen(); err != nil {
		log.Fatal(err)
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	// HTTP 真实监听到的地址要回填：默认 0.0.0.0 不能拿去给手机扫，
	// url 消息得据此换成本机在局域网里的地址。
	srv.webAddr = ln.Addr().String()

	hs := &http.Server{
		Handler:           srv.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// 只报地址与口令文件位置，不把 token 打进 journal：
	// journal 会跟着 systemd 落盘、也会被 journalctl 一把捞出来。
	log.Printf("photo 就绪 uid=%d", os.Getuid())
	log.Printf("  socket: %s", *socketPath)
	log.Printf("  web:    http://%s/", ln.Addr().String())
	log.Printf("  state:  %s（口令在 state/token）", st.Root())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		t := time.NewTicker(*tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				srv.tick(now)
			}
		}
	}()

	errCh := make(chan error, 2)
	go func() { errCh <- srv.Serve() }()
	go func() { errCh <- hs.Serve(ln) }()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sig:
		log.Printf("收到信号，关闭")
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Printf("serve: %v", err)
		}
	}

	cancel()
	_ = srv.Close()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer shutCancel()
	_ = hs.Shutdown(shutCtx)
	// socket 文件留在原地会挡住下次启动（net.Listen 对已存在的路径直接报错），
	// hub 的 Listen 里也会先删一次，这里主动清干净。
	_ = os.Remove(*socketPath)
}
