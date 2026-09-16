package gateway

import (
	"database/sql"
	"errors"
	"slices"
)

var supportedProtocols = []string{"chat", "messages"}

func migrateProtocolEndpoints(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`
ALTER TABLE connections ADD COLUMN endpoints_json TEXT NOT NULL DEFAULT '{}';
UPDATE connections SET endpoints_json=json_object(protocol,base_url);
ALTER TABLE models ADD COLUMN protocols_json TEXT NOT NULL DEFAULT '[]';
UPDATE models SET protocols_json=json_array((SELECT protocol FROM connections WHERE id=models.connection_id));
PRAGMA user_version=5;`)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func endpointProtocols(endpoints map[string]string) []string {
	protocols := []string{}
	for _, protocol := range supportedProtocols {
		if endpoints[protocol] != "" {
			protocols = append(protocols, protocol)
		}
	}
	return protocols
}

func availableProtocols(m Model, c Connection) []string {
	protocols := []string{}
	for _, protocol := range endpointProtocols(c.Endpoints) {
		if slices.Contains(m.Protocols, protocol) {
			protocols = append(protocols, protocol)
		}
	}
	return protocols
}

func selectProtocol(m Model, c Connection, protocol string) (Connection, error) {
	if !slices.Contains(supportedProtocols, protocol) {
		return c, errors.New("不支持的调用协议")
	}
	if c.Endpoints[protocol] == "" {
		return c, errors.New("厂商连接未配置此协议的端点")
	}
	if !slices.Contains(m.Protocols, protocol) {
		return c, errors.New("模型未启用此调用协议")
	}
	c.Protocol, c.BaseURL = protocol, c.Endpoints[protocol]
	return c, nil
}
