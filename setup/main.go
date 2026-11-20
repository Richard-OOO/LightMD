package main

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

//go:embed LightMD.exe.gz
var embeddedExeGZ []byte

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
)

const (
	mbOK              = 0x00000000
	mbYesNo           = 0x00000004
	mbIconError       = 0x00000010
	mbIconQuestion    = 0x00000020
	mbIconInformation = 0x00000040
	idYes             = 6
)

func msgBox(title, text string, flags uint32) int {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(text)
	ret, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), uintptr(flags))
	return int(ret)
}

func getInstallDir() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData, _ = os.UserConfigDir()
	}
	return filepath.Join(localAppData, "Programs", "LightMD")
}

func extractGzipExe(dst string) error {
	gr, err := gzip.NewReader(bytes.NewReader(embeddedExeGZ))
	if err != nil {
		return err
	}
	defer gr.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, gr)
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

func main() {
	silent := flag.Bool("silent", false, "静默安装（不弹出提示框）")
	silentSlash := flag.Bool("S", false, "静默安装")
	flag.Parse()
	isSilent := *silent || *silentSlash

	installDir := getInstallDir()
	targetExe := filepath.Join(installDir, "LightMD.exe")

	if !isSilent {
		prompt := fmt.Sprintf(
			"欢迎使用 LightMD 安装向导！\n\n"+
				"将把 LightMD（轻量化 Markdown 阅读与编辑软件）安装到：\n%s\n\n"+
				"安装内容：\n"+
				"• 创建桌面快捷方式与开始菜单图标\n"+
				"• 注册到 Windows「设置 → 应用」（支持随时卸载）\n"+
				"• 注册 .md 文件打开方式及右键「新建 Markdown 文档」\n\n"+
				"是否立即安装？",
			installDir,
		)
		if msgBox("LightMD 安装向导", prompt, mbYesNo|mbIconQuestion) != idYes {
			return
		}
	}

	if err := extractGzipExe(targetExe); err != nil {
		if !isSilent {
			msgBox("LightMD 安装失败", "释放程序文件失败：\n"+err.Error()+"\n\n如果 LightMD 正在运行，请先关闭后再试。", mbOK|mbIconError)
		}
		os.Exit(1)
	}

	cmd := exec.Command(targetExe, "--install", "--silent")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Run(); err != nil {
		if !isSilent {
			msgBox("LightMD 安装失败", "注册桌面应用与快捷方式失败：\n"+err.Error(), mbOK|mbIconError)
		}
		os.Exit(1)
	}

	if !isSilent {
		res := msgBox(
			"LightMD 安装完成",
			"LightMD 已成功安装到您的电脑！\n\n"+
				"• 双击桌面上的「LightMD」图标即可打开\n"+
				"• 右键任意 .md 文件 → 打开方式 → 选择 LightMD →「始终」，即可双击 .md 直接阅读与编辑\n\n"+
				"是否立即启动 LightMD？",
			mbYesNo|mbIconInformation,
		)
		if res == idYes {
			launch := exec.Command(targetExe)
			_ = launch.Start()
		}
	}
}
