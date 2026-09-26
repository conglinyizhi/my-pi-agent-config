package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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

// savedItem 是上传回执里的一条。不带 ts / lastUsed：手机这时候只关心
// 「存成了几号」，时间在 /refs 里看得到。
type savedItem struct {
	Ref   int    `json:"ref"`
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

type uploadResp struct {
	Saved    []savedItem `json:"saved"`
	Rejected int         `json:"rejected"`
}

type refsResp struct {
	Pool  int        `json:"pool"`
	Items []*RefItem `json:"items"`
}

type statusResp struct {
	Pool int `json:"pool"`
	Used int `json:"used"`
}

// API 是 HTTP 这一层。没有锁、没有会话之后，它不做任何调度，只是把 Store 的
// 编号表摊成几个接口，所以叫 API 而不是 Server：这里没有要维护的会话状态。
type API struct {
	st *Store
}

func newAPI(st *Store) *API { return &API{st: st} }

func (a *API) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handleIndex)
	mux.HandleFunc("GET /manage", a.handleManage)
	mux.HandleFunc("GET /status", a.handleStatus)
	mux.HandleFunc("POST /upload", a.handleUpload)
	mux.HandleFunc("GET /refs", a.handleRefs)
	mux.HandleFunc("GET /refs/{n}", a.handleRefGet)
	mux.HandleFunc("POST /refs/{n}/use", a.handleRefUse)
	// raw 不限来源：上传页的缩略图列表和大图都走它，限回环会让管理页一离开本机就瞎掉；
	// 它只读、只看编号表里有登记的图，比 delete 那一路温和得多。
	mux.HandleFunc("GET /refs/{n}/raw", a.handleRefRaw)
	mux.HandleFunc("POST /refs/{n}/delete", a.handleRefDelete)
	return mux
}

// authorized 校验 ?k=<token>。用常数时间比较：token 是打印出来贴给手机的口令，
// 常规比较下响应时间会漏信息，虽然这条路上本来也没多大威胁，但没有成本就不留。
func (a *API) authorized(r *http.Request) bool {
	k := r.URL.Query().Get("k")
	if k == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(k), []byte(a.st.Token())) == 1
}

func (a *API) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if !a.authorized(r) {
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

// handleStatus 是页面顶行的数据源：只有池子大小和已用号数。
// token 一个字节都不出去：这行是给手机看的，手机不需要拿新口令。
func (a *API) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	writeJSON(w, http.StatusOK, statusResp{Pool: a.st.Pool(), Used: a.st.Used()})
}

func (a *API) handleUpload(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	var req uploadReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON: " + err.Error()})
		return
	}
	// saved 初始化成空切片而不是 nil：回执里要的是 "saved":[]，不是 null
	saved := make([]savedItem, 0, len(req.Images))
	rejected := 0
	for _, img := range req.Images {
		mime, data, err := parseDataURL(img.DataURL)
		if err != nil {
			log.Printf("upload 丢弃 %q: %v", img.Name, err)
			rejected++
			continue
		}
		it, err := a.st.Enqueue(mime, data)
		if err != nil {
			log.Printf("upload 落盘失败 %q: %v", img.Name, err)
			rejected++
			continue
		}
		saved = append(saved, savedItem{Ref: it.Ref, Path: it.Path, Bytes: it.Bytes})
	}
	writeJSON(w, http.StatusOK, uploadResp{Saved: saved, Rejected: rejected})
}

func (a *API) handleRefs(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	writeJSON(w, http.StatusOK, refsResp{Pool: a.st.Pool(), Items: a.st.Refs()})
}

// handleRefGet 回单条。这里回的是 items 里的那个对象本身，不再套一层：
// 调用方要么已经在看 /refs，要么就是拿着一个编号来问这一条，多一层包装只是多一次解包。
func (a *API) handleRefGet(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	ref, ok := refOf(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	it, err := a.st.Get(ref)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	writeJSON(w, http.StatusOK, it)
}

// handleRefUse 刷新 lastUsed。pi 侧真把这张图用上了就喊一声，
// 池满时就不会先砍到刚用过的那张。
func (a *API) handleRefUse(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	ref, ok := refOf(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	if _, err := a.st.Touch(ref); err != nil {
		if errors.Is(err, errNoRef) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// isLoopback 判断请求是不是从主机本机发来的。只看 TCP 连接的对端地址，
// 不看 X-Forwarded-For 之类的头：那些头谁都能填，拿它分流等于把管理页的门
// 交给请求方自己决定。net.IP.IsLoopback 覆盖 127.0.0.0/8 与 ::1。
func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr // 没有端口时就直接当裸地址解析
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// managePage 把归档目录路径填进页面。看图的页面得让人一眼能对上传到磁盘的哪个目录，
// 路径可能带引号之类的字符，替换前先做 HTML 转义。
func managePage(archive string) []byte {
	return bytes.Replace(manageHTML, manageArchiveSlot, []byte(html.EscapeString(archive)), 1)
}

// handleManage 是管理页：缩略图网格 + 大图 + 删除，只给主机本机开。
// 手机走局域网 IP，来源不是回环，这里只回一句话，页面内容一个字节都不给。
// 口令先判：口令不对时不区分来源，一律 401，和别的接口一个口径。
func (a *API) handleManage(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	if !isLoopback(r) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("管理页只能在主机本机打开（请求来源不是回环地址）。手机请用上传页。\n"))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(managePage(filepath.Join(a.st.Root(), "archive")))
}

// rawContentType 按扩展名给 Content-Type。表外的类型回 application/octet-stream：
// 猜错类型会让浏览器把图当文本渲染、或者把别的东西当图，宁可让它下载。
func rawContentType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	}
	return "application/octet-stream"
}

// handleRefRaw 回某编号对应文件的字节，给管理页的缩略图与大图用。
// 「表里没这个号」和「表里有但文件不在」都回 404：对取图的一方都是找不到。
func (a *API) handleRefRaw(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	ref, ok := refOf(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	it, err := a.st.Get(ref)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	f, err := os.Open(it.Path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	w.Header().Set("Content-Type", rawContentType(it.Path))
	w.Header().Set("Cache-Control", "no-store")
	// ServeContent 按文件实际大小补 Content-Length，并顺手支持 Range：
	// 一张 1600 长边的图不算大，但手机流量下能续传总比整张重来强。
	http.ServeContent(w, r, filepath.Base(it.Path), info.ModTime(), f)
}

// handleRefDelete 删文件并释放编号。404 的两种情况都「不报错」：编号没登记、
// 或登记了但文件已经不在——后者照样把号还回池子。真失败（权限等）才 500。
func (a *API) handleRefDelete(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		unauthorized(w)
		return
	}
	ref, ok := refOf(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": errNoRef.Error()})
		return
	}
	it, err := a.st.Delete(ref)
	switch {
	case err == nil:
		// 删除会改 archive，留一行 journal 便于事后对「谁把图删了」
		log.Printf("删除 %d 号：%s", ref, it.Path)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ref": ref})
	case errors.Is(err, errNoRef), errors.Is(err, errNoFile):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
	}
}

// refOf 从路径里取编号。取不到（包括不是数字）一律当「不存在」：
// 「编号不合法」和「编号没登记」对调用方是同一件事，少一种分支就少一处不一致。
func refOf(r *http.Request) (int, bool) {
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
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
