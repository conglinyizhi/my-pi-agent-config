package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// seedFile 造一个「已经在磁盘上的旧图片」，用来测回收路径。
func seedFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte{0xff, 0xd8, 0xff, 0x00}, 0o600); err != nil {
		t.Fatal(err)
	}
}

// writeIndex 手写一份编号表。测分配/回收要精确控制时间与空号，
// 用接口灌数据反而排不出来。
func writeIndex(t *testing.T, root string, items ...*RefItem) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "refs"), 0o700); err != nil {
		t.Fatal(err)
	}
	buf, err := json.Marshal(indexFile{Items: items})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "refs", "index.json"), buf, 0o600); err != nil {
		t.Fatal(err)
	}
}

func refsOf(t *testing.T, st *Store) []int {
	t.Helper()
	out := []int{}
	for _, it := range st.Refs() {
		out = append(out, it.Ref)
	}
	return out
}

func mustRefs(t *testing.T, st *Store, want ...int) {
	t.Helper()
	got := refsOf(t, st)
	if len(got) != len(want) {
		t.Fatalf("编号表不对: 想要 %v，实际 %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("编号表不对: 想要 %v，实际 %v", want, got)
		}
	}
}

// token 只在首次启动生成，之后固定；文件 0600，内容 32 位 hex。
func TestTokenFileStableAndPrivate(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir, 99)
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
	st2, err := newStore(dir, 99)
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
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "token"), []byte("坏掉的内容"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir, 99)
	if err != nil {
		t.Fatal(err)
	}
	if !validToken(st.Token()) {
		t.Fatalf("坏 token 应当被重建，实际 %q", st.Token())
	}
}

// 池大小是硬约束：0 或负数没有意义，早点拒绝好过运行期算出个 0 号。
func TestPoolMustBePositive(t *testing.T) {
	for _, pool := range []int{0, -1} {
		if _, err := newStore(t.TempDir(), pool); err == nil {
			t.Fatalf("pool=%d 应当被拒绝", pool)
		}
	}
}

// 图片落在 archive/YYYYMMDD/ 下，0600；queue/ 那一套已经不建了。
func TestEnqueueLandsInArchive(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir, 99)
	if err != nil {
		t.Fatal(err)
	}
	it, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x01})
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(it.Path) {
		t.Fatalf("path 应当是绝对路径: %s", it.Path)
	}
	day := time.Now().Format("20060102")
	if want := filepath.Join(dir, "archive", day); filepath.Dir(it.Path) != want {
		t.Fatalf("落盘目录不对: %s，想要 %s", filepath.Dir(it.Path), want)
	}
	if info := mustStat(t, it.Path); info.Mode().Perm() != 0o600 || info.Size() != 4 {
		t.Fatalf("文件权限/大小不对: %o %d", info.Mode().Perm(), info.Size())
	}
	if it.Bytes != 4 || it.TS == "" {
		t.Fatalf("条目字段不对: %+v", it)
	}
	if _, err := time.Parse(time.RFC3339Nano, it.TS); err != nil {
		t.Fatalf("ts 不是 RFC3339: %q", it.TS)
	}
	if _, err := os.Stat(filepath.Join(dir, "queue")); !os.IsNotExist(err) {
		t.Fatalf("不该再建 queue 目录: %v", err)
	}
	if _, err := st.Enqueue("image/gif", []byte("GIF89a")); err != errUnknownMime {
		t.Fatalf("不支持的 mime 应当被拒: %v", err)
	}
	if _, err := st.Enqueue("image/jpeg", nil); err != errEmptyImage {
		t.Fatalf("空图应当被拒: %v", err)
	}
}

// 分配规则第一半：1..pool 里最小的空号优先。手工造出 2、4 两个号，
// 下一个该拿 1，再下一个该拿 3。
func TestAllocSmallestFreeRef(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "archive", "20250101", "a.jpg")
	b := filepath.Join(dir, "archive", "20250101", "b.jpg")
	seedFile(t, a)
	seedFile(t, b)
	writeIndex(t, dir,
		&RefItem{Ref: 2, Path: a, Bytes: 4, TS: "2025-01-01T00:00:01Z"},
		&RefItem{Ref: 4, Path: b, Bytes: 4, TS: "2025-01-01T00:00:02Z"},
	)
	st, err := newStore(dir, 99)
	if err != nil {
		t.Fatal(err)
	}
	mustRefs(t, st, 2, 4)

	one, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x01})
	if err != nil {
		t.Fatal(err)
	}
	if one.Ref != 1 {
		t.Fatalf("应当取最小空号 1，实际 %d", one.Ref)
	}
	three, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x02})
	if err != nil {
		t.Fatal(err)
	}
	if three.Ref != 3 {
		t.Fatalf("下一个空号应当是 3，实际 %d", three.Ref)
	}
	if st.Used() != 4 {
		t.Fatalf("已用号数应当是 4，实际 %d", st.Used())
	}
}

