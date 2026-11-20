package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

const (
	uninstallRegPath = `Software\Microsoft\Windows\CurrentVersion\Uninstall\LightMD`
	appVersion       = "1.0.0"
	appPublisher     = "LightMD"
)

type AppInstallStatus struct {
	Installed        bool   `json:"installed"`
	RunningInstalled bool   `json:"runningInstalled"`
	InstallExePath   string `json:"installExePath"`
	DesktopShortcut  bool   `json:"desktopShortcut"`
	StartMenuShortcut bool  `json:"startMenuShortcut"`
}

func getInstallDir() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData, _ = os.UserConfigDir()
	}
	return filepath.Join(localAppData, "Programs", "LightMD")
}

func getInstalledExePath() string {
	return filepath.Join(getInstallDir(), "LightMD.exe")
}

func getDesktopShortcutPath() string {
	profile := os.Getenv("USERPROFILE")
	if profile == "" {
		profile, _ = os.UserHomeDir()
	}
	return filepath.Join(profile, "Desktop", "LightMD.lnk")
}

func getStartMenuShortcutPath() string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return ""
	}
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "LightMD.lnk")
}

func getAppInstallStatus() AppInstallStatus {
	target := getInstalledExePath()
	cur := getExePath()
	_, exeErr := os.Stat(target)
	_, deskErr := os.Stat(getDesktopShortcutPath())
	_, smErr := os.Stat(getStartMenuShortcutPath())

	return AppInstallStatus{
		Installed:         exeErr == nil,
		RunningInstalled:  strings.EqualFold(filepath.Clean(cur), filepath.Clean(target)),
		InstallExePath:    target,
		DesktopShortcut:   deskErr == nil,
		StartMenuShortcut: smErr == nil,
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	return os.Rename(tmp, dst)
}

func createShortcut(lnkPath, targetExe, workingDir, description string) error {
	if lnkPath == "" {
		return nil
	}
	_ = os.MkdirAll(filepath.Dir(lnkPath), 0o755)
	esc := func(s string) string {
		return strings.ReplaceAll(s, "'", "''")
	}
	script := fmt.Sprintf(
		`$ws = New-Object -ComObject WScript.Shell; `+
			`$s = $ws.CreateShortcut('%s'); `+
			`$s.TargetPath = '%s'; `+
			`$s.WorkingDirectory = '%s'; `+
			`$s.IconLocation = '%s,0'; `+
			`$s.Description = '%s'; `+
			`$s.Save()`,
		esc(lnkPath), esc(targetExe), esc(workingDir), esc(targetExe), esc(description),
	)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
}

func installApp() (AppInstallStatus, error) {
	curExe := getExePath()
	if curExe == "" {
		return AppInstallStatus{}, fmt.Errorf("无法定位当前程序路径")
	}
	installDir := getInstallDir()
	targetExe := getInstalledExePath()

	if !strings.EqualFold(filepath.Clean(curExe), filepath.Clean(targetExe)) {
		if err := copyFile(curExe, targetExe); err != nil {
			return AppInstallStatus{}, fmt.Errorf("复制程序到应用目录失败：%w", err)
		}
	}

	// 1. Create Start Menu & Desktop shortcuts
	if err := createShortcut(getStartMenuShortcutPath(), targetExe, installDir, "LightMD — 轻量化 Markdown 阅读与编辑软件"); err != nil {
		return AppInstallStatus{}, fmt.Errorf("创建开始菜单快捷方式失败：%w", err)
	}
	if err := createShortcut(getDesktopShortcutPath(), targetExe, installDir, "LightMD — 轻量化 Markdown 阅读与编辑软件"); err != nil {
		return AppInstallStatus{}, fmt.Errorf("创建桌面快捷方式失败：%w", err)
	}

	// 2. Register in Windows "Installed Apps" (Add/Remove Programs)
	_ = setRegString(uninstallRegPath, "DisplayName", "LightMD")
	_ = setRegString(uninstallRegPath, "DisplayVersion", appVersion)
	_ = setRegString(uninstallRegPath, "Publisher", appPublisher)
	_ = setRegString(uninstallRegPath, "DisplayIcon", fmt.Sprintf(`"%s",0`, targetExe))
	_ = setRegString(uninstallRegPath, "InstallLocation", installDir)
	_ = setRegString(uninstallRegPath, "UninstallString", fmt.Sprintf(`"%s" --uninstall`, targetExe))
	_ = setRegDword(uninstallRegPath, "NoModify", 1)
	_ = setRegDword(uninstallRegPath, "NoRepair", 1)
	if info, err := os.Stat(targetExe); err == nil {
		_ = setRegDword(uninstallRegPath, "EstimatedSize", uint32(info.Size()/1024))
	}

	// 3. Register .md / .markdown file association pointing to installed exe
	_, _ = registerFileAssociationForExe(targetExe)

	// 4. Register Explorer right-click "New -> Markdown 文档" (ShellNew)
	_ = setRegString(`Software\Classes\.md\ShellNew`, "NullFile", "")

	notifyShellAssocChanged()
	return getAppInstallStatus(), nil
}

func uninstallApp() error {
	_ = unregisterFileAssociation()
	_ = registry.DeleteKey(registry.CURRENT_USER, `Software\Classes\.md\ShellNew`)
	deleteRegTree(uninstallRegPath)

	_ = os.Remove(getDesktopShortcutPath())
	if sm := getStartMenuShortcutPath(); sm != "" {
		_ = os.Remove(sm)
	}

	targetExe := getInstalledExePath()
	curExe := getExePath()
	installDir := getInstallDir()

	if strings.EqualFold(filepath.Clean(curExe), filepath.Clean(targetExe)) {
		// Schedule self-deletion after process exits
		cmd := exec.Command("cmd.exe", "/c", fmt.Sprintf(`ping 127.0.0.1 -n 2 >nul & del /f /q "%s" & rmdir "%s"`, targetExe, installDir))
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		_ = cmd.Start()
	} else {
		_ = os.Remove(targetExe)
		_ = os.Remove(installDir)
	}

	notifyShellAssocChanged()
	return nil
}

func setRegDword(path, name string, value uint32) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetDWordValue(name, value)
}
