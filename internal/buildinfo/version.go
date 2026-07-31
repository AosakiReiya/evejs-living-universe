package buildinfo

// Version is injected at build time via:
//
//	go build -ldflags "-X github.com/AosakiReiya/evejs-living-universe/internal/buildinfo.Version=$(cat VERSION)"
var Version = "dev"
