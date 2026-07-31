// Package hashutil provides SHA-256 helpers used by the manifest and the
// install state.
package hashutil

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"strings"
)

// File returns the uppercase hex SHA-256 of a file's bytes.
func File(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return strings.ToUpper(hex.EncodeToString(h.Sum(nil))), size, nil
}

// Normalize uppercases a hex string; empty stays empty.
func Normalize(hexString string) string {
	return strings.ToUpper(hexString)
}
