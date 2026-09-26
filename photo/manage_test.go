package main

import (
	"bytes"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// 管理页只给主机本机开：回环来源放行，局域网来源 403 且不回页面内容。
// 分流只看 TCP 对端地址，所以这里直接伪造 RemoteAddr 把两类来源都过一遍。
func TestManageLoopbackOnly(t *testing.T) {
	r := newRig(t)
	r.upload(jpegImage("a.jpg", 64))
	const pageMark = "照片管理"

	// 真实 httptest.Server 就是从 127.0.0.1 连过来的，本机访问这条路必须先通
	resp, body := r.get("/manage", r.token())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("回环访问 /manage 想要 200，实际 %d: %s", resp.StatusCode, body)
	}
	page := string(body)
	for _, want := range []string{
		pageMark,
		"/refs/", "/raw", "/delete", // 缩略图、大图、删除三个动作都得在页面上
		"confirm(", // 删除前必须先问
		"编号池", "已用", "归档目录", "本页只在主机本机",
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("管理页里缺 %q", want)
		}
	}
	// 归档目录是服务端填进去的，页面得让人能对上磁盘上的位置
	if !strings.Contains(page, filepath.Join(r.st.Root(), "archive")) {
		t.Fatalf("管理页没填归档目录: %s", page[:min(len(page), 200)])
	}
	if !strings.Contains(page, "location.search") {
		t.Fatal("管理页应当从地址栏读口令，不内联 token")
	}

	cases := []struct {
		name   string
		remote string
		want   int
	}{
		{"ipv4 回环", "127.0.0.1:54321", http.StatusOK},
		{"ipv4 回环无端口", "127.0.0.1", http.StatusOK},
		{"ipv6 回环", "[::1]:54321", http.StatusOK},
		// 监听落在双栈 [::] 上时，IPv4 客户端的来源地址常是 v4-mapped v6 形式，
		// 这几种写法都得按同一个意思判
		{"v4-mapped 回环", "[::ffff:127.0.0.1]:54321", http.StatusOK},
		{"v4-mapped 局域网", "[::ffff:192.168.1.20]:54321", http.StatusForbidden},
		{"局域网 v4", "192.168.1.20:54321", http.StatusForbidden},
		{"局域网 v4 另一段", "10.0.0.5:1", http.StatusForbidden},
		{"局域网 v6", "[fd00::1]:1", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, body := r.getFrom(tc.remote, "/manage", r.token())
			if resp.StatusCode != tc.want {
				t.Fatalf("来源 %s 想要 %d，实际 %d: %s", tc.remote, tc.want, resp.StatusCode, body)
			}
			if tc.want == http.StatusForbidden {
				// 403 只回一句话，页面一个字节都不能漏出去
				if !strings.Contains(string(body), "只能在主机本机") {
					t.Fatalf("403 正文该说明原因，实际: %s", body)
				}
				if strings.Contains(string(body), pageMark) {
					t.Fatalf("403 不该回页面内容: %s", body)
				}
				return
			}
			if !strings.Contains(string(body), pageMark) {
				t.Fatalf("回环来源该拿到页面: %s", body[:min(len(body), 200)])
			}
		})
	}

	// 口令不对时不分来源：非回环也不能因为「口令错」先吃 403，那等于告诉对方路径存在
	if resp, body := r.getFrom("192.168.1.20:54321", "/manage", "deadbeef"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("非回环 + 错口令想要 401，实际 %d: %s", resp.StatusCode, body)
	}
	if resp, body := r.getFrom("127.0.0.1:5432", "/manage", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无口令想要 401，实际 %d: %s", resp.StatusCode, body)
	}
}

