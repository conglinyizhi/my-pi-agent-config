package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type guiProc struct {
	cmd    *exec.Cmd
	tmpDir string
}

type guiDecision struct {
	Action      string       `json:"action"`
	Comment     string       `json:"comment"`
	PathActions []PathAction `json:"pathActions"`
	// WritePaths 是窗口里编辑后的执行范围；旧版 GUI 不写这个字段，读出来就是 nil
	WritePaths []string `json:"writePaths"`
}

type guiLauncher struct {
	bin string
	mu  sync.Mutex
	by  map[string]*guiProc
}

func newGUILauncher(bin string) *guiLauncher {
	return &guiLauncher{bin: bin, by: map[string]*guiProc{}}
}

func (g *guiLauncher) launch(ask *Ask, decide func(action, comment string, pa []PathAction, writePaths []string)) {
	if g.bin == "" || ask == nil {
		return
	}
	tmp, err := os.MkdirTemp("", "pi-hub-gate-")
	if err != nil {
		return
	}
	reqFile := filepath.Join(tmp, "request.json")
	respFile := filepath.Join(tmp, "response.json")
	payload := map[string]any{}
	for k, v := range ask.Payload {
		payload[k] = v
	}
	if _, ok := payload["kind"]; !ok {
		payload["kind"] = ask.Kind
	}
	data, err := json.Marshal(payload)
	if err != nil {
		os.RemoveAll(tmp)
		return
	}
	if err := os.WriteFile(reqFile, data, 0o600); err != nil {
		os.RemoveAll(tmp)
		return
	}
	cmd := exec.Command(g.bin, "gate", reqFile, respFile)
	cmd.Env = guiEnv()
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		os.RemoveAll(tmp)
		return
	}
	g.mu.Lock()
	g.by[ask.RequestID] = &guiProc{cmd: cmd, tmpDir: tmp}
	g.mu.Unlock()

	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()

	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			if d := readGUIDecision(respFile); d != nil && decide != nil {
				decide(d.Action, d.Comment, d.PathActions, d.WritePaths)
			}
			g.cleanup(ask.RequestID, cmd, tmp)
			return
		case <-ticker.C:
			if d := readGUIDecision(respFile); d != nil {
				if decide != nil {
					decide(d.Action, d.Comment, d.PathActions, d.WritePaths)
				}
				return
			}
		}
	}
}

func (g *guiLauncher) cleanup(requestID string, cmd *exec.Cmd, tmp string) {
	g.mu.Lock()
	cur := g.by[requestID]
	if cur != nil && cur.cmd == cmd {
		delete(g.by, requestID)
		os.RemoveAll(tmp)
	}
	g.mu.Unlock()
}

func (g *guiLauncher) kill(requestID string) {
	g.mu.Lock()
	p := g.by[requestID]
	delete(g.by, requestID)
	g.mu.Unlock()
	if p == nil {
		return
	}
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	os.RemoveAll(p.tmpDir)
}

func readGUIDecision(path string) *guiDecision {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var d guiDecision
	if json.Unmarshal(data, &d) != nil {
		return nil
	}
	if d.Action != "allow" && d.Action != "deny" {
		return nil
	}
	return &d
}

func findGUIBinary() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	candidates := []string{
		filepath.Join(home, ".pi", "agent", "bin", "wails-gui"),
		filepath.Join(home, ".pi", "agent", "wails-gui", "build", "bin", "wails-gui"),
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}
