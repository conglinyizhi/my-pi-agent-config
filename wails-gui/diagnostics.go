package main

// diagnostics.go — Wails 对本地 subagent 诊断档案的只读访问。
// 档案由 Node 父进程写入 ~/.pi/subagent-diagnostics；这里不解释、不修改内容。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

var diagnosticID = regexp.MustCompile(`^batch-[A-Za-z0-9_-]+$`)

type DiagnosticSummary struct {
	BatchID   string `json:"batchId"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	Model     string `json:"model"`
	Workers   int    `json:"workers"`
}

func diagnosticsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "subagent-diagnostics")
}

// GetSubagentDiagnostics 返回本机永久档案的轻量索引，按最近更新时间倒序。
func (a *App) GetSubagentDiagnostics() []DiagnosticSummary {
	entries, err := os.ReadDir(diagnosticsDir())
	if err != nil { return []DiagnosticSummary{} }
	out := []DiagnosticSummary{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" { continue }
		data, err := os.ReadFile(filepath.Join(diagnosticsDir(), entry.Name()))
		if err != nil { continue }
		var doc struct {
			BatchID string `json:"batchId"`
			CreatedAt string `json:"createdAt"`
			UpdatedAt string `json:"updatedAt"`
			Model string `json:"model"`
			Workers []json.RawMessage `json:"workers"`
		}
		if json.Unmarshal(data, &doc) != nil || !diagnosticID.MatchString(doc.BatchID) { continue }
		out = append(out, DiagnosticSummary{BatchID: doc.BatchID, CreatedAt: doc.CreatedAt, UpdatedAt: doc.UpdatedAt, Model: doc.Model, Workers: len(doc.Workers)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

// GetSubagentDiagnostic 返回单份完整本地档案。ID 严格校验，防路径穿越。
func (a *App) GetSubagentDiagnostic(batchID string) string {
	if !diagnosticID.MatchString(batchID) { return "" }
	data, err := os.ReadFile(filepath.Join(diagnosticsDir(), batchID+".json"))
	if err != nil { return "" }
	return string(data)
}

// DeleteSubagentDiagnostic 仅删除经过 batch ID 校验的单份本地档案；无自动保留策略。
func (a *App) DeleteSubagentDiagnostic(batchID string) bool {
	if !diagnosticID.MatchString(batchID) { return false }
	return os.Remove(filepath.Join(diagnosticsDir(), batchID+".json")) == nil
}
