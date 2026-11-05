//go:build !linux && !darwin

package gateway

func diskSpace(string) (free, total int64, ok bool) { return 0, 0, false }