// /refs/<n>/raw 按扩展名给 Content-Type，回的字节与上传的一模一样；
// 表里没这个号或文件不在都 404。这一路不限回环。
func TestRefRawServesImageBytes(t *testing.T) {
	r := newRig(t)
	const jpegLen = 64
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	webp := []byte("RIFF\x00\x00\x00\x00WEBP")
	saved := r.upload(
		jpegImage("a.jpg", jpegLen),
		uploadImage{Name: "b.png", DataURL: dataURL("image/png", png)},
		uploadImage{Name: "c.webp", DataURL: dataURL("image/webp", webp)},
	).Saved
	if len(saved) != 3 {
		t.Fatalf("前置上传没成功: %+v", saved)
	}

	cases := []struct {
		name string
		ref  int
		ct   string
		want []byte
	}{
		{"jpeg", 1, "image/jpeg", jpegBytes(jpegLen)},
		{"png", 2, "image/png", png},
		{"webp", 3, "image/webp", webp},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, body := r.get("/refs/"+strconv.Itoa(tc.ref)+"/raw", r.token())
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("raw 想要 200，实际 %d: %s", resp.StatusCode, body)
			}
			if ct := resp.Header.Get("Content-Type"); ct != tc.ct {
				t.Fatalf("Content-Type 想要 %s，实际 %s", tc.ct, ct)
			}
			if !bytes.Equal(body, tc.want) {
				t.Fatalf("回的字节不对: %d 字节 vs 想要 %d 字节", len(body), len(tc.want))
			}
		})
	}

	// 手机那边也要能取图（上传页的缩略图列表就在用），所以非回环来源照回
	resp, body := r.getFrom("192.168.1.20:54321", "/refs/1/raw", r.token())
	if resp.StatusCode != http.StatusOK || !bytes.Equal(body, jpegBytes(jpegLen)) {
		t.Fatalf("raw 不该限回环: %d %d 字节", resp.StatusCode, len(body))
	}

	for _, path := range []string{"/refs/9/raw", "/refs/0/raw", "/refs/abc/raw", "/refs/-1/raw"} {
		resp, body := r.get(path, r.token())
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s 想要 404，实际 %d: %s", path, resp.StatusCode, body)
		}
		out := decode[map[string]any](t, body)
		if out["error"] == nil || out["error"] == "" {
			t.Fatalf("%s 的 404 回执没有 error: %s", path, body)
		}
	}

	// 表里有、磁盘上没有：取图的一侧也是 404，但表不动（raw 是只读的）
	if err := os.Remove(saved[0].Path); err != nil {
		t.Fatal(err)
	}
	if resp, body := r.get("/refs/1/raw", r.token()); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("文件不在想要 404，实际 %d: %s", resp.StatusCode, body)
	}
	if items := r.refs().Items; len(items) != 3 || items[0].Ref != 1 {
		t.Fatalf("raw 不该改编号表: %+v", items)
	}

	// GET 不能带出删除语义：非 POST 的方法落到 "/" 这个兜底路由上，等于这个路径只认 POST，
	// 文件与编号表都得原封不动。
	if resp, body := r.get("/refs/2/delete", r.token()); resp.StatusCode < 400 {
		t.Fatalf("GET 删除不该成功，实际 %d: %s", resp.StatusCode, body)
	}
	if items := r.refs().Items; len(items) != 3 || items[1].Path != saved[1].Path {
		t.Fatalf("GET 删除不该动编号表: %+v", items)
	}
	mustStat(t, saved[1].Path)
}

