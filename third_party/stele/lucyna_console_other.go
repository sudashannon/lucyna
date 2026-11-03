//go:build !windows

package main

import "os/exec"

func hideLucynaConsole(command *exec.Cmd) {}
