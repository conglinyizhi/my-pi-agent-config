package main

// subagent_supplement_test.go — Task 4: Wails supplement queue API 测试
//
// 覆盖（对齐 Node lib/subagent-supplement.test.ts 的语义）：
//   - inboxId 校验（安全标识符，拒绝路径穿越）
//   - 与 Node 的跨语言互操作：Go 读取 Node 写法的字面量 JSON（camelCase、
//     handedOffAt 缺失时省略），enqueue/withdraw/merge 后输出 schema 值一致、
//     UTF-8 文本保留
//   - enqueue 仅允许 active（starting/running）worker；terminal 拒绝、未知 inbox 拒绝
//   - withdraw/merge 仅撤回 pending、merge 全局顺序、handoff 稳定
//   - root 0700 / 队列文件 0600、无残留锁
//   - 锁：新鲜锁超时不删除他人锁；陈旧锁（mtime 过旧）可回收
//   - GetSubagentStatus 富化：supplements 数组、缺失/损坏队列降级为 []、
//     无 inboxId worker 仍可解析、状态文件缺失返回 "{}"

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestApp 构造注入 supplement root 与 status 路径的 App（测试不触碰真实 ~/.pi）。
func newTestApp(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	app := &App{supplementRoot: root, statusPath: filepath.Join(root, "status.json")}
	return app, root
}

