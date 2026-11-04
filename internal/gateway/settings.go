package gateway

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// Settings are administrator-tunable operating parameters stored in meta.
type Settings struct {
	// Retention
	BodyDays    int `json:"body_days"`
	SummaryDays int `json:"summary_days"`
	CleanupHour int `json:"cleanup_hour"`
	// Connection health
	HealthWindowMinutes int     `json:"health_window_minutes"`
	DegradedRatio       float64 `json:"degraded_ratio"`
	DownStreak          int     `json:"down_streak"`
	ProbeIdleMinutes    int     `json:"probe_idle_minutes"`
	BreakerSeconds      int     `json:"breaker_seconds"`
	// Defaults applied to newly created projects; 0 means unlimited.
	DefaultRPM        int `json:"default_rpm"`
	DefaultConcurrent int `json:"default_concurrent"`
}

// minSummaryDays keeps the whole current month available for budget checks.
const minSummaryDays = 62

func defaultSettings() Settings {
	return Settings{BodyDays: 30, SummaryDays: 180, CleanupHour: 4, HealthWindowMinutes: 10, DegradedRatio: 0.3, DownStreak: 3, ProbeIdleMinutes: 10, BreakerSeconds: 60, DefaultRPM: 60, DefaultConcurrent: 4}
}

func (s Settings) validate() error {
	switch {
	case s.BodyDays < 1 || s.BodyDays > 3650:
		return errors.New("请求正文保留天数必须为 1 到 3650")
	case s.SummaryDays < minSummaryDays || s.SummaryDays > 3650:
		return errors.New("监控摘要保留天数必须为 62 到 3650，本月预算需要完整的当月数据")
	case s.BodyDays > s.SummaryDays:
		return errors.New("请求正文保留天数不能超过监控摘要保留天数")
	case s.CleanupHour < 0 || s.CleanupHour > 23:
		return errors.New("清理时间必须为 0 到 23 点")
	case s.HealthWindowMinutes < 1 || s.HealthWindowMinutes > 120:
		return errors.New("健康检查窗口必须为 1 到 120 分钟")
	case s.DegradedRatio <= 0 || s.DegradedRatio > 1:
		return errors.New("降级失败率必须大于 0 且不超过 1")
	case s.DownStreak < 1 || s.DownStreak > 100:
		return errors.New("故障判定的连续失败次数必须为 1 到 100")
	case s.ProbeIdleMinutes < 0 || s.ProbeIdleMinutes > 1440:
		return errors.New("主动探测间隔必须为 0 到 1440 分钟，0 表示关闭")
	case s.BreakerSeconds < 1 || s.BreakerSeconds > 3600:
		return errors.New("熔断时长必须为 1 到 3600 秒")
	case s.DefaultRPM < 0 || s.DefaultRPM > maxRateLimit || s.DefaultConcurrent < 0 || s.DefaultConcurrent > maxConcurrentLimit:
		return errors.New("新项目默认限速超出范围")
	}
	return nil
}

func loadSettings(db *sql.DB) (Settings, error) {
	s := defaultSettings()
	var raw string
	err := db.QueryRow("SELECT value FROM meta WHERE key='settings'").Scan(&raw)
	if err == sql.ErrNoRows {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	// Unknown or missing fields keep their defaults.
	if err = json.Unmarshal([]byte(raw), &s); err != nil {
		return defaultSettings(), nil
	}
	if s.validate() != nil {
		return defaultSettings(), nil
	}
	return s, nil
}

func (g *Gateway) currentSettings() Settings {
	g.settingsMu.RLock()
	defer g.settingsMu.RUnlock()
	return g.settings
}

func (g *Gateway) saveSettings(w http.ResponseWriter, r *http.Request) {
	s := g.currentSettings()
	if !decode(w, r, &s) {
		return
	}
	if err := s.validate(); err != nil {
		problem(w, 400, err.Error())
		return
	}
	raw, _ := json.Marshal(s)
	if _, err := g.db.Exec("INSERT INTO meta(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(raw)); err != nil {
		problem(w, 500, "保存设置失败")
		return
	}
	g.settingsMu.Lock()
	g.settings = s
	g.settingsMu.Unlock()
	g.wakeMaintenance()
	writeJSON(w, 200, s)
}
