package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func problem(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"message": message, "type": "gateway_error"}})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		problem(w, 400, "请求格式不正确或内容过大")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		problem(w, 400, "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}
func (g *Gateway) sameOrigin(r *http.Request) bool {
	u, e := url.Parse(g.origin)
	if e != nil || !strings.EqualFold(r.Host, u.Host) {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin != "" && origin != g.origin {
		return false
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	return true
}
func (g *Gateway) authenticated(r *http.Request) bool {
	c, e := r.Cookie("gateway_admin")
	if e != nil {
		return false
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	s, ok := g.sessions[digest(c.Value)]
	return ok && time.Now().Before(s.Expires)
}
func (g *Gateway) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !g.sameOrigin(r) {
			problem(w, 403, "管理接口只接受配置的同源地址")
			return
		}
		if !g.authenticated(r) {
			problem(w, 401, "请先登录管理页面")
			return
		}
		if r.Method != "GET" && r.Header.Get("X-Gateway-Admin") != "1" {
			problem(w, 403, "缺少管理请求校验")
			return
		}
		next(w, r)
	}
}
func (g *Gateway) auth(w http.ResponseWriter, r *http.Request) {
	if !g.sameOrigin(r) || r.Header.Get("X-Gateway-Admin") != "1" {
		problem(w, 403, "请求来源不允许")
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if r.URL.Path == "/api/login" && in.Password == "" && g.localPasswordless && !g.localUnlockReady() {
		problem(w, 409, "请先输入一次原管理密码，完成后即可留空解锁；原密码仍会保留")
		return
	}
	g.authMu.Lock()
	defer g.authMu.Unlock()
	if time.Since(g.attemptWindow) > time.Minute {
		g.attemptWindow = time.Now()
		g.attempts = 0
	}
	if g.attempts >= 8 {
		problem(w, 429, "尝试次数过多，请稍后再试")
		return
	}
	g.attempts++
	if r.URL.Path == "/api/setup" {
		if !g.allowSetup {
			problem(w, 403, "请先在本机初始化管理密码")
			return
		}
		if utf8.RuneCountInString(in.Password) < 12 {
			problem(w, 400, "管理密码至少需要 12 个字符")
			return
		}
		if e := g.setup(in.Password); e != nil {
			problem(w, 409, "已经初始化，或初始化失败")
			return
		}
	}
	master, e := g.unlock(in.Password)
	if e != nil {
		problem(w, 401, "密码不正确，或尚未初始化")
		return
	}
	defer wipe(master)
	if g.localPasswordless && in.Password != "" {
		if g.saveLocalUnlock(master) != nil {
			problem(w, 500, "本地免密设置保存失败，原密码和配置保持不变，请重试")
			return
		}
	}
	token := newToken()
	g.mu.Lock()
	wipe(g.master)
	g.master = append([]byte(nil), master...)
	for k, s := range g.sessions {
		if time.Now().After(s.Expires) {
			delete(g.sessions, k)
		}
	}
	g.sessions[digest(token)] = session{Expires: time.Now().Add(12 * time.Hour)}
	g.mu.Unlock()
	g.attempts = 0
	http.SetCookie(w, &http.Cookie{Name: "gateway_admin", Value: token, Path: "/api", HttpOnly: true, Secure: g.secure, SameSite: http.SameSiteStrictMode, MaxAge: 43200})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (g *Gateway) Handler(assets fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		if !g.sameOrigin(r) {
			problem(w, 403, "地址不允许")
			return
		}
		k := g.key()
		defer wipe(k)
		writeJSON(w, 200, map[string]any{"configured": g.configured(), "passwordless_enabled": g.localPasswordless, "passwordless_ready": g.localUnlockReady(), "authenticated": g.authenticated(r), "locked": len(k) == 0, "version": "0.1.0", "base_url": g.origin + "/v1"})
	})
	mux.HandleFunc("POST /api/setup", g.auth)
	mux.HandleFunc("POST /api/login", g.auth)
	mux.HandleFunc("POST /api/admin/logout", g.admin(func(w http.ResponseWriter, r *http.Request) {
		cookie, _ := r.Cookie("gateway_admin") // Validated by the admin middleware.
		g.mu.Lock()
		delete(g.sessions, digest(cookie.Value))
		g.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: "gateway_admin", Path: "/api", MaxAge: -1, HttpOnly: true, Secure: g.secure, SameSite: http.SameSiteStrictMode})
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/admin/lock", g.admin(func(w http.ResponseWriter, r *http.Request) {
		g.lock()
		http.SetCookie(w, &http.Cookie{Name: "gateway_admin", Path: "/api", MaxAge: -1, HttpOnly: true, Secure: g.secure, SameSite: http.SameSiteStrictMode})
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/admin/state", g.admin(g.state))
	mux.HandleFunc("POST /api/admin/connections", g.admin(g.saveConnection))
	mux.HandleFunc("PUT /api/admin/connections/{id}", g.admin(g.saveConnection))
	mux.HandleFunc("DELETE /api/admin/connections/{id}", g.admin(g.deleteConnection))
	mux.HandleFunc("POST /api/admin/connections/{id}/reveal", g.admin(g.reveal))
	mux.HandleFunc("POST /api/admin/models", g.admin(g.saveModel))
	mux.HandleFunc("PUT /api/admin/models/{id}", g.admin(g.saveModel))
	mux.HandleFunc("DELETE /api/admin/models/{id}", g.admin(g.deleteModel))
	mux.HandleFunc("POST /api/admin/projects", g.admin(g.saveProject))
	mux.HandleFunc("PUT /api/admin/projects/{id}", g.admin(g.saveProject))
	mux.HandleFunc("DELETE /api/admin/projects/{id}", g.admin(g.deleteProject))
	mux.HandleFunc("POST /api/admin/projects/{id}/rotate", g.admin(g.rotateProject))
	mux.HandleFunc("POST /api/admin/projects/{id}/credential", g.admin(g.projectCredential))
	mux.HandleFunc("POST /api/admin/projects/{id}/credential/save", g.admin(g.saveExistingProjectCredential))
	mux.HandleFunc("GET /api/admin/requests", g.admin(g.listRecords))
	mux.HandleFunc("GET /api/admin/requests/{id}", g.admin(g.getRecord))
	mux.HandleFunc("POST /api/admin/demo", g.admin(g.seedDemo))
	mux.HandleFunc("POST /api/admin/models/{id}/test", g.admin(g.testModel))
	mux.HandleFunc("GET /v1/models", g.modelList)
	mux.HandleFunc("POST /v1/chat/completions", g.proxy)
	mux.HandleFunc("POST /v1/messages", g.proxy)
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		problem(w, 404, "此 Demo 仅支持 Chat Completions、Messages 和模型列表")
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { problem(w, 404, "接口不存在") })
	if assets != nil {
		fileServer := http.FileServerFS(assets)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "GET" && r.Method != "HEAD" {
				problem(w, 405, "方法不允许")
				return
			}
			p := strings.TrimPrefix(r.URL.Path, "/")
			if p == "" {
				p = "index.html"
			}
			if _, e := fs.Stat(assets, p); errors.Is(e, fs.ErrNotExist) {
				copy := r.Clone(r.Context())
				copy.URL.Path = "/"
				fileServer.ServeHTTP(w, copy)
				return
			}
			fileServer.ServeHTTP(w, r)
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.active.Add(1)
		defer g.active.Done()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		mux.ServeHTTP(w, r)
	})
}
