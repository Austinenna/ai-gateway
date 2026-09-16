package main

import (
	"ai-gateway/internal/gateway"
	"ai-gateway/web"
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	configDir, e := os.UserConfigDir()
	if e != nil {
		log.Fatal(e)
	}
	addr := flag.String("addr", "127.0.0.1:8317", "监听地址")
	// Preserve the original default location for existing direct-binary users.
	data := flag.String("data-dir", filepath.Join(configDir, "local-ai-gateway"), "数据目录")
	public := flag.String("public-url", "", "管理页面对外地址（无路径），远程部署必须为 HTTPS")
	localPasswordless := flag.Bool("local-no-password", false, "本地模式：首次输入原密码后，启动自动解锁，管理页可留空登录；仅允许回环地址")
	flag.Parse()
	host, _, e := net.SplitHostPort(*addr)
	if e != nil {
		log.Fatal("无效监听地址")
	}
	ip := net.ParseIP(host)
	local := host == "localhost" || ip != nil && ip.IsLoopback()
	origin := strings.TrimRight(*public, "/")
	if origin == "" {
		origin = "http://" + *addr
	}
	u, e := url.Parse(origin)
	if e != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		log.Fatal("无效 public-url")
	}
	if !local && u.Scheme != "https" {
		log.Fatal("远程监听必须配置 HTTPS public-url，并置于 TLS 反向代理之后")
	}
	g, e := gateway.Open(*data, origin, local)
	if e != nil {
		log.Fatal(e)
	}
	defer g.Close()
	if *localPasswordless {
		if e = g.EnableLocalPasswordless(); e != nil {
			log.Fatal(e)
		}
	} else if e = g.DisableLocalPasswordless(); e != nil {
		log.Fatal(e)
	}
	server := &http.Server{Addr: *addr, Handler: g.Handler(web.Assets()), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 * 1024}
	done := make(chan os.Signal, 1)
	shutdownDone := make(chan struct{})
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	go func() {
		defer close(shutdownDone)
		<-done
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if server.Shutdown(ctx) != nil {
			_ = server.Close()
		}
	}()
	fmt.Printf("AI Gateway v0.1.0\n管理页面：%s\n数据目录：%s\n", origin, *data)
	if e = server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
	<-shutdownDone
}
