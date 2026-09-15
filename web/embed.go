package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

func Assets() fs.FS { f, _ := fs.Sub(files, "dist"); return f }
