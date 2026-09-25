package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// GetInitData 对 gate 窗口是按字段白名单注入的：pi 侧新加的字段必须在这里放行，
// 否则前端拿不到（这条测试就是钉住「新字段有被放行」）。
func TestGetInitDataGateCarriesEnvNotes(t *testing.T) {
	dir := t.TempDir()
	reqFile := filepath.Join(dir, "request.json")
	request := map[string]any{
		"kind":    "audit",
		"command": "export OUT=$HOME/out",
		"rules":   []any{},
		"envNotes": []any{
			map[string]any{"name": "OUT", "raw": "OUT=$HOME/out", "start": 7, "end": 21, "value": "/home/u/out"},
			map[string]any{"name": "OTHER", "raw": "OTHER=$(pwd)", "start": 0, "end": 4, "reason": "值里含命令替换 $(...)，无法静态解析"},
		},
	}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(reqFile, data, 0o600); err != nil {
		t.Fatal(err)
	}

	app := NewApp("gate", reqFile, filepath.Join(dir, "response.json"))
	init, err := app.GetInitData()
	if err != nil {
		t.Fatal(err)
	}
	notes, ok := init["envNotes"].([]any)
	if !ok {
		t.Fatalf("envNotes 没有被放行：%#v", init["envNotes"])
	}
	if len(notes) != 2 {
		t.Fatalf("expected 2 notes, got %d", len(notes))
	}
	first, ok := notes[0].(map[string]any)
	if !ok || first["value"] != "/home/u/out" || first["name"] != "OUT" {
		t.Fatalf("第一条解析结果不对：%#v", notes[0])
	}
	second, ok := notes[1].(map[string]any)
	if !ok || second["reason"] == nil || second["value"] != nil {
		t.Fatalf("第二条应当只带 reason：%#v", notes[1])
	}
	// 其余字段照旧（包装不能丢东西）
	if init["command"] != "export OUT=$HOME/out" || init["kind"] != "audit" {
		t.Fatalf("其它字段被影响：%#v", init)
	}
}

// 没带就不该凭空多出这个键（前端按 undefined 容错）
func TestGetInitDataGateWithoutEnvNotes(t *testing.T) {
	dir := t.TempDir()
	reqFile := filepath.Join(dir, "request.json")
	if err := os.WriteFile(reqFile, []byte(`{"kind":"audit","command":"ls -la"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	app := NewApp("gate", reqFile, filepath.Join(dir, "response.json"))
	init, err := app.GetInitData()
	if err != nil {
		t.Fatal(err)
	}
	if notes, ok := init["envNotes"]; ok && notes != nil {
		t.Fatalf("不带时不该有值：%#v", notes)
	}
}
