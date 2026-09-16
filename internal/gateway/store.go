package gateway

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

type Connection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	// Legacy input fields; forwarding fills these only after choosing an endpoint.
	Protocol  string            `json:"protocol,omitempty"`
	BaseURL   string            `json:"base_url,omitempty"`
	Endpoints map[string]string `json:"endpoints"`
	Enabled   bool              `json:"enabled"`
	HasToken  bool              `json:"has_token"`
	Token     string            `json:"token,omitempty"`
}
type Model struct {
	ID            string                     `json:"id"`
	Name          string                     `json:"name"`
	Alias         string                     `json:"alias"`
	ConnectionID  string                     `json:"connection_id"`
	Protocols     []string                   `json:"protocols"`
	UpstreamModel string                     `json:"upstream_model"`
	Defaults      map[string]json.RawMessage `json:"defaults"`
	Enabled       bool                       `json:"enabled"`
}
type Project struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Enabled       bool     `json:"enabled"`
	TokenPrefix   string   `json:"token_prefix"`
	HasSavedToken bool     `json:"has_saved_token"`
	ModelIDs      []string `json:"model_ids"`
}
type Record struct {
	MetricsFields
	ID            string `json:"id"`
	ProjectID     string `json:"project_id"`
	ProjectName   string `json:"project_name"`
	ModelID       string `json:"model_id"`
	Alias         string `json:"alias"`
	UpstreamModel string `json:"upstream_model"`
	Protocol      string `json:"protocol"`
	Started       int64  `json:"started"`
	Duration      int64  `json:"duration_ms"`
	FirstText     *int64 `json:"first_text_ms"`
	FirstToken    *int64 `json:"first_token_ms"`
	TimingVersion int    `json:"timing_version,omitempty"`
	Status        int    `json:"status"`
	State         string `json:"state"`
	Input         string `json:"input,omitempty"`
	Output        string `json:"output,omitempty"`
	InputTokens   int64  `json:"input_tokens"`
	OutputTokens  int64  `json:"output_tokens"`
	Truncated     bool   `json:"truncated"`

	Adaptations []RequestAdaptation `json:"adaptations,omitempty"`
}
type session struct{ Expires time.Time }
type Gateway struct {
	metricsMu         sync.Mutex
	inflight          map[string]Record
	metricsErrors     atomic.Int64
	monitoringSince   int64
	active            sync.WaitGroup
	db                *sql.DB
	mu                sync.RWMutex
	master            []byte
	sessions          map[string]session
	origin            string
	secure            bool
	allowSetup        bool
	localPasswordless bool
	authMu            sync.Mutex
	attempts          int
	attemptWindow     time.Time
	records           chan Record
	writerDone        chan struct{}
	dropped           atomic.Int64
	client            HTTPDoer
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return b
}
func id(prefix string) string { return prefix + hex.EncodeToString(randomBytes(10)) }
func newToken() string        { return "gw_" + base64.RawURLEncoding.EncodeToString(randomBytes(32)) }
func digest(v string) string  { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
func passwordKey(password string, salt []byte) []byte {
	return argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
}
func seal(key, plain []byte, aad string) ([]byte, error) {
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	a, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	n := randomBytes(a.NonceSize())
	return a.Seal(n, n, plain, []byte(aad)), nil
}
func unseal(key, data []byte, aad string) ([]byte, error) {
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	a, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	if len(data) < a.NonceSize() {
		return nil, errors.New("invalid ciphertext")
	}
	return a.Open(nil, data[:a.NonceSize()], data[a.NonceSize():], []byte(aad))
}
func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func Open(dataDir, origin string, allowSetup bool) (*Gateway, error) {
	if e := os.MkdirAll(dataDir, 0700); e != nil {
		return nil, e
	}
	if e := os.Chmod(dataDir, 0700); e != nil {
		return nil, e
	}
	path := filepath.Join(dataDir, "gateway.db")
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	f.Close()
	if e = os.Chmod(path, 0600); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	fail := func(e error) (*Gateway, error) { db.Close(); return nil, e }
	if _, e = db.Exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); e != nil {
		return fail(e)
	}
	var v int
	if e = db.QueryRow("PRAGMA user_version").Scan(&v); e != nil {
		return fail(e)
	}
	if v > 5 {
		return fail(errors.New("database was created by a newer gateway"))
	}
	_, e = db.Exec(`
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL,protocol TEXT NOT NULL,base_url TEXT NOT NULL,credential BLOB NOT NULL,enabled INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,name TEXT NOT NULL,alias TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL REFERENCES connections(id),upstream_model TEXT NOT NULL,defaults_json TEXT NOT NULL,enabled INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,token_digest TEXT NOT NULL UNIQUE,token_prefix TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS project_credentials(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,credential BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS project_models(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,model_id TEXT NOT NULL REFERENCES models(id),PRIMARY KEY(project_id,model_id));
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,started INTEGER NOT NULL,summary TEXT NOT NULL,record TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_requests_started ON requests(started DESC);
 CREATE INDEX IF NOT EXISTS idx_requests_project_started ON requests(project_id,started DESC);
 `)
	if e != nil {
		return fail(e)
	}
	if v == 1 {
		tx, err := db.Begin()
		if err != nil {
			return fail(err)
		}
		if _, err = tx.Exec(`ALTER TABLE requests ADD COLUMN summary TEXT NOT NULL DEFAULT '{}'; UPDATE requests SET summary=json_remove(record,'$.input','$.output'); PRAGMA user_version=3;`); err != nil {
			tx.Rollback()
			return fail(err)
		}
		if err = tx.Commit(); err != nil {
			return fail(err)
		}
	} else if v < 3 {
		if _, e = db.Exec("PRAGMA user_version=3"); e != nil {
			return fail(e)
		}
	}
	if v < 5 {
		if e = migrateProtocolEndpoints(db); e != nil {
			return fail(e)
		}
	}
	g := &Gateway{db: db, origin: origin, secure: len(origin) >= 8 && origin[:8] == "https://", allowSetup: allowSetup, sessions: map[string]session{}, records: make(chan Record, 32), writerDone: make(chan struct{}), client: newHTTPClient()}
	if e = g.initMetrics(); e != nil {
		return fail(e)
	}
	go func() {
		defer close(g.writerDone)
		for rec := range g.records {
			raw, err := json.Marshal(rec)
			if err == nil {
				meta := rec
				meta.Input, meta.Output = "", ""
				summary, _ := json.Marshal(meta)
				_, err = db.Exec("INSERT INTO requests(id,project_id,started,summary,record) VALUES(?,?,?,?,?)", rec.ID, rec.ProjectID, rec.Started, string(summary), string(raw))
			}
			if err != nil {
				g.dropped.Add(1)
			}
		}
	}()
	return g, nil
}
func (g *Gateway) Close() error {
	g.active.Wait()
	close(g.records)
	<-g.writerDone
	g.lock()
	return g.db.Close()
}
func (g *Gateway) configured() bool {
	var count int
	_ = g.db.QueryRow("SELECT count(*) FROM meta WHERE key='wrapped_master'").Scan(&count)
	return count > 0
}
func (g *Gateway) key() []byte {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return append([]byte(nil), g.master...)
}
func (g *Gateway) lock() {
	g.mu.Lock()
	defer g.mu.Unlock()
	wipe(g.master)
	g.master = nil
	g.sessions = map[string]session{}
}
func (g *Gateway) unlock(password string) ([]byte, error) {
	wrapper, aad := "wrapped_master", "gateway-master-v1"
	if password == "" {
		if !g.localPasswordless {
			return nil, errors.New("management password required")
		}
		wrapper, aad = "local_wrapped_master", "gateway-local-unlock-v1"
	}
	var salt, wrapped []byte
	if e := g.db.QueryRow("SELECT value FROM meta WHERE key='salt'").Scan(&salt); e != nil {
		return nil, e
	}
	if e := g.db.QueryRow("SELECT value FROM meta WHERE key=?", wrapper).Scan(&wrapped); e != nil {
		return nil, e
	}
	k := passwordKey(password, salt)
	defer wipe(k)
	return unseal(k, wrapped, aad)
}
func (g *Gateway) setup(password string) error {
	if g.configured() {
		return errors.New("already configured")
	}
	salt := randomBytes(16)
	k := passwordKey(password, salt)
	defer wipe(k)
	master := randomBytes(32)
	defer wipe(master)
	wrapped, e := seal(k, master, "gateway-master-v1")
	if e != nil {
		return e
	}
	tx, e := g.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT INTO meta(key,value) VALUES('salt',?),('wrapped_master',?)", salt, wrapped); e != nil {
		return e
	}
	return tx.Commit()
}
func (g *Gateway) connections() ([]Connection, error) {
	rows, e := g.db.Query("SELECT id,name,provider,endpoints_json,enabled FROM connections ORDER BY rowid")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Connection{}
	for rows.Next() {
		var c Connection
		var endpoints string
		if e = rows.Scan(&c.ID, &c.Name, &c.Provider, &endpoints, &c.Enabled); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(endpoints), &c.Endpoints); e != nil {
			return nil, e
		}
		c.HasToken = c.Provider != "demo"
		out = append(out, c)
	}
	return out, rows.Err()
}
func (g *Gateway) models() ([]Model, error) {
	rows, e := g.db.Query("SELECT id,name,alias,connection_id,upstream_model,defaults_json,enabled,protocols_json FROM models ORDER BY rowid")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Model{}
	for rows.Next() {
		var m Model
		var d, protocols string
		if e = rows.Scan(&m.ID, &m.Name, &m.Alias, &m.ConnectionID, &m.UpstreamModel, &d, &m.Enabled, &protocols); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(protocols), &m.Protocols); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(d), &m.Defaults); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (g *Gateway) projects() ([]Project, error) {
	rows, e := g.db.Query("SELECT id,name,enabled,token_prefix,EXISTS(SELECT 1 FROM project_credentials pc WHERE pc.project_id=projects.id) FROM projects ORDER BY rowid")
	if e != nil {
		return nil, e
	}
	out := []Project{}
	for rows.Next() {
		var p Project
		p.ModelIDs = []string{}
		if e = rows.Scan(&p.ID, &p.Name, &p.Enabled, &p.TokenPrefix, &p.HasSavedToken); e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, p)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	grants, e := g.db.Query("SELECT project_id,model_id FROM project_models")
	if e != nil {
		return nil, e
	}
	defer grants.Close()
	for grants.Next() {
		var p, m string
		if e = grants.Scan(&p, &m); e != nil {
			return nil, e
		}
		for i := range out {
			if out[i].ID == p {
				out[i].ModelIDs = append(out[i].ModelIDs, m)
			}
		}
	}
	return out, grants.Err()
}
func (g *Gateway) enqueue(r Record) {
	select {
	case g.records <- r:
	default:
		g.dropped.Add(1)
	}
}
