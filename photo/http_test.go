package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 所有 HTTP 接口共用 ?k=<token>：口令不对一律 401，且不回任何实质内容。
func TestTokenRequired(t *testing.T) {
	r := newRig(t)

	cases := []struct {
		name   string
		method string
		path   string
		key    string
	}{
		{"页面无口令", http.MethodGet, "/", ""},
		{"页面口令错", http.MethodGet, "/", "deadbeef"},
		{"状态无口令", http.MethodGet, "/status", ""},
		{"状态口令错", http.MethodGet, "/status", "deadbeef"},
		{"上传口令错", http.MethodPost, "/upload", "deadbeef"},
		{"编号表口令错", http.MethodGet, "/refs", "deadbeef"},
		{"单号口令错", http.MethodGet, "/refs/1", "deadbeef"},
		{"标记使用口令错", http.MethodPost, "/refs/1/use", "deadbeef"},
		// 管理页与删除是新增的两个入口：口令没对上时，来源是不是回环都不重要，
		// 一律 401，且不许先回 403 把「这个路径存在」告诉对方。
		{"管理页无口令", http.MethodGet, "/manage", ""},
		{"管理页口令错", http.MethodGet, "/manage", "deadbeef"},
		{"原图无口令", http.MethodGet, "/refs/1/raw", ""},
		{"原图口令错", http.MethodGet, "/refs/1/raw", "deadbeef"},
		{"删除无口令", http.MethodPost, "/refs/1/delete", ""},
		{"删除口令错", http.MethodPost, "/refs/1/delete", "deadbeef"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var resp *http.Response
			var body []byte
			if tc.method == http.MethodGet {
				resp, body = r.get(tc.path, tc.key)
			} else {
				resp, body = r.post(tc.path, tc.key, uploadReq{Images: []uploadImage{jpegImage("a.jpg", 64)}})
			}
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("想要 401，实际 %d: %s", resp.StatusCode, body)
			}
			if strings.Contains(string(body), r.token()) {
				t.Fatalf("401 回显里带上了 token: %s", body)
			}
		})
	}
	if r.st.Used() != 0 {
		t.Fatalf("未授权请求不该落盘占号，实际占了 %d 个", r.st.Used())
	}

	if resp, body := r.get("/", r.token()); resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "发给 pi") {
		t.Fatalf("带对口令应当拿到页面: %d %s", resp.StatusCode, body[:min(len(body), 120)])
	}
}

// 任何回执里都不能出现 token：手机手里已经有它，回显只是白白多一份副本。
func TestResponsesDoNotLeakToken(t *testing.T) {
	r := newRig(t)
	if _, body := r.get("/status", r.token()); strings.Contains(string(body), r.token()) {
		t.Fatalf("status 回显里带上了 token: %s", body)
	}
	if _, body := r.get("/refs", r.token()); strings.Contains(string(body), r.token()) {
		t.Fatalf("refs 回显里带上了 token: %s", body)
	}
	// 管理页是 HTML，token 只从地址栏的 ?k= 读，不内联进页面
	if _, body := r.get("/manage", r.token()); strings.Contains(string(body), r.token()) {
		t.Fatalf("管理页里带上了 token: %s", body)
	}
	r.upload(jpegImage("a.jpg", 64))
	if _, body := r.post("/upload", r.token(), uploadReq{Images: []uploadImage{jpegImage("b.jpg", 64)}}); strings.Contains(string(body), r.token()) {
		t.Fatalf("upload 回显里带上了 token: %s", body)
	}
}

func TestUploadRejectsBadImages(t *testing.T) {
	r := newRig(t)
	out := r.upload(
		uploadImage{Name: "no-prefix.jpg", DataURL: "just-bytes"},
		uploadImage{Name: "not-base64.jpg", DataURL: "data:image/jpeg;base64,!!!!"},
		uploadImage{Name: "text.png", DataURL: "data:text/plain;base64,aGk="},
	)
	if len(out.Saved) != 0 || out.Rejected != 3 {
		t.Fatalf("回执不对: %+v", out)
	}
	if r.st.Used() != 0 {
		t.Fatalf("被拒的图不该占号，实际占了 %d 个", r.st.Used())
	}
}

