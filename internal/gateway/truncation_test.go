package gateway

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCaptureAndStoredTruncationScopes(t *testing.T) {
	c := capture{}
	c.add([]byte(strings.Repeat("x", maxLog+1)))
	if !c.truncated || len(c.data) != maxLog {
		t.Fatalf("capture limit not tracked: truncated=%v bytes=%d", c.truncated, len(c.data))
	}

	old := Record{Truncated: true, Input: strings.Repeat("x", maxLog), Output: "short"}
	old.normalizeStoredTruncation()
	if !old.InputTruncated || old.OutputTruncated || !old.Truncated {
		t.Fatalf("legacy input truncation not inferred: %+v", old)
	}

	utf8Input := strings.Repeat("中", maxLog)
	trimmed := truncateUTF8(utf8Input, maxLog)
	if len(trimmed) > maxLog || !strings.HasPrefix(utf8Input, trimmed) {
		t.Fatalf("UTF-8 truncation exceeded limit or changed prefix: %d", len(trimmed))
	}
	if !utf8.ValidString(trimmed) {
		t.Fatal("UTF-8 truncation produced invalid text")
	}
}
