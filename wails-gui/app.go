package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// App 是对应 gui-kit.mjs 的 Go 侧实现：
//   createGuiApp(inject)   -> NewApp(windowName) + GetInitData()
//   fs.writeFileSync       -> SaveResponse()
//   .ready sidecar         -> MarkReady()
type App struct {
	windowName   string
	requestFile  string
	responseFile string
}

func NewApp(windowName, requestFile, responseFile string) *App {
	return &App{windowName: windowName, requestFile: requestFile, responseFile: responseFile}
}

// GetWindowName 前端路由壳按名字选视图
func (a *App) GetWindowName() string {
	return a.windowName
}

// readRequest 读取 request 文件（失败写 .error sidecar）
func (a *App) readRequest() (map[string]interface{}, error) {
	data, err := os.ReadFile(a.requestFile)
	if err != nil {
		a.writeError(err.Error())
		return nil, err
	}
	var req map[string]interface{}
	if err := json.Unmarshal(data, &req); err != nil {
		a.writeError(err.Error())
		return nil, err
	}
	return req, nil
}

// GetInitData 按窗口分支注入数据（对齐各 app.ts 的 inject 输出结构）
func (a *App) GetInitData() (map[string]interface{}, error) {
	req, err := a.readRequest()
	if err != nil {
		return map[string]interface{}{}, err
	}
	base := map[string]interface{}{"responseFile": a.responseFile}
	switch a.windowName {
	case "setup":
		base["models"] = req["models"]
		base["roles"] = req["roles"]
	case "subagents":
		base["feedback"] = req["feedback"]
		base["workers"] = req["workers"]
	case "routing":
		base["todos"] = req["todos"]
	case "gate":
		base["command"] = req["command"]
		base["taskId"] = req["taskId"]
		base["rules"] = req["rules"]
	case "editor":
		base["clipHistory"] = req["clipHistory"]
	}
	return base, nil
}

// GetSubagentStatus 读主进程写出的实时快照（不存在返回 "{}"）
func (a *App) GetSubagentStatus() string {
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".pi", "subagent-status.json")
	data, err := os.ReadFile(p)
	if err != nil {
		return "{}"
	}
	return string(data)
}

// SaveSubagentFeedback 由 GUI 开关调用，写反馈模式状态
func (a *App) SaveSubagentFeedback(enabled bool) error {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".pi")
	_ = os.MkdirAll(dir, 0755)
	return os.WriteFile(filepath.Join(dir, "subagent-feedback.json"), []byte(fmt.Sprintf("{\"enabled\": %v}\n", enabled)), 0644)
}

// SaveResponse 写响应文件（对齐 fs.writeFileSync(responseFile, JSON.stringify(payload))）
func (a *App) SaveResponse(payload string) error {
	return os.WriteFile(a.responseFile, []byte(payload), 0644)
}

// OpenFile 用编辑器打开文件到指定行（对齐 Electron 版 child_process.exec code/cursor --goto）
func (a *App) OpenFile(file string, line int) {
	target := fmt.Sprintf("%s:%d", file, line)
	if err := exec.Command("code", "--goto", target).Run(); err != nil {
		_ = exec.Command("cursor", "--goto", target).Run()
	}
}

// ── 理由库（对齐 permission-gate 的 ldR / svR） ──

// ReasonEntry 对齐前端 ReasonEntry 接口
// {"t": timestamp, "title": ..., "kw": ..., "content": ...}
type ReasonEntry struct {
	T       string `json:"t"`
	Title   string `json:"title"`
	Kw      string `json:"kw"`
	Content string `json:"content"`
}

func reasonsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "agent", "permission-gate-reasons.csv")
}

func oldReasonsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "agent", "permission-gate-reasons.json")
}

func truncateReason(s string, n int) string {
	if len([]rune(s)) > n {
		r := []rune(s)
		return string(r[:n-3]) + "..."
	}
	return s
}

func escapeCSV(s string) string { return strings.ReplaceAll(s, "\"", "\"\"") }

// LoadReasons 读理由库（旧 .json 迁移 + CSV 解析）
func (a *App) LoadReasons() ([]ReasonEntry, error) {
	entries := []ReasonEntry{}
	// 旧 .json 迁移
	if data, err := os.ReadFile(oldReasonsPath()); err == nil {
		var old []string
		if json.Unmarshal(data, &old) == nil {
			for _, r := range old {
				entries = append(entries, ReasonEntry{
					T: time.Now().Format(time.RFC3339), Title: truncateReason(r, 40), Kw: "", Content: r,
				})
			}
			_ = os.Remove(oldReasonsPath())
		}
	}
	// CSV 读取（文件不存在时静默返回空，对齐原 JS ldR 的 try/catch）
	if f, err := os.Open(reasonsPath()); err == nil {
		defer f.Close()
		rows, _ := csv.NewReader(f).ReadAll()
		for i, row := range rows {
			if i == 0 {
				continue // header
			}
			if len(row) >= 4 {
				entries = append(entries, ReasonEntry{T: row[0], Title: row[1], Kw: row[2], Content: row[3]})
			}
		}
	}
	return entries, nil
}

// SaveReason 追加/重写理由库（去重 + 限 20 条）
func (a *App) SaveReason(content string) error {
	entries, _ := a.LoadReasons()
	entry := ReasonEntry{T: time.Now().Format(time.RFC3339), Title: truncateReason(content, 40), Kw: "", Content: content}
	newEntries := []ReasonEntry{entry}
	for _, e := range entries {
		if e.Content != content {
			newEntries = append(newEntries, e)
		}
	}
	if len(newEntries) > 20 {
		newEntries = newEntries[:20]
	}
	_ = os.MkdirAll(filepath.Dir(reasonsPath()), 0755)
	var b strings.Builder
	b.WriteString("timestamp,title,keywords,content\n")
	for _, e := range newEntries {
		b.WriteString(fmt.Sprintf("%s,\"%s\",\"%s\",\"%s\"\n", e.T, escapeCSV(e.Title), escapeCSV(e.Kw), escapeCSV(e.Content)))
	}
	return os.WriteFile(reasonsPath(), []byte(b.String()), 0644)
}

// MarkReady 前端 Vue 挂载完成后调用，写 .ready sidecar（对齐 gui-kit 的 ready 轮询）
func (a *App) MarkReady() {
	_ = os.WriteFile(a.responseFile+".ready", []byte("ok"), 0644)
}

func (a *App) writeError(msg string) {
	_ = os.WriteFile(a.responseFile+".error", []byte(msg), 0644)
}
