package gateway

import (
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"strings"
)

// The outbound proxy is one address for the whole gateway; each connection only
// decides whether its upstream calls use it. While no address is saved, calls
// keep following HTTPS_PROXY / HTTP_PROXY / NO_PROXY so existing deployments do
// not change behavior. Once an address is saved, the per-connection switch is
// authoritative: connections without it go direct even if the environment sets
// a proxy.
const outboundProxyKey = "outbound_proxy"

type upstreamProxyKey struct{}

// upstreamProxy carries the chosen proxy, or nil for a direct connection.
type upstreamProxy struct{ url *url.URL }

func parseOutboundProxy(raw string) (*url.URL, bool) {
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || u.Hostname() == "" || u.Port() == "" || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return nil, false
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
		return &url.URL{Scheme: u.Scheme, Host: u.Host}, true
	}
	return nil, false
}

func (g *Gateway) loadOutboundProxy() error {
	var raw string
	e := g.db.QueryRow("SELECT value FROM meta WHERE key=?", outboundProxyKey).Scan(&raw)
	if e == sql.ErrNoRows {
		g.outboundProxy.Store(nil)
		return nil
	}
	if e != nil {
		return e
	}
	if u, ok := parseOutboundProxy(raw); ok {
		g.outboundProxy.Store(u)
	}
	return nil
}

func (g *Gateway) outboundProxyURL() string {
	if u := g.outboundProxy.Load(); u != nil {
		return u.String()
	}
	return ""
}

// withUpstreamProxy records the routing decision for one upstream request.
func (g *Gateway) withUpstreamProxy(ctx context.Context, useProxy bool) context.Context {
	u := g.outboundProxy.Load()
	if u == nil {
		return ctx
	}
	if !useProxy {
		u = nil
	}
	return context.WithValue(ctx, upstreamProxyKey{}, upstreamProxy{url: u})
}

func proxyForRequest(r *http.Request) (*url.URL, error) {
	if p, ok := r.Context().Value(upstreamProxyKey{}).(upstreamProxy); ok {
		return p.url, nil
	}
	return http.ProxyFromEnvironment(r)
}

func (g *Gateway) saveOutboundProxy(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL string `json:"url"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.URL = strings.TrimRight(strings.TrimSpace(in.URL), "/")
	var e error
	if in.URL == "" {
		_, e = g.db.Exec("DELETE FROM meta WHERE key=?", outboundProxyKey)
	} else {
		u, ok := parseOutboundProxy(in.URL)
		if !ok {
			problem(w, 400, "请填写有效的代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890（需包含端口，不支持账号密码）")
			return
		}
		in.URL = u.String()
		_, e = g.db.Exec("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", outboundProxyKey, in.URL)
	}
	if e != nil {
		problem(w, 500, "保存代理设置失败")
		return
	}
	if e = g.loadOutboundProxy(); e != nil {
		problem(w, 500, "读取代理设置失败")
		return
	}
	if c, ok := g.client.(interface{ CloseIdleConnections() }); ok {
		c.CloseIdleConnections()
	}
	writeJSON(w, 200, map[string]string{"url": g.outboundProxyURL()})
}

func migrateConnectionProxy(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err = tx.QueryRow("SELECT count(*) FROM pragma_table_info('connections') WHERE name='use_proxy'").Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		if _, err = tx.Exec("ALTER TABLE connections ADD COLUMN use_proxy INTEGER NOT NULL DEFAULT 0"); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("PRAGMA user_version=9"); err != nil {
		return err
	}
	return tx.Commit()
}