// 页面永远发 JPEG；png/webp 也收，是为了别人手搓请求时不至于默默丢图。
func TestUploadAcceptsPngAndWebp(t *testing.T) {
	r := newRig(t)
	out := r.upload(
		uploadImage{Name: "a.png", DataURL: "data:image/png;base64,iVBORw0KGgo="},
		uploadImage{Name: "b.webp", DataURL: "data:image/webp;base64,UklGRg=="},
	)
	if len(out.Saved) != 2 || out.Rejected != 0 {
		t.Fatalf("回执不对: %+v", out)
	}
	if !strings.HasSuffix(out.Saved[0].Path, ".png") || !strings.HasSuffix(out.Saved[1].Path, ".webp") {
		t.Fatalf("扩展名没按类型落: %+v", out.Saved)
	}
	if out.Saved[0].Bytes != 8 || out.Saved[1].Bytes != 4 {
		t.Fatalf("字节数不对: %+v", out.Saved)
	}
	mustStat(t, out.Saved[0].Path)
	mustStat(t, out.Saved[1].Path)
}

// 连续上传拿到 1、2、3；回执里的 path 就是真正落盘的位置。
func TestUploadAssignsSequentialRefs(t *testing.T) {
	r := newRig(t)
	out := r.upload(
		jpegImage("a.jpg", 64),
		jpegImage("b.jpg", 96),
		jpegImage("c.jpg", 128),
	)
	if out.Rejected != 0 {
		t.Fatalf("不该有被拒的: %+v", out)
	}
	want := []int{1, 2, 3}
	if len(out.Saved) != len(want) {
		t.Fatalf("存了 %d 张，想要 %d", len(out.Saved), len(want))
	}
	for i, ref := range want {
		if out.Saved[i].Ref != ref {
			t.Fatalf("第 %d 张应当拿 %d 号，实际 %d", i+1, ref, out.Saved[i].Ref)
		}
		info := mustStat(t, out.Saved[i].Path)
		if info.Size() != out.Saved[i].Bytes {
			t.Fatalf("%s 字节数对不上: %d vs %d", out.Saved[i].Path, info.Size(), out.Saved[i].Bytes)
		}
		if !filepath.IsAbs(out.Saved[i].Path) {
			t.Fatalf("path 应当是绝对路径: %s", out.Saved[i].Path)
		}
		if !strings.HasPrefix(filepath.Base(out.Saved[i].Path), "") || filepath.Ext(out.Saved[i].Path) != ".jpg" {
			t.Fatalf("文件名不对: %s", out.Saved[i].Path)
		}
	}
	day := time.Now().Format("20060102")
	if want := filepath.Join(r.st.Root(), "archive", day); filepath.Dir(out.Saved[0].Path) != want {
		t.Fatalf("落盘目录不对: %s", filepath.Dir(out.Saved[0].Path))
	}
}

// /refs 按编号升序，字段与契约一致，ts 是 RFC3339。
func TestRefsSortedAscendingWithFields(t *testing.T) {
	r := newRig(t)
	r.upload(jpegImage("a.jpg", 64), jpegImage("b.jpg", 96))
	out := r.refs()
	if out.Pool != 99 || len(out.Items) != 2 {
		t.Fatalf("refs 回执不对: %+v", out)
	}
	if out.Items[0].Ref != 1 || out.Items[1].Ref != 2 {
		t.Fatalf("顺序不对: %+v", out.Items)
	}
	for _, it := range out.Items {
		if it.Path == "" || it.Bytes == 0 || it.TS == "" {
			t.Fatalf("字段不全: %+v", it)
		}
		if _, err := time.Parse(time.RFC3339Nano, it.TS); err != nil {
			t.Fatalf("ts 不是 RFC3339: %q", it.TS)
		}
		if it.LastUsed != "" {
			t.Fatalf("没标记过使用，不该有 lastUsed: %+v", it)
		}
	}
}

func TestRefGetAndNotFound(t *testing.T) {
	r := newRig(t)
	saved := r.upload(jpegImage("a.jpg", 64)).Saved[0]

	resp, body := r.get("/refs/1", r.token())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("取单号状态码 %d: %s", resp.StatusCode, body)
	}
	got := decode[RefItem](t, body)
	if got.Ref != 1 || got.Path != saved.Path || got.Bytes != saved.Bytes {
		t.Fatalf("单号内容不对: %+v", got)
	}

	for _, path := range []string{"/refs/2", "/refs/0", "/refs/abc", "/refs/-1"} {
		resp, body = r.get(path, r.token())
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s 想要 404，实际 %d: %s", path, resp.StatusCode, body)
		}
		out := decode[map[string]any](t, body)
		if out["error"] == nil || out["error"] == "" {
			t.Fatalf("%s 的 404 回执没有 error: %s", path, body)
		}
	}
}

