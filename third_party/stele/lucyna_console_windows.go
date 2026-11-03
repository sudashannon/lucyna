package main

import (
	"os/exec"
	"syscall"
)

func hideLucynaConsole(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