// 分配规则第二半：池满时回收 lastUsed 最早的那条；没有 lastUsed 就看 ts。
// 1 号入库最早，让给新图，但它的文件必须还在 archive 里。
func TestPoolFullEvictsEarliestTS(t *testing.T) {
	dir := t.TempDir()
	p1 := filepath.Join(dir, "archive", "20250101", "one.jpg")
	p2 := filepath.Join(dir, "archive", "20250101", "two.jpg")
	p3 := filepath.Join(dir, "archive", "20250101", "three.jpg")
	seedFile(t, p1)
	seedFile(t, p2)
	seedFile(t, p3)
	writeIndex(t, dir,
		&RefItem{Ref: 1, Path: p1, Bytes: 4, TS: "2025-01-01T00:00:01Z"},
		&RefItem{Ref: 2, Path: p2, Bytes: 4, TS: "2025-01-01T00:00:02Z"},
		&RefItem{Ref: 3, Path: p3, Bytes: 4, TS: "2025-01-01T00:00:03Z"},
	)
	st, err := newStore(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x09})
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref != 1 {
		t.Fatalf("该回收 1 号，实际 %d", got.Ref)
	}
	mustRefs(t, st, 1, 2, 3)
	if st.Used() != 3 {
		t.Fatalf("回收之后已用号数还是池子大小 3，实际 %d", st.Used())
	}
	if mustStat(t, p1).Size() != 4 {
		t.Fatal("原图不该被改")
	}
	cur, err := st.Get(1)
	if err != nil {
		t.Fatal(err)
	}
	if cur.Path == p1 {
		t.Fatal("1 号应当已经指向新图")
	}
	mustStat(t, cur.Path)

	// 回收是永久的：落盘之后旧路径不再出现在索引里
	buf, err := os.ReadFile(filepath.Join(dir, "refs", "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(buf), p1) {
		t.Fatalf("被回收的路径还在索引里: %s", buf)
	}
	if !strings.Contains(string(buf), p3) {
		t.Fatalf("不该被回收的路径丢了: %s", buf)
	}
}

// lastUsed 优先于 ts：1 号入库最早但刚被用过，该走的是 2 号。
func TestLastUsedBeatsTS(t *testing.T) {
	dir := t.TempDir()
	p1 := filepath.Join(dir, "archive", "20250101", "one.jpg")
	p2 := filepath.Join(dir, "archive", "20250101", "two.jpg")
	p3 := filepath.Join(dir, "archive", "20250101", "three.jpg")
	seedFile(t, p1)
	seedFile(t, p2)
	seedFile(t, p3)
	writeIndex(t, dir,
		&RefItem{Ref: 1, Path: p1, Bytes: 4, TS: "2025-01-01T00:00:01Z", LastUsed: "2025-01-01T00:00:09Z"},
		&RefItem{Ref: 2, Path: p2, Bytes: 4, TS: "2025-01-01T00:00:02Z"},
		&RefItem{Ref: 3, Path: p3, Bytes: 4, TS: "2025-01-01T00:00:03Z"},
	)
	st, err := newStore(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x09})
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref != 2 {
		t.Fatalf("该回收 2 号（ts 最早且没被用过），实际 %d", got.Ref)
	}
	mustStat(t, p2)
	if cur, err := st.Get(1); err != nil || cur.Path != p1 {
		t.Fatalf("刚用过的 1 号不该被回收: %+v %v", cur, err)
	}
}

