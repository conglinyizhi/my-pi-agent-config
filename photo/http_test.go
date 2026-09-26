package main

import (
	"net/http"
	"strings"
	"testing"
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
		{"结束口令错", http.MethodPost, "/finish", "deadbeef"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var resp *http.Response
			var body []byte
			if tc.method == http.MethodGet {
				resp, body = r.get(tc.path, tc.key)
			} else {
				resp, body = r.post(tc.path, tc.key, nil)
			}
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("想要 401，实际 %d: %s", resp.StatusCode, body)
			}
			if strings.Contains(string(body), r.token()) {
				t.Fatalf("401 回显里带上了 token: %s", body)
			}
			if tc.path == "/upload" || tc.path == "/finish" {
				if r.st.Queued() != 0 {
					t.Fatalf("未授权请求不该落盘，队列里有 %d 张", r.st.Queued())
				}
			}
		})
	}

	if resp, body := r.get("/", r.token()); resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "发给 pi") {
		t.Fatalf("带对口令应当拿到页面: %d %s", resp.StatusCode, body[:min(len(body), 120)])
	}
}

// /status 不能下发 token：状态行是给手机看的，手机不需要新口令。
func TestStatusDoesNotLeakToken(t *testing.T) {
	r := newRig(t)
	resp, body := r.get("/status", r.token())
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if strings.Contains(string(body), r.token()) {
		t.Fatalf("status 回显里带上了 token: %s", body)
	}
	if strings.Contains(string(body), r.srv.socketPath) {
		t.Fatalf("status 不该暴露 socket 路径: %s", body)
	}
}

func TestUploadRejectsBadImages(t *testing.T) {
	r := newRig(t)
	out := r.upload(
		uploadImage{Name: "no-prefix.jpg", DataURL: "just-bytes"},
		uploadImage{Name: "not-base64.jpg", DataURL: "data:image/jpeg;base64,!!!!"},
		uploadImage{Name: "text.png", DataURL: "data:text/plain;base64,aGk="},
	)
	if out["accepted"] != float64(0) || out["rejected"] != float64(3) {
		t.Fatalf("回执不对: %+v", out)
	}
	if r.st.Queued() != 0 {
		t.Fatalf("队列应当为空，实际 %d", r.st.Queued())
	}
	if _, queued, _ := r.status(); queued != 0 {
		t.Fatalf("status.queued 应当是 0，实际 %d", queued)
	}
}

// 页面永远发 JPEG；png/webp 也收，是为了别人手搓请求时不至于默默丢图。
func TestUploadAcceptsPngAndWebp(t *testing.T) {
	r := newRig(t)
	out := r.upload(
		uploadImage{Name: "a.png", DataURL: "data:image/png;base64,iVBORw0KGgo="},
		uploadImage{Name: "b.webp", DataURL: "data:image/webp;base64,UklGRg=="},
	)
	if out["accepted"] != float64(2) || out["queued"] != float64(2) {
		t.Fatalf("回执不对: %+v", out)
	}
	items := r.st.Unpushed()
	if len(items) != 2 || items[0].Mime != "image/png" || items[1].Mime != "image/webp" {
		t.Fatalf("落盘 mime 不对: %+v", items)
	}
	if r.st.Queued() != 2 {
		t.Fatalf("队列 %d", r.st.Queued())
	}
}