// 删除：文件从磁盘消失、编号从表里摘掉并还回池子，之后上传会重用这个号。
func TestRefDeleteFreesRefAndFile(t *testing.T) {
	r := newRig(t)
	saved := r.upload(jpegImage("a.jpg", 64), jpegImage("b.jpg", 96)).Saved

	// 口令不对就什么都不该发生
	resp, body := r.post("/refs/1/delete", "deadbeef", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("错口令删除想要 401，实际 %d: %s", resp.StatusCode, body)
	}
	mustStat(t, saved[0].Path)
	if r.st.Used() != 2 {
		t.Fatalf("未授权删除不该动编号表，实际用了 %d 个号", r.st.Used())
	}

	resp, body = r.post("/refs/1/delete", r.token(), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("删除想要 200，实际 %d: %s", resp.StatusCode, body)
	}
	out := decode[map[string]any](t, body)
	if out["ok"] != true || out["ref"] != float64(1) {
		t.Fatalf("删除回执不对: %s", body)
	}
	if _, err := os.Stat(saved[0].Path); !os.IsNotExist(err) {
		t.Fatalf("文件该被删掉，stat 得到: %v", err)
	}
	mustStat(t, saved[1].Path) // 只删点名的那个号
	items := r.refs().Items
	if len(items) != 1 || items[0].Ref != 2 || items[0].Path != saved[1].Path {
		t.Fatalf("编号表不对: %+v", items)
	}
	if got := r.status(); got.Used != 1 || got.Pool != 99 {
		t.Fatalf("status 不对: %+v", got)
	}
	// 索引是唯一事实来源，删了必须落盘，重启不能又冒出来
	st2, err := newStore(r.st.Root(), 99)
	if err != nil {
		t.Fatal(err)
	}
	if got := refsOf(t, st2); len(got) != 1 || got[0] != 2 {
		t.Fatalf("删除没落盘，重启后编号表是 %v", got)
	}

	// 重复删除 404：1 号已经不在表里了
	resp, body = r.post("/refs/1/delete", r.token(), nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("重复删除想要 404，实际 %d: %s", resp.StatusCode, body)
	}
	if out := decode[map[string]any](t, body); out["error"] == nil || out["error"] == "" {
		t.Fatalf("404 回执没有 error: %s", body)
	}
	// 编号非法一律当不存在
	if resp, _ := r.post("/refs/abc/delete", r.token(), nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("非法编号想要 404，实际 %d", resp.StatusCode)
	}

	// 释放出来的号会被下次上传重用，而且是新文件
	again := r.upload(jpegImage("c.jpg", 128)).Saved[0]
	if again.Ref != 1 {
		t.Fatalf("删掉的 1 号该被重用，实际拿到 %d", again.Ref)
	}
	if again.Path == saved[0].Path {
		t.Fatalf("重用的 1 号还指着刚删掉的文件: %s", again.Path)
	}
	mustStat(t, again.Path)

	// 表里有、文件已不在：同样 404，但号也要还回池子（那条记录已经是空壳）
	if err := os.Remove(saved[1].Path); err != nil {
		t.Fatal(err)
	}
	if resp, body := r.post("/refs/2/delete", r.token(), nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("文件已不在想要 404，实际 %d: %s", resp.StatusCode, body)
	}
	if got := refsOf(t, r.st); len(got) != 1 || got[0] != 1 {
		t.Fatalf("文件不在时也该释放编号，实际编号表 %v", got)
	}
}

// 删除真失败（权限/忙等）回 500，并且不动编号表：文件没删掉，记录不该先丢。
// 这里用「把文件换成非空目录」造失败，不依赖跑测试的用户有没有权限。
func TestRefDeleteFailureKeepsEntry(t *testing.T) {
	r := newRig(t)
	saved := r.upload(jpegImage("a.jpg", 64)).Saved[0]
	if err := os.Remove(saved.Path); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(saved.Path, "child"), 0o700); err != nil {
		t.Fatal(err)
	}

	resp, body := r.post("/refs/1/delete", r.token(), nil)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("删除失败想要 500，实际 %d: %s", resp.StatusCode, body)
	}
	out := decode[map[string]any](t, body)
	if out["error"] == nil || out["error"] == "" {
		t.Fatalf("500 回执没有原因: %s", body)
	}
	if items := r.refs().Items; len(items) != 1 || items[0].Ref != 1 {
		t.Fatalf("删除失败时编号表不该动: %+v", items)
	}
}

// 删除只能删编号表里指向的那个文件：表是磁盘上的文件，手改过就可能指向 archive 外的
// 东西，删除不可逆，这种记录一律拒绝而不是照着删。
func TestDeleteRefusesPathOutsideArchive(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "keep.jpg")
	seedFile(t, outside)
	writeIndex(t, dir, &RefItem{Ref: 1, Path: outside, Bytes: 4, TS: "2025-01-01T00:00:00Z"})
	st, err := newStore(dir, 9)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := st.Delete(1); !errors.Is(err, errOutside) {
		t.Fatalf("越界路径应当回 errOutside，实际 %v", err)
	}
	mustStat(t, outside) // 目录外的文件必须一个字节都没动
	if st.Used() != 1 {
		t.Fatalf("拒绝删除时编号表不该动，实际 %d 条", st.Used())
	}
	if _, err := st.Delete(2); !errors.Is(err, errNoRef) {
		t.Fatalf("不存在的编号应当回 errNoRef，实际 %v", err)
	}

	// 在 state 里但不在 archive 里（比如编号表自己、或者 state 目录本身）也不行：
	// 那不是「这个号的图」
	for _, path := range []string{filepath.Join(dir, "refs", "index.json"), dir} {
		st.items[3] = &RefItem{Ref: 3, Path: path, Bytes: 1, TS: "2025-01-01T00:00:00Z"}
		if _, err := st.Delete(3); !errors.Is(err, errOutside) {
			t.Fatalf("路径 %s 应当被拒，实际 %v", path, err)
		}
	}
	mustStat(t, filepath.Join(dir, "refs", "index.json"))
	mustStat(t, dir)
}
