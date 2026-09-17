package gateway

import (
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"reflect"
	"strings"
	"time"
)

// Prices are currency units per million tokens, attached to this model's
// connection. A request keeps its own immutable copy; later edits never reprice it.
type ModelPricing struct {
	Mode       string   `json:"mode"` // unconfigured, token, subscription
	Currency   string   `json:"currency,omitempty"`
	Input      *float64 `json:"input_per_million,omitempty"`
	Output     *float64 `json:"output_per_million,omitempty"`
	CacheMode  string   `json:"cache_mode,omitempty"` // uniform or separate
	CacheRead  *float64 `json:"cache_read_per_million,omitempty"`
	CacheWrite *float64 `json:"cache_write_per_million,omitempty"`
	Source     string   `json:"source,omitempty"`
	Note       string   `json:"note,omitempty"`
	UpdatedAt  int64    `json:"updated_at,omitempty"`
}

func preparePricing(p, old *ModelPricing) (*ModelPricing, error) {
	if p == nil { // Older clients can edit a model without erasing its pricing.
		return old, nil
	}
	p.Source, p.Note = strings.TrimSpace(p.Source), strings.TrimSpace(p.Note)
	if len(p.Source) > 2048 || len([]rune(p.Note)) > 500 {
		return nil, errors.New("价格来源或计费备注过长")
	}
	if p.Source != "" {
		u, err := url.Parse(p.Source)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
			return nil, errors.New("价格来源须为不含凭据的 HTTPS 链接")
		}
	}
	switch p.Mode {
	case "unconfigured":
		p = &ModelPricing{Mode: "unconfigured"}
	case "subscription":
		p = &ModelPricing{Mode: "subscription", Source: p.Source, Note: p.Note}
	case "token":
		if p.Currency != "CNY" && p.Currency != "USD" {
			return nil, errors.New("请选择人民币或美元，不同币种分别汇总")
		}
		if p.Input == nil || p.Output == nil {
			return nil, errors.New("请填写输入与输出单价；明确免费时填写 0")
		}
		if p.CacheMode != "uniform" && p.CacheMode != "separate" {
			return nil, errors.New("请选择缓存计价方式")
		}
		for _, rate := range []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite} {
			if rate != nil && (math.IsNaN(*rate) || math.IsInf(*rate, 0) || *rate < 0 || *rate > 1000000) {
				return nil, errors.New("单价须为 0 至 1000000 之间的有限数字")
			}
		}
		if p.CacheMode == "uniform" {
			p.CacheRead, p.CacheWrite = nil, nil
		}
	default:
		return nil, errors.New("不支持的计费方式")
	}
	p.UpdatedAt = 0
	if old != nil {
		previous := *old
		previous.UpdatedAt = 0
		if reflect.DeepEqual(p, &previous) {
			p.UpdatedAt = old.UpdatedAt
			return p, nil
		}
	}
	p.UpdatedAt = time.Now().UnixMilli()
	return p, nil
}

type CostLine struct {
	Kind   string  `json:"kind"`
	Tokens int64   `json:"tokens"`
	Rate   float64 `json:"rate"`
	Amount float64 `json:"amount"`
}

type RequestCost struct {
	Status   string        `json:"status"`
	Currency string        `json:"currency,omitempty"`
	Amount   *float64      `json:"amount"`
	Lines    []CostLine    `json:"lines,omitempty"`
	Missing  []string      `json:"missing,omitempty"`
	Pricing  *ModelPricing `json:"pricing,omitempty"`
}

func moneyRound(n float64) float64 { return math.Round(n*1e9) / 1e9 }

