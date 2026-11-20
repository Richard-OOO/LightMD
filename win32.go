package main

import (
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                        = windows.NewLazySystemDLL("user32.dll")
	comdlg32                      = windows.NewLazySystemDLL("comdlg32.dll")
	procMessageBoxW               = user32.NewProc("MessageBoxW")
	procGetOpenFileNameW          = comdlg32.NewProc("GetOpenFileNameW")
	procGetSaveFileNameW          = comdlg32.NewProc("GetSaveFileNameW")
	procShellExecuteW             = shell32.NewProc("ShellExecuteW")
	procSetProcessDpiAwareCtx     = user32.NewProc("SetProcessDpiAwarenessContext")
	procCreateIconFromResourceEx  = user32.NewProc("CreateIconFromResourceEx")
	procSendMessageW              = user32.NewProc("SendMessageW")
	procGetWindowLongPtrW         = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW         = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW           = user32.NewProc("CallWindowProcW")
	procDragAcceptFiles           = shell32.NewProc("DragAcceptFiles")
	procDragQueryFileW            = shell32.NewProc("DragQueryFileW")
	procDragFinish                = shell32.NewProc("DragFinish")
	procSetAppUserModelID         = shell32.NewProc("SetCurrentProcessExplicitAppUserModelID")
)

const (
	ofnFileMustExist = 0x00001000
	ofnPathMustExist = 0x00000800
	ofnOverwritePmt  = 0x00000002
	ofnNoChangeDir   = 0x00000008
	wmSetIcon        = 0x0080
	iconSmall        = 0
	iconBig          = 1
	swShowNormal     = 1
)

type openFileNameW struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        unsafe.Pointer
	dwReserved        uint32
	flagsEx           uint32
}

func enablePerMonitorDPI() {
	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
	const dpiAwareV2 = ^uintptr(3)
	if procSetProcessDpiAwareCtx.Find() == nil {
		procSetProcessDpiAwareCtx.Call(dpiAwareV2)
	}
}

func setAppUserModelID(id string) {
	if procSetAppUserModelID.Find() == nil {
		p, _ := windows.UTF16PtrFromString(id)
		procSetAppUserModelID.Call(uintptr(unsafe.Pointer(p)))
	}
}

func buildFilterUTF16(pairs ...string) *uint16 {
	var buf []uint16
	for _, s := range pairs {
		u, _ := windows.UTF16FromString(s)
		buf = append(buf, u...)
	}
	buf = append(buf, 0)
	return &buf[0]
}

func openMarkdownFileDialog(hwnd uintptr, initialDir string) string {
	fileBuf := make([]uint16, 4096)
	filter := buildFilterUTF16(
		"Markdown 文件 (*.md;*.markdown;*.txt)", "*.md;*.markdown;*.mdown;*.txt",
		"所有文件 (*.*)", "*.*",
	)
	title, _ := windows.UTF16PtrFromString("打开 Markdown 文件")
	var initDirPtr *uint16
	if initialDir != "" {
		initDirPtr, _ = windows.UTF16PtrFromString(initialDir)
	}

	ofn := openFileNameW{
		hwndOwner:       hwnd,
		lpstrFilter:     filter,
		nFilterIndex:    1,
		lpstrFile:       &fileBuf[0],
		nMaxFile:        uint32(len(fileBuf)),
		lpstrInitialDir: initDirPtr,
		lpstrTitle:      title,
		flags:           ofnFileMustExist | ofnPathMustExist | ofnNoChangeDir,
	}
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))

	ret, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		return ""
	}
	return windows.UTF16ToString(fileBuf)
}

func saveMarkdownFileDialog(hwnd uintptr, initialDir, suggestedName string) string {
	return saveDialogWithFilter(
		hwnd,
		initialDir,
		suggestedName,
		"另存为 Markdown 文件",
		"md",
		"Markdown 文件 (*.md)", "*.md",
		"所有文件 (*.*)", "*.*",
	)
}

func saveExportFileDialog(hwnd uintptr, initialDir, suggestedName, title, defExt, filterDesc, filterPat string) string {
	return saveDialogWithFilter(hwnd, initialDir, suggestedName, title, defExt, filterDesc, filterPat, "所有文件 (*.*)", "*.*")
}

func saveDialogWithFilter(hwnd uintptr, initialDir, suggestedName, dialogTitle, defaultExt string, filterPairs ...string) string {
	fileBuf := make([]uint16, 4096)
	if suggestedName != "" {
		u, _ := windows.UTF16FromString(suggestedName)
		copy(fileBuf, u)
	}
	filter := buildFilterUTF16(filterPairs...)
	title, _ := windows.UTF16PtrFromString(dialogTitle)
	defExt, _ := windows.UTF16PtrFromString(defaultExt)
	var initDirPtr *uint16
	if initialDir != "" {
		initDirPtr, _ = windows.UTF16PtrFromString(initialDir)
	}

	ofn := openFileNameW{
		hwndOwner:       hwnd,
		lpstrFilter:     filter,
		nFilterIndex:    1,
		lpstrFile:       &fileBuf[0],
		nMaxFile:        uint32(len(fileBuf)),
		lpstrInitialDir: initDirPtr,
		lpstrTitle:      title,
		lpstrDefExt:     defExt,
		flags:           ofnPathMustExist | ofnOverwritePmt | ofnNoChangeDir,
	}
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))

	ret, _, _ := procGetSaveFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		return ""
	}
	return windows.UTF16ToString(fileBuf)
}

func openURLInBrowser(target string) {
	verb, _ := windows.UTF16PtrFromString("open")
	urlPtr, _ := windows.UTF16PtrFromString(target)
	procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(urlPtr)),
		0,
		0,
		uintptr(swShowNormal),
	)
}

func revealInExplorer(path string) {
	if path == "" {
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	cmd := exec.Command("explorer.exe", "/select,"+abs)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Start()
}

func setWindowIconFromPNG(hwnd uintptr, pngData []byte) {
	if hwnd == 0 || len(pngData) == 0 {
		return
	}
	// CreateIconFromResourceEx supports PNG-encoded icons since Windows Vista (ver 0x00030000)
	hIconBig, _, _ := procCreateIconFromResourceEx.Call(
		uintptr(unsafe.Pointer(&pngData[0])),
		uintptr(len(pngData)),
		1,          // TRUE = icon
		0x00030000, // version
		64, 64,     // desired size
		0,
	)
	if hIconBig != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconBig, hIconBig)
	}
	hIconSmall, _, _ := procCreateIconFromResourceEx.Call(
		uintptr(unsafe.Pointer(&pngData[0])),
		uintptr(len(pngData)),
		1,
		0x00030000,
		32, 32,
		0,
	)
	if hIconSmall != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, hIconSmall)
	}
}