// 走真实接口的回收路径：Touch 过的号在池满时被保住，没 Touch 的让号，
// 被回收的图片文件仍在 archive。
func TestTouchProtectsFromEviction(t *testing.T) {
	st, err := newStore(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x01})
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x02})
	if err != nil {
		t.Fatal(err)
	}
	if first.Ref != 1 || second.Ref != 2 {
		t.Fatalf("前两张应当是 1、2，实际 %d、%d", first.Ref, second.Ref)
	}
	used, err := st.Touch(1)
	if err != nil {
		t.Fatal(err)
	}
	if used.LastUsed == "" {
		t.Fatal("Touch 之后 lastUsed 应当有值")
	}
	if _, err := st.Touch(99); err != errNoRef {
		t.Fatalf("刷不存在的编号应当回 errNoRef: %v", err)
	}

	third, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x03})
	if err != nil {
		t.Fatal(err)
	}
	if third.Ref != 2 {
		t.Fatalf("该回收 2 号，实际 %d", third.Ref)
	}
	if cur, err := st.Get(1); err != nil || cur.Path != first.Path || cur.LastUsed == "" {
		t.Fatalf("1 号应当原样留着且带 lastUsed: %+v %v", cur, err)
	}
	mustStat(t, second.Path) // 回收不删文件
	if st.Used() != 2 {
		t.Fatalf("池子大小是 2，已用号数应当是 2，实际 %d", st.Used())
	}
}

// 重启后编号表从 index.json 恢复：编号、路径、时间、lastUsed 都不变。
func TestRefsRecoverFromDisk(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir, 5)
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
	used, err := st.Touch(2)
	if err != nil {
		t.Fatal(err)
	}

	st2, err := newStore(dir, 5)
	if err != nil {
		t.Fatal(err)
	}
	mustRefs(t, st2, 1, 2)
	got, err := st2.Get(1)
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != a.Path || got.Bytes != a.Bytes || got.TS != a.TS {
		t.Fatalf("1 号恢复得不对:\n got %+v\nwant %+v", got, a)
	}
	got2, err := st2.Get(2)
	if err != nil {
		t.Fatal(err)
	}
	if got2.Path != b.Path || got2.TS != b.TS {
		t.Fatalf("2 号恢复得不对: %+v", got2)
	}
	if got2.LastUsed != used.LastUsed || got2.LastUsed == "" {
		t.Fatalf("lastUsed 没恢复: %q vs %q", got2.LastUsed, used.LastUsed)
	}
	if st2.Used() != 2 {
		t.Fatalf("恢复后已用号数应当是 2，实际 %d", st2.Used())
	}
	// 恢复之后接着分配，不会撞上已有的号
	next, err := st2.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x03})
	if err != nil {
		t.Fatal(err)
	}
	if next.Ref != 3 {
		t.Fatalf("恢复后该继续拿 3 号，实际 %d", next.Ref)
	}
}

// 写盘是「临时文件 + rename」：不能留下半截文件，index.json 任何时刻都是完整 JSON。
func TestIndexWriteIsAtomic(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir, 9)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Enqueue("image/jpeg", []byte{0xff, 0xd8, 0xff, 0x01}); err != nil {
		t.Fatal(err)
	}
	ents, err := os.ReadDir(filepath.Join(dir, "refs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if e.Name() != "index.json" {
			t.Fatalf("refs/ 里只该有 index.json，实际还有 %s", e.Name())
		}
	}
	info := mustStat(t, filepath.Join(dir, "refs", "index.json"))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("索引权限应当是 0600，实际 %o", info.Mode().Perm())
	}
	buf, err := os.ReadFile(filepath.Join(dir, "refs", "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	var idx indexFile
	if err := json.Unmarshal(buf, &idx); err != nil {
		t.Fatalf("索引不是合法 JSON: %v (%s)", err, buf)
	}
	if len(idx.Items) != 1 || idx.Items[0].Ref != 1 {
		t.Fatalf("索引内容不对: %s", buf)
	}
}

// index.json 坏掉时不让守护起不来，但也不能装作没这回事：改名留档再空表起。
func TestBrokenIndexKeptAside(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "refs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "refs", "index.json"), []byte("{不是 json"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir, 99)
	if err != nil {
		t.Fatalf("坏索引不该挡住启动: %v", err)
	}
	if st.Used() != 0 {
		t.Fatalf("坏索引应当按空表起，实际 %d 条", st.Used())
	}
	ents, err := os.ReadDir(filepath.Join(dir, "refs"))
	if err != nil {
		t.Fatal(err)
	}
	kept := false
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "index.json.bad-") {
			kept = true
		}
	}
	if !kept {
		t.Fatalf("坏索引应当改名留档，实际目录里是 %v", ents)
	}
}