// seedStatus 写入 status 快照文件（worker 数组可含任意字段）。
func (a *App) seedStatus(t *testing.T, workers []map[string]any) {
	t.Helper()
	doc := map[string]any{"updatedAt": "2025-07-29T12:00:00.000Z", "workers": workers}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.statusPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// seedInbox 直接写入队列文件（模拟 Node 侧已落盘的字面量 JSON）。
func seedInbox(t *testing.T, root, inboxID, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, inboxID+".json"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func statMode(p string) os.FileMode {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Mode().Perm()
}

func TestIsValidInboxID(t *testing.T) {
	for _, id := range []string{"abc123", "a_b-c", "batch-42_worker-7", strings.Repeat("A", 128)} {
		if !isValidInboxID(id) {
			t.Errorf("expected valid inboxId %q", id)
		}
	}
	for _, id := range []string{"", "..", "a/b", `a\b`, "a b", "a.b", strings.Repeat("a", 129), "中文"} {
		if isValidInboxID(id) {
			t.Errorf("expected invalid inboxId %q", id)
		}
	}
}

// 跨语言互操作：Go 读取 Node 写法的队列文件，读/enqueue/withdraw/merge 后
// 输出 schema 值必须与 Node 语义一致（camelCase、handedOffAt 省略、UTF-8 保留）。
func TestCrossLanguageNodeCompatibleQueue(t *testing.T) {
	app, root := newTestApp(t)
	// Node lib/subagent-supplement.ts 的真实字面量形状：inboxId/createdAt/updatedAt/entries，
	// 无 handedOffAt 的 entry 不带该键；文本为 UTF-8。
	seedInbox(t, root, "batch-x-w1", `{
  "inboxId": "batch-x-w1",
  "createdAt": "2025-07-29T12:00:00.000Z",
  "updatedAt": "2025-07-29T12:00:01.000Z",
  "entries": [
    {"id": "e-node-1", "text": "alpha 补充", "state": "pending", "createdAt": "2025-07-29T12:00:01.000Z"},
    {"id": "e-node-2", "text": "beta", "state": "handoff", "createdAt": "2025-07-29T12:00:02.000Z", "handedOffAt": "2025-07-29T12:00:03.000Z"}
  ]
}`)
	app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "batch-x-w1", "status": "running"}})

	// Go 读取：schema 值完整、UTF-8 文本保留、handedOffAt 仅在存在时出现。
	inbox, err := supplementReadInbox(root, "batch-x-w1")
	if err != nil {
		t.Fatal(err)
	}
	if inbox.InboxID != "batch-x-w1" || inbox.Entries[0].Text != "alpha 补充" || inbox.Entries[0].State != "pending" {
		t.Fatalf("read schema mismatch: %+v", inbox)
	}
	if inbox.Entries[1].State != "handoff" || inbox.Entries[1].HandedOffAt == "" {
		t.Fatalf("handoff entry missing handedOffAt: %+v", inbox.Entries[1])
	}

	// enqueue：App 方法追加一条 pending（FIFO 队尾），UTF-8 保留。
	queued, err := app.QueueSubagentSupplement("batch-x-w1", "gamma 第三条")
	if err != nil {
		t.Fatal(err)
	}
	if len(queued.Entries) != 3 || queued.Entries[2].Text != "gamma 第三条" || queued.Entries[2].State != "pending" {
		t.Fatalf("enqueue mismatch: %+v", queued.Entries)
	}
	if queued.Entries[0].State != "pending" || queued.Entries[1].State != "handoff" {
		t.Fatalf("existing entries altered: %+v", queued.Entries)
	}
	// 落盘仍是合法 JSON，Node 可读（再读一遍验证）。
	if _, err := supplementReadInbox(root, "batch-x-w1"); err != nil {
		t.Fatalf("queue file not re-readable after enqueue: %v", err)
	}

	// withdraw：撤回 pending gamma；handoff 保留。
	withdrawnID := queued.Entries[2].ID
	mut, err := app.WithdrawSubagentSupplement("batch-x-w1", withdrawnID)
	if err != nil {
		t.Fatal(err)
	}
	if !mut.Withdrawn || len(mut.Inbox.Entries) != 2 {
		t.Fatalf("withdraw mismatch: withdrawn=%v entries=%d", mut.Withdrawn, len(mut.Inbox.Entries))
	}
	if mut.Inbox.Entries[1].State != "handoff" {
		t.Fatalf("handoff should be untouched: %+v", mut.Inbox.Entries)
	}
	// 未知 entry id → withdrawn false，不写盘。
	mut2, err := app.WithdrawSubagentSupplement("batch-x-w1", "does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	if mut2.Withdrawn {
		t.Fatal("withdraw of unknown entry must be false")
	}

	// merge：少于 2 条 pending → merged false；补足后合并全部 pending。
	app.QueueSubagentSupplement("batch-x-w1", "delta")
	app.QueueSubagentSupplement("batch-x-w1", "epsilon")
	// entries: [alpha(p), beta(h), delta(p), epsilon(p)]
	merged, err := app.MergeSubagentSupplements("batch-x-w1")
	if err != nil {
		t.Fatal(err)
	}
	if !merged.Merged {
		t.Fatal("merge should succeed with 3 pending")
	}
	want := "alpha 补充\n\n--- Supplement 2 ---\n\ndelta\n\n--- Supplement 3 ---\n\nepsilon"
	if len(merged.Inbox.Entries) != 2 || merged.Inbox.Entries[0].Text != want {
		t.Fatalf("merge order/delimiter mismatch:\n got: %q\nwant: %q", merged.Inbox.Entries[0].Text, want)
	}
	if merged.Inbox.Entries[0].State != "pending" || merged.Inbox.Entries[1].State != "handoff" {
		t.Fatalf("merged state/handoff stability mismatch: %+v", merged.Inbox.Entries)
	}
}