func calculateCost(r *Record) *RequestCost {
	c := &RequestCost{Status: "unconfigured"}
	if r.Cost != nil {
		c.Pricing = r.Cost.Pricing
	}
	if !r.Forwarded {
		c.Status = "not_forwarded"
		return c
	}
	if r.Provider == "demo" {
		c.Status = "demo"
		return c
	}
	p := c.Pricing
	if p == nil || p.Mode == "unconfigured" {
		return c
	}
	if p.Mode == "subscription" {
		c.Status = "subscription"
		return c
	}
	c.Currency = p.Currency
	add := func(kind string, tokens *int64, rate *float64) {
		if tokens == nil || *tokens < 0 {
			c.Missing = append(c.Missing, kind+"_usage")
			return
		}
		if rate == nil {
			// A reported zero bucket contributes exactly zero at any price.
			if *tokens != 0 {
				c.Missing = append(c.Missing, kind+"_price")
			}
			return
		}
		amount := moneyRound(float64(*tokens) * *rate / 1e6)
		c.Lines = append(c.Lines, CostLine{Kind: kind, Tokens: *tokens, Rate: *rate, Amount: amount})
		if c.Amount == nil {
			c.Amount = new(float64)
		}
		*c.Amount = moneyRound(*c.Amount + amount)
	}
	if p.CacheMode == "uniform" {
		add("input", r.InputTotal, p.Input)
	} else if r.Protocol == "chat" {
		// Chat cache reads are INCLUDED in prompt_tokens, not additional input.
		if r.InputTotal != nil && r.CacheRead != nil && *r.CacheRead <= *r.InputTotal {
			n := *r.InputTotal - *r.CacheRead
			add("input", &n, p.Input)
			add("cache_read", r.CacheRead, p.CacheRead)
		} else {
			c.Missing = append(c.Missing, "input_cache_split")
		}
	} else {
		if r.InputTotal == nil {
			c.Missing = append(c.Missing, "input_total")
		}
		add("input", r.InputUncached, p.Input)
		add("cache_read", r.CacheRead, p.CacheRead)
		if !r.minimaxAutoCache() || r.CacheWrite != nil {
			add("cache_write", r.CacheWrite, p.CacheWrite)
		}
	}
	if r.OutputReported {
		add("output", &r.OutputTokens, p.Output)
	} else {
		add("output", nil, p.Output)
	}
	if r.State != "complete" || !r.outputFinal {
		c.Missing = append(c.Missing, "final_usage")
	}
	c.Status = "complete"
	if len(c.Missing) > 0 {
		c.Status = "partial"
	}
	if c.Amount == nil {
		c.Status = "unknown"
	}
	return c
}

type CostAggregate struct {
	Amounts      map[string]float64 `json:"amounts"`
	Eligible     int                `json:"eligible"`
	Complete     int                `json:"complete"`
	Partial      int                `json:"partial"`
	Unconfigured int                `json:"unconfigured"`
	Unknown      int                `json:"unknown"`
	Subscription int                `json:"subscription"`
	Historical   int                `json:"historical"`
	Pending      int                `json:"pending"`
}

func (a *CostAggregate) add(r Record) {
	if a.Amounts == nil {
		a.Amounts = map[string]float64{}
	}
	if r.State == "running" {
		a.Pending++
		return
	}
	if r.Provider == "demo" || (r.State != "interrupted" && r.MetricsVersion > 0 && !r.Forwarded) {
		return
	}
	a.Eligible++
	c := r.Cost
	if c == nil {
		if r.State == "interrupted" {
			a.Unknown++
			return
		}
		a.Historical++
		return
	}
	switch c.Status {
	case "complete":
		a.Complete++
	case "partial":
		a.Partial++
	case "unconfigured":
		a.Unconfigured++
	case "subscription":
		a.Subscription++
	default:
		a.Unknown++
	}
	if c.Amount != nil && (c.Status == "complete" || c.Status == "partial") {
		a.Amounts[c.Currency] = moneyRound(a.Amounts[c.Currency] + *c.Amount)
	}
}

func decodePricing(s string) (*ModelPricing, error) {
	var p *ModelPricing
	err := json.Unmarshal([]byte(s), &p)
	return p, err
}
