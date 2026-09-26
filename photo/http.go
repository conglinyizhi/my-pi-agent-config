package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// maxUploadBytes 是请求体总量的上限。页面压完一张不到 1MB，这里是防呆：
// 没有上限的话，同一个 wifi 里任何一个请求都能把内存吃干净。
const maxUploadBytes = 64 << 20

type uploadReq struct {
	Images []uploadImage `json:"images"`
}

type uploadImage struct {
	Name    string `json:"name"`
	DataURL string `json:"dataUrl"`
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/upload", s.handleUpload)
	mux.HandleFunc("/finish", s.handleFinish)
	return mux
}

// authorized 校验 ?k=<token>。用常数时间比较：token 是打印出来贴给手机的口令，
// 常规比较下响应时间会漏信息，虽然这条路上本来也没多大威胁，但没有成本就不留。
func (s *Server) authorized(r *http.Request) bool {
	k := r.URL.Query().Get("k")
	if k == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(k), []byte(s.st.Token())) == 1
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if !s.authorized(r) {
		unauthorized(w)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(pageHTML)
}

// handleStatus 是页面状态行的数据源。这里只回锁的摘要与两个计数，
// token 一个字节都不出去：状态行是给手机看的，手机不需要拿新口令。
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		unauthorized(w)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"listener":  s.listener(),
		"queued":    s.st.Queued(),
		"delivered": s.st.Delivered(),
	})
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		unauthorized(w)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	var req uploadReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON: " + err.Error()})
		return
	}
	accepted, rejected := 0, 0
	ids := make([]string, 0, len(req.Images))
	for _, img := range req.Images {
		mime, data, err := parseDataURL(img.DataURL)
		if err != nil {
			log.Printf("upload 丢弃 %q: %v", img.Name, err)
			rejected++
			continue
		}
		it, err := s.st.Enqueue(mime, data)
		if err != nil {
			log.Printf("upload 落盘失败 %q: %v", img.Name, err)
			rejected++
			continue
		}
		ids = append(ids, it.ID)
		accepted++
	}
	// 有 holder 就顺手推出去；没有就留在 queue 里等 attach，绝不因为「没人接」丢图
	s.pump()
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted":  accepted,
		"delivered": s.st.PushedCount(ids),
		"queued":    s.st.Queued(),
		"rejected":  rejected,
	})
}

// handleFinish 释放锁并通知 holder。没有 holder 也回 ok：
// 用户点「结束」时想要的结果是「这轮结束」，不是一个错误对话框。
func (s *Server) handleFinish(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		unauthorized(w)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	s.finishByWeb()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// parseDataURL 只认 data:image/...;base64,<payload>。不猜也不补：
// 页面永远发 base64 JPEG，别的形态不是旧页面就是手搓请求，拒掉比猜错扩展名好查。
func parseDataURL(s string) (string, []byte, error) {
	const prefix = "data:"
	if !strings.HasPrefix(s, prefix) {
		return "", nil, errBadDataURL
	}
	rest := s[len(prefix):]
	i := strings.Index(rest, ";base64,")
	if i < 0 {
		return "", nil, errBadDataURL
	}
	mime := strings.ToLower(strings.TrimSpace(rest[:i]))
	data, err := base64.StdEncoding.DecodeString(rest[i+len(";base64,"):])
	if err != nil {
		return "", nil, errBadDataURL
	}
	if _, ok := mimeExt[mime]; !ok {
		return "", nil, errUnknownMime
	}
	return mime, data, nil
}

func unauthorized(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