// enqueue 仅允许 active（starting/running）；terminal 拒绝、未知 inbox 拒绝。
func TestEnqueueActiveOnlyValidation(t *testing.T) {
	cases := []struct {
		status string
		ok     bool
		want   string
	}{
		{"starting", true, ""},
		{"running", true, ""},
		{"success", false, "lifecycle has ended"},
		{"failed", false, "lifecycle has ended"},
		{"aborted", false, "lifecycle has ended"},
		{"timeout", false, "lifecycle has ended"},
	}
	for _, c := range cases {
		app, root := newTestApp(t)
		app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "bx-1", "status": c.status}})
		seedInbox(t, root, "bx-1", `{"inboxId":"bx-1","createdAt":"T0","updatedAt":"T0","entries":[]}`)
		_, err := app.QueueSubagentSupplement("bx-1", "text")
		if c.ok && err != nil {
			t.Fatalf("status %s: unexpected error %v", c.status, err)
		}
		if !c.ok {
			if err == nil {
				t.Fatalf("status %s: expected error, got nil", c.status)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("status %s: error %q missing %q", c.status, err.Error(), c.want)
			}
		}
	}

	// 未知 inbox：status 里没有该 worker → 拒绝。
	app, _ := newTestApp(t)
	app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "known-1", "status": "running"}})
	_, err := app.QueueSubagentSupplement("ghost-1", "text")
	if err == nil || !strings.Contains(err.Error(), "unknown inboxId") {
		t.Fatalf("unknown inbox should be rejected, got %v", err)
	}

	// 非法 inboxId（路径穿越）→ 拒绝且不读 status。
	_, err = app.QueueSubagentSupplement("../evil", "text")
	if err == nil || !strings.Contains(err.Error(), "invalid inboxId") {
		t.Fatalf("invalid inboxId should be rejected, got %v", err)
	}
}

// withdraw/merge 需要已知 inbox（terminal 也允许），未知 inbox 拒绝。
func TestWithdrawMergeTerminalAllowed(t *testing.T) {
	app, root := newTestApp(t)
	app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "done-1", "status": "success"}})
	seedInbox(t, root, "done-1", `{
  "inboxId": "done-1",
  "createdAt": "T0",
  "updatedAt": "T0",
  "entries": [
    {"id": "p1", "text": "a", "state": "pending", "createdAt": "T1"},
    {"id": "p2", "text": "b", "state": "pending", "createdAt": "T2"},
    {"id": "h1", "text": "handed", "state": "handoff", "createdAt": "T3", "handedOffAt": "T4"}
  ]
}`)
	// terminal worker 仍可 merge（只编辑本地草稿队列）。
	m, err := app.MergeSubagentSupplements("done-1")
	if err != nil {
		t.Fatal(err)
	}
	if !m.Merged || len(m.Inbox.Entries) != 2 || m.Inbox.Entries[0].Text != "a\n\n--- Supplement 2 ---\n\nb" {
		t.Fatalf("terminal merge failed: %+v", m.Inbox.Entries)
	}
	if m.Inbox.Entries[0].State != "pending" || m.Inbox.Entries[1].State != "handoff" {
		t.Fatalf("merge state/handoff stability: %+v", m.Inbox.Entries)
	}
	// terminal worker 仍可 withdraw：撤回合并后的 pending。
	mut, err := app.WithdrawSubagentSupplement("done-1", m.Inbox.Entries[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if !mut.Withdrawn || len(mut.Inbox.Entries) != 1 || mut.Inbox.Entries[0].State != "handoff" {
		t.Fatalf("terminal withdraw failed: %+v", mut.Inbox.Entries)
	}
	// 未知 inbox：withdraw/merge 都拒绝。
	if _, err := app.WithdrawSubagentSupplement("ghost-1", "p1"); err == nil || !strings.Contains(err.Error(), "unknown inboxId") {
		t.Fatalf("unknown inbox withdraw should be rejected, got %v", err)
	}
	if _, err := app.MergeSubagentSupplements("ghost-1"); err == nil || !strings.Contains(err.Error(), "unknown inboxId") {
		t.Fatalf("unknown inbox merge should be rejected, got %v", err)
	}
}

// Go 输出不得泄露队列根/status 路径：把根目录设成只读制造 os 错误，断言错误文本不含路径。
func TestSupplementErrorsDoNotLeakPaths(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "secret-root")
	app := &App{supplementRoot: root, statusPath: filepath.Join(parent, "status.json")}
	app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "sec-1", "status": "running"}})
	// 先造一个正常队列，再让根目录不可写（chmod 0500），触发写盘 os 错误。
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	seedInbox(t, root, "sec-1", `{"inboxId":"sec-1","createdAt":"T0","updatedAt":"T0","entries":[]}`)
	if err := os.Chmod(root, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(root, 0o700)
	_, err := app.QueueSubagentSupplement("sec-1", "text")
	if err == nil {
		t.Fatal("expected write error on read-only root")
	}
	msg := err.Error()
	if strings.Contains(msg, root) || strings.Contains(msg, "secret-root") || strings.Contains(msg, app.statusPath) {
		t.Fatalf("error leaked path: %q", msg)
	}
}

