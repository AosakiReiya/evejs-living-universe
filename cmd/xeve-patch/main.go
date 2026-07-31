package main

import (
	"os"

	"github.com/AosakiReiya/evejs-living-universe/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:]))
}
