package gateway

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
)

const (
	serviceUnlockMeta = "service_wrapped_master"
	serviceUnlockAAD  = "gateway-service-unlock-v1"
	serviceKeyBytes   = 32
)

var errServiceUnlockKeyInvalid = errors.New("服务自动解锁密钥长度无效")

// serviceUnlockKeyPath is deliberately separate from gateway.db. A database
// backup alone must not be enough to recover the master key.
func (g *Gateway) serviceUnlockKeyPath() string {
	return filepath.Join(g.dataDir, "service-unlock.key")
}

func (g *Gateway) readServiceUnlockKey() ([]byte, error) {
	key, err := os.ReadFile(g.serviceUnlockKeyPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(key) != serviceKeyBytes {
		wipe(key)
		return nil, errServiceUnlockKeyInvalid
	}
	return key, nil
}

func (g *Gateway) createServiceUnlockKey() ([]byte, error) {
	key := randomBytes(serviceKeyBytes)
	f, err := os.OpenFile(g.serviceUnlockKeyPath(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		wipe(key)
		if errors.Is(err, os.ErrExist) {
			return g.readServiceUnlockKey()
		}
		return nil, err
	}
	var written int
	if written, err = f.Write(key); err == nil && written != len(key) {
		err = errors.New("服务自动解锁密钥写入不完整")
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		wipe(key)
		_ = os.Remove(g.serviceUnlockKeyPath())
		return nil, err
	}
	if err = os.Chmod(g.serviceUnlockKeyPath(), 0600); err != nil {
		wipe(key)
		return nil, err
	}
	return key, nil
}

func (g *Gateway) ensureServiceUnlockKey() ([]byte, error) {
	key, err := g.readServiceUnlockKey()
	if err != nil || key != nil {
		return key, err
	}
	return g.createServiceUnlockKey()
}

// EnableServiceAutoUnlock restores the running master key from the service
// key before HTTP starts. Missing material is allowed for existing databases;
// the next password login creates it without weakening management login.
func (g *Gateway) EnableServiceAutoUnlock() error {
	g.serviceAutoUnlock = true
	key, err := g.readServiceUnlockKey()
	if err != nil {
		if errors.Is(err, errServiceUnlockKeyInvalid) {
			// Let the next password login replace damaged material instead of
			// trapping the service in a systemd restart loop.
			_ = os.Remove(g.serviceUnlockKeyPath())
			return nil
		}
		return err
	}
	if key == nil {
		return nil
	}
	defer wipe(key)
	var wrapped []byte
	err = g.db.QueryRow("SELECT value FROM meta WHERE key=?", serviceUnlockMeta).Scan(&wrapped)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	master, err := unseal(key, wrapped, serviceUnlockAAD)
	if err != nil {
		// Keep the HTTP service available for a normal password login, which
		// replaces the invalid wrapper after authenticating the administrator.
		return nil
	}
	defer wipe(master)
	if len(master) != 32 {
		// Keep the HTTP service available for a normal password login, which
		// replaces the invalid wrapper after authenticating the administrator.
		return nil
	}
	g.mu.Lock()
	wipe(g.master)
	g.master = append([]byte(nil), master...)
	g.mu.Unlock()
	return nil
}

// saveServiceUnlock is called after a successful password unlock. It keeps
// the management password as the only browser credential while allowing the
// service process to resume project traffic after a restart.
func (g *Gateway) saveServiceUnlock(master []byte) error {
	if !g.serviceAutoUnlock {
		return nil
	}
	key, err := g.ensureServiceUnlockKey()
	if err != nil {
		return err
	}
	defer wipe(key)
	wrapped, err := seal(key, master, serviceUnlockAAD)
	if err != nil {
		return err
	}
	defer wipe(wrapped)
	_, err = g.db.Exec(`INSERT INTO meta(key,value) VALUES(?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, serviceUnlockMeta, wrapped)
	return err
}