// root 0700 / 队列文件 0600、无残留锁、无 tmp 残留。
func TestSupplementRootAndFileModes(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "inbox-root")
	app := &App{supplementRoot: root, statusPath: filepath.Join(parent, "status.json")}
	app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "mode-1", "status": "running"}})
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	seedInbox(t, root, "mode-1", `{"inboxId":"mode-1","createdAt":"T0","updatedAt":"T0","entries":[]}`)
	if _, err := app.QueueSubagentSupplement("mode-1", "text"); err != nil {
		t.Fatal(err)
	}
	if got := statMode(root); got != 0o700 {
		t.Errorf("root mode = %o, want 700", got)
	}
	file := filepath.Join(root, "mode-1.json")
	if got := statMode(file); got != 0o600 {
		t.Errorf("queue file mode = %o, want 600", got)
	}
	if _, err := os.Stat(file + ".lock"); !os.IsNotExist(err) {
		t.Error("lock dir left behind after operation")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Errorf("tmp file left behind: %s", e.Name())
		}
	}
}

// 锁：新鲜锁超时不删除他人锁；陈旧锁（mtime 过旧）可回收继续。
func TestSupplementLockTimeoutAndStaleRecovery(t *testing.T) {
	oldTimeout, oldStale := supplementLockTimeout, supplementLockStale
	defer func() { supplementLockTimeout, supplementLockStale = oldTimeout, oldStale }()

	t.Run("fresh lock times out without removal", func(t *testing.T) {
		supplementLockTimeout = 80 * time.Millisecond
		supplementLockStale = 10 * time.Second
		app, root := newTestApp(t)
		app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "lk-1", "status": "running"}})
		seedInbox(t, root, "lk-1", `{"inboxId":"lk-1","createdAt":"T0","updatedAt":"T0","entries":[]}`)
		lockDir := filepath.Join(root, "lk-1.json.lock")
		if err := os.Mkdir(lockDir, 0o700); err != nil {
			t.Fatal(err)
		}
		_, err := app.QueueSubagentSupplement("lk-1", "text")
		if err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("expected lock timeout error, got %v", err)
		}
		if _, err := os.Stat(lockDir); err != nil {
			t.Error("fresh lock was removed by timeout path")
		}
	})

	t.Run("stale lock is recovered", func(t *testing.T) {
		supplementLockStale = 50 * time.Millisecond
		app, root := newTestApp(t)
		app.seedStatus(t, []map[string]any{{"id": "w1", "inboxId": "lk-2", "status": "running"}})
		seedInbox(t, root, "lk-2", `{"inboxId":"lk-2","createdAt":"T0","updatedAt":"T0","entries":[]}`)
		lockDir := filepath.Join(root, "lk-2.json.lock")
		if err := os.Mkdir(lockDir, 0o700); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-5 * time.Second)
		if err := os.Chtimes(lockDir, old, old); err != nil {
			t.Fatal(err)
		}
		if _, err := app.QueueSubagentSupplement("lk-2", "text"); err != nil {
			t.Fatalf("stale lock should be recovered: %v", err)
		}
		if _, err := os.Stat(lockDir); !os.IsNotExist(err) {
			t.Error("stale lock not removed after recovery")
		}
	})
}

