// Package safepath implements the path-safety rules shared by every patch
// operation. A patch must never touch anything outside its EveJS target tree,
// must never traverse a junction/symlink, and must never reach protected
// runtime data, certificates, logs, or secrets.
package safepath

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	drivePrefix     = regexp.MustCompile(`^[A-Za-z]:`)
	windowsChars    = regexp.MustCompile(`[:*?"<>|\x00]`)
	dotEnvRe        = regexp.MustCompile(`(?i)(^|/)\.env(?:\.|$)`)
	sqliteRe        = regexp.MustCompile(`(?i)\.sqlite(?:\d+)?(?:$|[-.])`)
	gameStoreDataRe = regexp.MustCompile(`(?i)^server/src/gameStore/data/`)
)

// ValidateRel checks that a manifest path is a portable, relative, safe path
// and rejects protected runtime locations.
func ValidateRel(rel string) error {
	if rel == "" {
		return fmt.Errorf("manifest contains an empty file path")
	}
	if strings.Contains(rel, `\`) {
		return fmt.Errorf("manifest paths must use forward slashes: %s", rel)
	}
	rel = strings.ReplaceAll(rel, `\`, `/`)
	if strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\\`) || drivePrefix.MatchString(rel) {
		return fmt.Errorf("manifest path must be relative: %s", rel)
	}
	for _, segment := range strings.Split(rel, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("manifest path contains an unsafe segment: %s", rel)
		}
		if strings.Contains(segment, ":") || strings.ContainsRune(segment, '\x00') {
			return fmt.Errorf("manifest path contains an unsafe character: %s", rel)
		}
	}
	lower := strings.ToLower(rel)
	if strings.HasPrefix(lower, "_local/") {
		return fmt.Errorf("the patch manifest attempts to touch protected runtime data: %s", rel)
	}
	if regexp.MustCompile(`(?i)(^|/)(certs?|logs?)(/|$)`).MatchString(rel) {
		return fmt.Errorf("the patch manifest attempts to touch certificates or logs: %s", rel)
	}
	if dotEnvRe.MatchString(rel) {
		return fmt.Errorf("the patch manifest attempts to touch environment/secret files: %s", rel)
	}
	if sqliteRe.MatchString(rel) {
		return fmt.Errorf("the patch manifest attempts to touch a live database: %s", rel)
	}
	if gameStoreDataRe.MatchString(rel) && rel != "server/src/gameStore/data/liveEventDefinitions/data.json" {
		return fmt.Errorf("the patch manifest attempts to touch runtime game data: %s", rel)
	}
	return nil
}

// ResolveChild joins a relative path to a root and verifies the result stays
// inside the root and never crosses a symlink/junction.
func ResolveChild(root, rel string) (string, error) {
	if err := ValidateRel(rel); err != nil {
		return "", err
	}
	native := strings.ReplaceAll(rel, "/", string(filepath.Separator))
	candidate := filepath.Join(root, native)
	clean, err := filepath.Abs(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve path %s: %w", rel, err)
	}
	prefix := strings.TrimRight(root, `/\`) + string(filepath.Separator)
	if !strings.HasPrefix(clean, prefix) && clean != strings.TrimRight(root, `/\`) {
		return "", fmt.Errorf("path escapes its permitted root: %s", rel)
	}
	if err := AssertNoSymlink(root, clean); err != nil {
		return "", err
	}
	return clean, nil
}

// AssertNoSymlink walks each path segment below root and refuses to traverse a
// symlink or other non-regular-directory junction.
func AssertNoSymlink(root, candidate string) error {
	rootClean := filepath.Clean(root)
	candClean := filepath.Clean(candidate)
	if !strings.HasPrefix(candClean, rootClean+string(filepath.Separator)) {
		return nil
	}
	relative := strings.TrimPrefix(candClean, rootClean)
	relative = strings.Trim(relative, `/\`)
	if relative == "" {
		return nil
	}
	current := rootClean
	for _, segment := range strings.Split(relative, string(filepath.Separator)) {
		if segment == "" {
			continue
		}
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("cannot inspect path segment %s: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to traverse a symlink: %s", current)
		}
	}
	return nil
}

// CanonicalRoot validates and canonicalizes an EveJS target root.
func CanonicalRoot(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("EveJSPath must be supplied explicitly")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", fmt.Errorf("EveJSPath does not exist: %s", path)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("EveJSPath is not a directory: %s", path)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("EveJSPath cannot be a symbolic link: %s", path)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(abs)
	if filepath.Dir(clean) == clean {
		return "", fmt.Errorf("refusing to use a filesystem root as EveJSPath: %s", clean)
	}
	if home, err := os.UserHomeDir(); err == nil {
		homeClean := filepath.Clean(home)
		if strings.EqualFold(clean, homeClean) {
			return "", fmt.Errorf("refusing to use the user profile directory as EveJSPath: %s", clean)
		}
	}
	if err := AssertNoSymlink(filepath.Dir(clean), clean); err != nil {
		return "", fmt.Errorf("EveJSPath: %w", err)
	}
	return clean, nil
}
