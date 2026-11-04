package gateway

import (
	"database/sql"
	"fmt"
)

// Schema changes after user_version 10 are strictly additive and are tracked in
// meta.schema_ext instead of user_version. The previous release only refuses a
// database whose user_version is newer than 10, so it can still open this
// database after a rollback; it ignores the extra columns and tables.
const schemaExtVersion = 11

func columnExists(q interface {
	QueryRow(string, ...any) *sql.Row
}, table, column string) (bool, error) {
	var n int
	// table_xinfo also lists generated columns.
	err := q.QueryRow("SELECT count(*) FROM pragma_table_xinfo(?) WHERE name=?", table, column).Scan(&n)
	return n > 0, err
}

func migrateExtensions(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var current int
	if err = tx.QueryRow("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='schema_ext'),0)").Scan(&current); err != nil {
		return err
	}
	if current > schemaExtVersion {
		return fmt.Errorf("database extensions were created by a newer gateway (%d)", current)
	}
	columns := []struct{ table, name, ddl string }{
		// Virtual columns cost no storage and let list filters use indexes.
		{"request_metrics", "m_project", "ALTER TABLE request_metrics ADD COLUMN m_project TEXT GENERATED ALWAYS AS (json_extract(summary,'$.project_id')) VIRTUAL"},
		{"request_metrics", "m_model", "ALTER TABLE request_metrics ADD COLUMN m_model TEXT GENERATED ALWAYS AS (json_extract(summary,'$.model_id')) VIRTUAL"},
		{"request_metrics", "m_alias", "ALTER TABLE request_metrics ADD COLUMN m_alias TEXT GENERATED ALWAYS AS (json_extract(summary,'$.alias')) VIRTUAL"},
		{"request_metrics", "m_provider", "ALTER TABLE request_metrics ADD COLUMN m_provider TEXT GENERATED ALWAYS AS (json_extract(summary,'$.provider')) VIRTUAL"},
		{"request_metrics", "m_state", "ALTER TABLE request_metrics ADD COLUMN m_state TEXT GENERATED ALWAYS AS (json_extract(summary,'$.state')) VIRTUAL"},
		{"models", "fallback_model_id", "ALTER TABLE models ADD COLUMN fallback_model_id TEXT NOT NULL DEFAULT ''"},
		// NULL or 0 means unlimited; the previous release never writes these.
		{"projects", "rate_rpm", "ALTER TABLE projects ADD COLUMN rate_rpm INTEGER"},
		{"projects", "rate_burst", "ALTER TABLE projects ADD COLUMN rate_burst INTEGER"},
		{"projects", "max_concurrent", "ALTER TABLE projects ADD COLUMN max_concurrent INTEGER"},
	}
	for _, c := range columns {
		exists, err := columnExists(tx, c.table, c.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err = tx.Exec(c.ddl); err != nil {
				return err
			}
		}
	}
	if _, err = tx.Exec(`
 CREATE INDEX IF NOT EXISTS idx_metrics_project_started ON request_metrics(m_project,started DESC);
 CREATE INDEX IF NOT EXISTS idx_metrics_state_started ON request_metrics(m_state,started DESC);
 CREATE INDEX IF NOT EXISTS idx_metrics_model_started ON request_metrics(m_model,started DESC);
 CREATE TABLE IF NOT EXISTS usage_daily(day TEXT NOT NULL,project_id TEXT NOT NULL,project_name TEXT NOT NULL,model_id TEXT NOT NULL,alias TEXT NOT NULL,category TEXT NOT NULL,totals_json TEXT NOT NULL,PRIMARY KEY(day,project_id,model_id,alias,category));
 CREATE TABLE IF NOT EXISTS connection_health(connection_id TEXT NOT NULL,bucket INTEGER NOT NULL,ok INTEGER NOT NULL,failed INTEGER NOT NULL,rate_limited INTEGER NOT NULL,auth_failed INTEGER NOT NULL,probes INTEGER NOT NULL,probe_failed INTEGER NOT NULL,PRIMARY KEY(connection_id,bucket));
 CREATE TABLE IF NOT EXISTS maintenance_log(id INTEGER PRIMARY KEY AUTOINCREMENT,started INTEGER NOT NULL,kind TEXT NOT NULL,detail_json TEXT NOT NULL);
 `); err != nil {
		return err
	}
	if current < 11 {
		// Calls logged before monitoring existed only had a body row. Copy their
		// summaries so request_metrics becomes the single summary source and
		// body rows can expire without losing statistics.
		if _, err = tx.Exec(`INSERT OR IGNORE INTO request_metrics(id,started,summary) SELECT id,started,summary FROM requests r WHERE NOT EXISTS(SELECT 1 FROM request_metrics m WHERE m.id=r.id)`); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("INSERT INTO meta(key,value) VALUES('schema_ext',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", fmt.Sprint(schemaExtVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

// enableIncrementalVacuum switches an existing database to incremental
// auto-vacuum once. Switching requires one full VACUUM, which runs before the
// server accepts calls; afterwards freed pages are returned in small steps.
func enableIncrementalVacuum(db *sql.DB) (bool, error) {
	var mode int
	if err := db.QueryRow("PRAGMA auto_vacuum").Scan(&mode); err != nil {
		return false, err
	}
	if mode == 2 {
		return false, nil
	}
	if _, err := db.Exec("PRAGMA auto_vacuum=INCREMENTAL"); err != nil {
		return false, err
	}
	if _, err := db.Exec("VACUUM"); err != nil {
		return false, err
	}
	return true, nil
}