// GetSubagentStatus 富化：supplements 数组、缺失/损坏队列降级 []、未知字段保留、
// 无 inboxId worker 不加 supplements、状态文件缺失返回 "{}"。
func TestGetSubagentStatusEnrichment(t *testing.T) {
	app, root := newTestApp(t)
	// w1：running + inboxId + 队列有 entries；w2：running 无 inboxId；w3：success + inboxId 但队列缺失。
	// 顶层额外塞一个未知字段，验证富化后原样保留。
	seedDoc := map[string]any{
		"updatedAt": "2025-07-29T12:00:00.000Z",
		"extraTopLevelField": "keep-me",
		"workers": []map[string]any{
			{"id": "w1", "inboxId": "en-1", "status": "running", "task": "t1"},
			{"id": "w2", "status": "running", "task": "t2"},
			{"id": "w3", "inboxId": "en-3", "status": "success", "task": "t3"},
		},
	}
	raw, err := json.Marshal(seedDoc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(app.statusPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	seedInbox(t, root, "en-1", `{
  "inboxId": "en-1",
  "createdAt": "T0",
  "updatedAt": "T1",
  "entries": [
    {"id": "s1", "text": "x", "state": "pending", "createdAt": "T1"},
    {"id": "s2", "text": "y", "state": "handoff", "createdAt": "T2", "handedOffAt": "T3"}
  ]
}`)
	// w3 有 inboxId 但队列文件不存在：supplements 必须降级为 []。
	out := app.GetSubagentStatus()
	var doc struct {
		UpdatedAt string `json:"updatedAt"`
		Extra     string `json:"extraTopLevelField"`
		Workers   []struct {
			ID          string            `json:"id"`
			InboxID     string            `json:"inboxId"`
			Task        string            `json:"task"`
			Supplements []SupplementEntry `json:"supplements"`
		} `json:"workers"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("enriched status is not valid JSON: %v\n%s", err, out)
	}
	if doc.UpdatedAt != "2025-07-29T12:00:00.000Z" {
		t.Errorf("top-level updatedAt not preserved: %+v", doc.UpdatedAt)
	}
	if len(doc.Workers) != 3 {
		t.Fatalf("workers lost: %d", len(doc.Workers))
	}
	w1 := doc.Workers[0]
	if w1.InboxID != "en-1" || len(w1.Supplements) != 2 || w1.Supplements[0].Text != "x" || w1.Supplements[1].HandedOffAt == "" {
		t.Fatalf("w1 supplements mismatch: %+v", w1.Supplements)
	}
	if w1.Task != "t1" {
		t.Errorf("worker fields not preserved: %+v", w1)
	}
	if doc.Workers[1].Supplements != nil {
		t.Errorf("worker without inboxId must NOT get supplements key: %+v", doc.Workers[1].Supplements)
	}
	if doc.Workers[2].Supplements == nil || len(doc.Workers[2].Supplements) != 0 {
		t.Errorf("missing queue must degrade to empty array, got %+v", doc.Workers[2].Supplements)
	}
	if doc.Extra != "keep-me" {
		t.Errorf("unknown top-level field should be preserved, got %q", doc.Extra)
	}

	// 损坏的队列：supplements []，status 不被吞成 {}。
	seedInbox(t, root, "en-1", `{not json`)
	out = app.GetSubagentStatus()
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("corrupt queue must not break status JSON: %v\n%s", err, out)
	}
	if len(doc.Workers) != 3 || len(doc.Workers[0].Supplements) != 0 {
		t.Fatalf("corrupt queue should give supplements [] with workers intact: %+v", doc.Workers)
	}

	// 状态文件缺失：返回 "{}"。
	app2, _ := newTestApp(t)
	if got := app2.GetSubagentStatus(); got != "{}" {
		t.Fatalf("absent status file should return {}, got %q", got)
	}
}
