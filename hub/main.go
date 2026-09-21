package main

import (
	"flag"
	"log"
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

func main() {
	base := defaultDir()
	socketPath := flag.String("socket", filepath.Join(base, "run", "hub.sock"), "Unix socket 路径")
	statePath := flag.String("state", filepath.Join(base, "hub-state", "allowlist.json"), "白名单落盘路径")
	askTTL := flag.Duration("ask-ttl", time.Hour, "审批超时")
	pairTTL := flag.Duration("pair-ttl", 15*time.Minute, "配对码有效期")
	flag.Parse()

	if flag.NArg() > 0 {
		os.Exit(runClient(*socketPath, flag.Args()))
	}

	if err := os.MkdirAll(filepath.Dir(*socketPath), 0o700); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(*statePath), 0o700); err != nil {
		log.Fatal(err)
	}

	h := newHub(*statePath, *askTTL, *pairTTL, nil)
	s := newServer(h, *socketPath)
	if bin := findGUIBinary(); bin != "" {
		s.launchGateGUI(bin)
		log.Printf("gate gui: %s", bin)
	} else {
		log.Printf("gate gui: 未找到 wails-gui，审批只扇出已连接适配器")
	}
	if yad := findYad(); yad != "" {
		s.launchAllowGUI = func(pairs []PairItem, asks []ListItem) {
			code, err := runAllowDialog(yad, pairs, asks)
			if err != nil {
				log.Printf("allow dialog: %v", err)
				return
			}
			if code == "" {
				return
			}
			if _, err := s.hub.Grant(code); err != nil {
				log.Printf("grant from yad: %v", err)
			}
		}
		log.Printf("allow dialog: %s", yad)
	} else {
		log.Printf("allow dialog: 未找到 yad，/remote:gui 不可用")
	}
	if err := s.Listen(); err != nil {
		log.Fatal(err)
	}
	log.Printf("hub listen %s uid=%d", *socketPath, os.Getuid())

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			s.tick()
		}
	}()

	errCh := make(chan error, 1)
	go func() { errCh <- s.Serve() }()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sig:
		log.Printf("signal, closing")
	case err := <-errCh:
		if err != nil {
			log.Printf("serve: %v", err)
		}
	}
	_ = s.Close()
	_ = os.Remove(*socketPath)
}
