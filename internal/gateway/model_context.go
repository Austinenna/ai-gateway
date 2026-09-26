package gateway

import "database/sql"

// Context windows describe model capacity for clients, not generation defaults.
// Zero means unspecified. Keep values within the portable signed 32-bit range.
const maxContextWindow = 2147483647

func migrateContextWindows(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`ALTER TABLE models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0 CHECK(context_window >= 0 AND context_window <= 2147483647); PRAGMA user_version=8;`); err != nil {
		return err
	}
	return tx.Commit()
}