// POST /refs/<n>/use 把 lastUsed 刷成当下，并落盘。
func TestRefUseRefreshesLastUsed(t *testing.T) {
	r := newRig(t)
	r.upload(jpegImage("a.jpg", 64), jpegImage("b.jpg", 96))

	resp, body := r.post("/refs/2/use", r.token(), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("use 状态码 %d: %s", resp.StatusCode, body)
	}
	out := decode[map[string]any](t, body)
	if out["ok"] != true {
		t.Fatalf("use 回执不对: %s", body)
	}
	item := r.refs().Items[1]
	if item.LastUsed == "" {
		t.Fatal("use 之后 lastUsed 应当有值")
	}
	if _, err := time.Parse(time.RFC3339Nano, item.LastUsed); err != nil {
		t.Fatalf("lastUsed 不是 RFC3339: %q", item.LastUsed)
	}
	// 重启之后 lastUsed 还在（它决定回收顺序，只在内存里记等于没记）
	st2, err := newStore(r.st.Root(), 99)
	if err != nil {
		t.Fatal(err)
	}
	again, err := st2.Get(2)
	if err != nil {
		t.Fatal(err)
	}
	if again.LastUsed != item.LastUsed {
		t.Fatalf("lastUsed 没落盘: %q vs %q", again.LastUsed, item.LastUsed)
	}

	resp, body = r.post("/refs/9/use", r.token(), nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("刷不存在的号想要 404，实际 %d: %s", resp.StatusCode, body)
	}
}

func TestStatusReportsPoolAndUsed(t *testing.T) {
	r := newRigPool(t, 3)
	if got := r.status(); got.Pool != 3 || got.Used != 0 {
		t.Fatalf("初始 status 不对: %+v", got)
	}
	r.upload(jpegImage("a.jpg", 64), jpegImage("b.jpg", 64))
	if got := r.status(); got.Pool != 3 || got.Used != 2 {
		t.Fatalf("上传后 status 不对: %+v", got)
	}
	if _, body := r.get("/status", r.token()); strings.Contains(string(body), "listener") {
		t.Fatalf("锁没了，status 不该再有 listener: %s", body)
	}
}

// 池满回收走完整 HTTP 路径：use 过的那张留住，早入库的让号，文件仍在 archive。
func TestPoolFullEvictsOldestViaHTTP(t *testing.T) {
	r := newRigPool(t, 3)
	saved := r.upload(jpegImage("a.jpg", 64), jpegImage("b.jpg", 64), jpegImage("c.jpg", 64)).Saved
	if saved[0].Ref != 1 || saved[2].Ref != 3 {
		t.Fatalf("前三张编号不对: %+v", saved)
	}
	if resp, body := r.post("/refs/2/use", r.token(), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("use: %d %s", resp.StatusCode, body)
	}
	out := r.upload(jpegImage("d.jpg", 64))
	if len(out.Saved) != 1 || out.Saved[0].Ref != 1 {
		t.Fatalf("该回收 1 号给新图，实际 %+v", out.Saved)
	}
	if _, err := os.Stat(saved[0].Path); err != nil {
		t.Fatalf("回收不该删文件（%s）: %v", saved[0].Path, err)
	}
	items := r.refs().Items
	if len(items) != 3 || items[0].Path != out.Saved[0].Path {
		t.Fatalf("回收后编号表不对: %+v", items)
	}
	if items[1].Path != saved[1].Path || items[2].Path != saved[2].Path {
		t.Fatalf("被 use 的号不该动: %+v", items)
	}
	if items[1].LastUsed == "" {
		t.Fatalf("use 过的号该留 lastUsed: %+v", items[1])
	}
}

// 页面不再有锁状态与「结束这一轮」，但相机唤起、多选、压缩、编号展示都还在。
func TestPageDropsLockUI(t *testing.T) {
	r := newRig(t)
	_, body := r.get("/", r.token())
	page := string(body)
	for _, want := range []string{"capture=\"environment\"", "multiple", "imageOrientation", "MAX = 1600", "已存为", "&amp;img(3)", "/refs"} {
		if !strings.Contains(page, want) {
			t.Fatalf("页面里缺 %q", want)
		}
	}
	for _, gone := range []string{"/finish", "结束这一轮", "listener", "接单"} {
		if strings.Contains(page, gone) {
			t.Fatalf("页面里还留着 %q", gone)
		}
	}
}
