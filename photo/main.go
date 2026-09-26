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
	stateDir := flag.String("state", filepath.Join(base, "photo-state"), "落盘目录（archive / refs / token）")
	pool := flag.Int("pool", 99, "短编号池大小 1..pool；池满时回收最久未用的那条")
	flag.Parse()

	st, err := newStore(*stateDir, *pool)
	if err != nil {
		log.Fatal(err)
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}

	hs := &http.Server{
		Handler:           newAPI(st).handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// 只报地址与口令文件位置，不把 token 打进 journal：
	// journal 会跟着 systemd 落盘、也会被 journalctl 一把捞出来。
	log.Printf("photo 就绪：监听 %s，编号池 %d", ln.Addr().String(), st.Pool())
	log.Printf("  手机打开 http://%s/（口令见 %s）", lanURL(ln.Addr().String()), filepath.Join(st.Root(), "token"))
	log.Printf("  state:  %s", st.Root())

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	errCh := make(chan error, 1)
	go func() { errCh <- hs.Serve(ln) }()

	select {
	case <-sig:
		log.Printf("收到信号，关闭")
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Printf("serve: %v", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = hs.Shutdown(ctx)
}
