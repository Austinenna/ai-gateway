package gateway

import (
	"errors"
	"net"
	"net/url"
)

// EnableLocalPasswordless is an explicit development-only setting. The main
// password wrapper stays intact so removing the flag restores password login.
func (g *Gateway) EnableLocalPasswordless() error {
	u, err := url.Parse(g.origin)
	if err != nil {
		return errors.New("本地免密模式需要回环地址")
	}
	ip := net.ParseIP(u.Hostname())
	if !g.allowSetup || !(u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()) {
		return errors.New("本地免密模式只允许回环监听和回环管理地址")
	}
	g.localPasswordless = true
	// A local service must be ready before any administrator opens the UI.
	// Older databases still need one password login to create this wrapper.
	var count int
	if err := g.db.QueryRow("SELECT count(*) FROM meta WHERE key='local_wrapped_master'").Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return nil
	}
	master, err := g.unlock("")
	if err != nil {
		g.localPasswordless = false
		return errors.New("本地自动解锁失败，请检查本地解锁材料，或关闭免密模式后使用原管理密码")
	}
	defer wipe(master)
	g.mu.Lock()
	wipe(g.master)
	g.master = append([]byte(nil), master...)
	g.mu.Unlock()
	return nil
}

// Called at startup when the temporary flag is removed. Existing password
// material and all vendor/project ciphertexts are left intact.
func (g *Gateway) DisableLocalPasswordless() error {
	if _, err := g.db.Exec("DELETE FROM meta WHERE key='local_wrapped_master'"); err != nil {
		return err
	}
	g.localPasswordless = false
	return nil
}

func (g *Gateway) localUnlockReady() bool {
	if !g.localPasswordless {
		return false
	}
	var count int
	return g.db.QueryRow("SELECT count(*) FROM meta WHERE key='local_wrapped_master'").Scan(&count) == nil && count > 0
}

func (g *Gateway) saveLocalUnlock(master []byte) error {
	var salt []byte
	if err := g.db.QueryRow("SELECT value FROM meta WHERE key='salt'").Scan(&salt); err != nil {
		return err
	}
	k := passwordKey("", salt)
	defer wipe(k)
	wrapped, err := seal(k, master, "gateway-local-unlock-v1")
	if err != nil {
		return err
	}
	_, err = g.db.Exec("INSERT INTO meta(key,value) VALUES('local_wrapped_master',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", wrapped)
	return err
}
