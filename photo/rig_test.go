package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// rig 是一套测试装置：临时 state 目录 + httptest 上的 HTTP。
// 端口由 httptest 随机分配，不碰真实端口，也不碰用户的 ~/.pi。
type rig struct {
	t  *testing.T
	st *Store
	ts *httptest.Server
}

func newRig(t *testing.T) *rig { return newRigPool(t, 99) }

func newRigPool(t *testing.T, pool int) *rig {
	t.Helper()
	st, err := newStore(t.TempDir(), pool)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(newAPI(st).handler())
	t.Cleanup(ts.Close)
	return &rig{t: t, st: st, ts: ts}
}

func (r *rig) token() string { return r.st.Token() }

func (r *rig) get(path, key string) (*http.Response, []byte) {
	r.t.Helper()
	resp, err := http.Get(r.ts.URL + path + "?k=" + key)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func (r *rig) post(path, key string, body any) (*http.Response, []byte) {
	r.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			r.t.Fatal(err)
		}
	}
	resp, err := http.Post(r.ts.URL+path+"?k="+key, "application/json", &buf)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// decode 把回执解成结构体；解不出来就是契约破了，直接挂。
func decode[T any](t *testing.T, body []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("回执不是预期的 JSON: %v (%s)", err, body)
	}
	return v
}

// upload 走真实 HTTP 上传，回解好的回执。
func (r *rig) upload(imgs ...uploadImage) uploadResp {
	r.t.Helper()
	resp, body := r.post("/upload", r.token(), uploadReq{Images: imgs})
	if resp.StatusCode != http.StatusOK {
		r.t.Fatalf("upload 状态码 %d: %s", resp.StatusCode, body)
	}
	return decode[uploadResp](r.t, body)
}

func (r *rig) refs() refsResp {
	r.t.Helper()
	resp, body := r.get("/refs", r.token())
	if resp.StatusCode != http.StatusOK {
		r.t.Fatalf("refs 状态码 %d: %s", resp.StatusCode, body)
	}
	return decode[refsResp](r.t, body)
}

func (r *rig) status() statusResp {
	r.t.Helper()
	resp, body := r.get("/status", r.token())
	if resp.StatusCode != http.StatusOK {
		r.t.Fatalf("status 状态码 %d: %s", resp.StatusCode, body)
	}
	return decode[statusResp](r.t, body)
}

func jpegImage(name string, n int) uploadImage {
	return uploadImage{Name: name, DataURL: jpegDataURL(n)}
}

func jpegDataURL(n int) string {
	data := make([]byte, 0, n+3)
	data = append(data, 0xff, 0xd8, 0xff)
	for len(data) < n {
		data = append(data, 0xe0)
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data[:n])
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info
}
