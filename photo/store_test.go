package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// token 只在首次启动生成，之后固定；文件 0600，内容 32 位 hex。
func TestTokenFileStableAndPrivate(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	token := st.Token()
	if !validToken(token) {
		t.Fatalf("token 不是 32 位 hex: %q", token)
	}
	info := mustStat(t, filepath.Join(dir, "token"))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token 权限应当是 0600，实际 %o", info.Mode().Perm())
	}
	st2, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st2.Token() != token {
		t.Fatalf("重启换了 token: %s -> %s", token, st2.Token())
	}
}

// token 文件被写坏时重建，而不是拒绝启动：守护起不来比换个口令代价大得多。
func TestTokenFileRepaired(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("坏掉的内容"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !validToken(st.Token()) {
		t.Fatalf("坏 token 应当被重建，实际 %q", st.Token())
	}
}

// 重启后队列从磁盘重建，顺序按 id 稳定；目录里的杂物直接忽略。
func TestQueueRecoversFromDisk(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x01}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x02}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "queue", "README.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	st2, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st2.Queued() != 2 {
		t.Fatalf("重启后队列应当是 2，实际 %d", st2.Queued())
	}
	items := st2.Unpushed()
	if len(items) != 2 {
		t.Fatalf("重启后未推项应当是 2，实际 %d", len(items))
	}
	if items[0].Path >= items[1].Path {
		t.Fatalf("顺序不对: %s / %s", items[0].Path, items[1].Path)
	}
	if items[0].Bytes != 4 || items[0].Mime != "image/jpeg" {
		t.Fatalf("重建的元信息不对: %+v", items[0])
	}
}

// ack 是 queue → archive 的搬动，搬完两边目录都要对得上。
func TestAckMovesToArchive(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x01})
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Enqueue("image/png", []byte{0x89, 0x50, 0x4e, 0x47})
	if err != nil {
		t.Fatal(err)
	}
	if st.Delivered() != 0 {
		t.Fatalf("初始 delivered 应当是 0")
	}

	moved, err := st.Ack([]string{a.ID, "不存在的-id"})
	if err != nil {
		t.Fatal(err)
	}
	if moved != 1 {
		t.Fatalf("应当只搬动 1 个，实际 %d", moved)
	}
	if st.Queued() != 1 || st.Delivered() != 1 {
		t.Fatalf("计数不对: queued=%d delivered=%d", st.Queued(), st.Delivered())
	}
	if _, err := os.Stat(filepath.Join(st.queueDir(), filepath.Base(b.Path))); err != nil {
		t.Fatalf("没 ack 的图不该被搬走: %v", err)
	}
	days, err := os.ReadDir(filepath.Join(dir, "archive"))
	if err != nil || len(days) != 1 {
		t.Fatalf("归档应当按天建目录: %v %d", err, len(days))
	}
	mustStat(t, filepath.Join(dir, "archive", days[0].Name(), filepath.Base(a.Path)))

	// 重启后 delivered 计数从 archive 目录数出来
	st2, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st2.Delivered() != 1 || st2.Queued() != 1 {
		t.Fatalf("重启后计数不对: delivered=%d queued=%d", st2.Delivered(), st2.Queued())
	}
}

// 归档目录里已有同名文件时不覆盖、不删除：两份都留着（覆盖或删除都不可逆）。
func TestAckKeepsBothOnCollision(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	it, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x01})
	if err != nil {
		t.Fatal(err)
	}
	dayDir := filepath.Join(st.Root(), "archive", time.Now().Format("20060102"))
	if err := os.MkdirAll(dayDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dayDir, filepath.Base(it.Path)), []byte("先到"), 0o600); err != nil {
		t.Fatal(err)
	}
	moved, err := st.Ack([]string{it.ID})
	if err != nil || moved != 1 {
		t.Fatalf("ack: moved=%d err=%v", moved, err)
	}
	ents, err := os.ReadDir(dayDir)
	if err != nil || len(ents) != 2 {
		t.Fatalf("撞名之后两份都该在，实际 %d (%v)", len(ents), err)
	}
	kept, err := os.ReadFile(filepath.Join(dayDir, filepath.Base(it.Path)))
	if err != nil || string(kept) != "先到" {
		t.Fatalf("原有那份被改了: %q %v", kept, err)
	}
}
