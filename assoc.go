package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	progID         = "LightMD.Markdown"
	progDesc       = "Markdown Document (LightMD)"
	appExeRegName  = "LightMD.exe"
	shcneAssocChg  = 0x08000000
	shcnfIdList    = 0x0000
)

var (
	shell32            = windows.NewLazySystemDLL("shell32.dll")
	procSHChangeNotify = shell32.NewProc("SHChangeNotify")
)

type AssocStatus struct {
	Registered       bool   `json:"registered"`
	UserChoiceProgID string `json:"userChoiceProgId"`
	IsDefault        bool   `json:"isDefault"`
	ExePath          string `json:"exePath"`
}

func notifyShellAssocChanged() {
	procSHChangeNotify.Call(uintptr(shcneAssocChg), uintptr(shcnfIdList), 0, 0)
}

func getExePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err == nil {
		return resolved
	}
	return exe
}

func getAssocStatus() AssocStatus {
	exe := getExePath()
	st := AssocStatus{ExePath: exe}

	// Check if our ProgID command points to current exe
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+progID+`\shell\open\command`, registry.QUERY_VALUE)
	if err == nil {
		val, _, err := k.GetStringValue("")
		k.Close()
		if err == nil && strings.Contains(strings.ToLower(val), strings.ToLower(exe)) {
			st.Registered = true
		}
	}

	// Check Windows UserChoice for .md (Windows 10/11 default app override)
	ucKey, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice`, registry.QUERY_VALUE)
	if err == nil {
		if uc, _, err := ucKey.GetStringValue("ProgId"); err == nil {
			st.UserChoiceProgID = uc
		}
		ucKey.Close()
	}

	if st.Registered {
		if st.UserChoiceProgID == "" || strings.EqualFold(st.UserChoiceProgID, progID) || strings.Contains(strings.ToLower(st.UserChoiceProgID), "lightmd") {
			st.IsDefault = true
		}
	}

	return st
}

func registerFileAssociation() (AssocStatus, error) {
	return registerFileAssociationForExe(getExePath())
}

func registerFileAssociationForExe(exe string) (AssocStatus, error) {
	if exe == "" {
		return AssocStatus{}, fmt.Errorf("无法获取程序路径")
	}
	openCmd := fmt.Sprintf(`"%s" "%%1"`, exe)
	iconVal := fmt.Sprintf(`"%s",0`, exe)

	// 1. Register ProgID under HKCU\Software\Classes\LightMD.Markdown
	if err := setRegString(`Software\Classes\`+progID, "", progDesc); err != nil {
		return AssocStatus{}, err
	}
	if err := setRegString(`Software\Classes\`+progID+`\DefaultIcon`, "", iconVal); err != nil {
		return AssocStatus{}, err
	}
	if err := setRegString(`Software\Classes\`+progID+`\shell\open`, "", "使用 LightMD 打开"); err != nil {
		return AssocStatus{}, err
	}
	if err := setRegString(`Software\Classes\`+progID+`\shell\open\command`, "", openCmd); err != nil {
		return AssocStatus{}, err
	}

	// 2. Register Applications\LightMD.exe for "Open With" dialog
	if err := setRegString(`Software\Classes\Applications\`+appExeRegName, "FriendlyAppName", "LightMD 轻量化阅读器"); err != nil {
		return AssocStatus{}, err
	}
	if err := setRegString(`Software\Classes\Applications\`+appExeRegName+`\shell\open\command`, "", openCmd); err != nil {
		return AssocStatus{}, err
	}
	_ = setRegString(`Software\Classes\Applications\`+appExeRegName+`\SupportedTypes`, ".md", "")
	_ = setRegString(`Software\Classes\Applications\`+appExeRegName+`\SupportedTypes`, ".markdown", "")
	_ = setRegString(`Software\Classes\Applications\`+appExeRegName+`\SupportedTypes`, ".mdown", "")

	// 3. Register extensions .md and .markdown under HKCU\Software\Classes
	for _, ext := range []string{".md", ".markdown"} {
		if err := setRegString(`Software\Classes\`+ext, "", progID); err != nil {
			return AssocStatus{}, err
		}
		_ = setRegString(`Software\Classes\`+ext, "Content Type", "text/markdown")
		_ = setRegString(`Software\Classes\`+ext, "PerceivedType", "text")
		_ = setRegString(`Software\Classes\`+ext+`\OpenWithProgids`, progID, "")
	}

	notifyShellAssocChanged()
	return getAssocStatus(), nil
}

func unregisterFileAssociation() error {
	for _, ext := range []string{".md", ".markdown"} {
		// Only clear default value if it currently points to our progID
		if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+ext, registry.QUERY_VALUE|registry.SET_VALUE); err == nil {
			if val, _, err := k.GetStringValue(""); err == nil && val == progID {
				_ = k.DeleteValue("")
			}
			k.Close()
		}
		if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+ext+`\OpenWithProgids`, registry.SET_VALUE); err == nil {
			_ = k.DeleteValue(progID)
			k.Close()
		}
	}

	deleteRegTree(`Software\Classes\` + progID)
	deleteRegTree(`Software\Classes\Applications\` + appExeRegName)

	notifyShellAssocChanged()
	return nil
}

func setRegString(path, name, value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}

func deleteRegTree(path string) {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return
	}
	subkeys, _ := k.ReadSubKeyNames(-1)
	k.Close()
	for _, sub := range subkeys {
		deleteRegTree(path + `\` + sub)
	}
	_ = registry.DeleteKey(registry.CURRENT_USER, path)
}

func showMessageBox(title, text string, flags uint32) {
	tPtr, _ := windows.UTF16PtrFromString(title)
	mPtr, _ := windows.UTF16PtrFromString(text)
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(mPtr)), uintptr(unsafe.Pointer(tPtr)), uintptr(flags))
}
