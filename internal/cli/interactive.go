package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/AosakiReiya/evejs-living-universe/internal/buildinfo"
)

// interactive presents the menu-driven interface used when the binary is
// double-clicked.
func interactive(dataRootFlag string) int {
	in := bufio.NewReader(os.Stdin)

	_, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}

	for {
		fmt.Printf("\nX-Eve Living Universe Patch Manager v%s\n", buildinfo.Version)
		fmt.Printf("Target EveJS: %s\n\n", m.Release.EveJS)
		fmt.Println("1. Install")
		fmt.Println("2. Verify")
		fmt.Println("3. Repair")
		fmt.Println("4. Uninstall")
		fmt.Println("5. Status")
		fmt.Println("6. Exit")
		fmt.Println()
		fmt.Print("> ")

		line, err := in.ReadString('\n')
		if err != nil {
			return 0
		}
		choice := strings.TrimSpace(line)
		switch choice {
		case "1", "install":
			target, err := readLine(in, "EveJS path: ")
			if err != nil {
				return 1
			}
			cmdInstall(dataRootFlag, []string{target})
		case "2", "verify":
			target, err := readLine(in, "EveJS path (or 'integrity' for release data): ")
			if err != nil {
				return 1
			}
			if strings.EqualFold(target, "integrity") {
				cmdVerify(dataRootFlag, []string{"--integrity"})
			} else {
				cmdVerify(dataRootFlag, []string{target})
			}
		case "3", "repair":
			target, err := readLine(in, "EveJS path: ")
			if err != nil {
				return 1
			}
			cmdRepair(dataRootFlag, []string{target})
		case "4", "uninstall":
			target, err := readLine(in, "EveJS path: ")
			if err != nil {
				return 1
			}
			cmdUninstall(dataRootFlag, []string{target})
		case "5", "status":
			target, err := readLine(in, "EveJS path: ")
			if err != nil {
				return 1
			}
			cmdStatus(dataRootFlag, []string{target})
		case "6", "exit", "quit", "q":
			return 0
		default:
			fmt.Println("Unknown choice. Enter a number 1-6.")
		}
	}
}
