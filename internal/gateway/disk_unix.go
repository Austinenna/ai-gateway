//go:build linux || darwin

package gateway

import "syscall"

// diskSpace reports the space available to this process on the data volume.
func diskSpace(path string) (free, total int64, ok bool) {
	var s syscall.Statfs_t
	if syscall.Statfs(path, &s) != nil {
		return 0, 0, false
	}
	size := int64(s.Bsize)
	return int64(s.Bavail) * size, int64(s.Blocks) * size, true
}
