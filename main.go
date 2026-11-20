package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

//go:embed assets/*
var embeddedAssets embed.FS

//go:embed assets/icon.png
var appIconPNG []byte

type SiblingFile struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type FilePayload struct {
	FilePath string        `json:"filePath"`
	FileName string        `json:"fileName"`
	DirPath  string        `json:"dirPath"`
	Content  string        `json:"content"`
	Mtime    int64         `json:"mtime"`
	Siblings []SiblingFile `json:"siblings"`
	Recent   []string      `json:"recent"`
}

type InitPayload struct {
	File        *FilePayload     `json:"file"`
	Recent      []string         `json:"recent"`
	Assoc       AssocStatus      `json:"assoc"`
	Install     AppInstallStatus `json:"install"`
	Token       string           `json:"token"`
	InitialErr  string           `json:"initialErr,omitempty"`
}

type App struct {
	mu          sync.Mutex
	currentPath string
	token       string
	wv          webview2.WebView
	dataDir     string
	recentPath  string
}

func newApp() *App {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData, _ = os.UserConfigDir()
	}
	dataDir := filepath.Join(localAppData, "LightMD")
	_ = os.MkdirAll(dataDir, 0o755)

	tokBytes := make([]byte, 16)
	_, _ = rand.Read(tokBytes)

	return &App{
		token:      hex.EncodeToString(tokBytes),
		dataDir:    dataDir,
		recentPath: filepath.Join(dataDir, "recent.json"),
	}
}

func (a *App) loadRecent() []string {
	data, err := os.ReadFile(a.recentPath)
	if err != nil {
		return []string{}
	}
	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return []string{}
	}
	// Filter out missing files
	out := make([]string, 0, len(list))
	for _, p := range list {
		if _, err := os.Stat(p); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func (a *App) addRecent(path string) []string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	existing := a.loadRecent()
	out := []string{abs}
	for _, p := range existing {
		if !strings.EqualFold(p, abs) {
			out = append(out, p)
		}
		if len(out) >= 12 {
			break
		}
	}
	if b, err := json.MarshalIndent(out, "", "  "); err == nil {
		_ = os.WriteFile(a.recentPath, b, 0o644)
	}
	return out
}

func listSiblingMarkdownFiles(dir string) []SiblingFile {
	if dir == "" {
		return []SiblingFile{}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []SiblingFile{}
	}
	var files []SiblingFile
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext == ".md" || ext == ".markdown" || ext == ".mdown" {
			files = append(files, SiblingFile{
				Name: name,
				Path: filepath.Join(dir, name),
			})
		}
	}
	sort.Slice(files, func(i, j int) bool {
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})
	return files
}

func readMarkdownFile(path string) (*FilePayload, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("目标路径是一个文件夹而非文件")
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	// Strip UTF-8 BOM if present
	content := strings.TrimPrefix(string(raw), "\uFEFF")
	dir := filepath.Dir(abs)
	return &FilePayload{
		FilePath: abs,
		FileName: filepath.Base(abs),
		DirPath:  dir,
		Content:  content,
		Mtime:    info.ModTime().UnixMilli(),
		Siblings: listSiblingMarkdownFiles(dir),
	}, nil
}

func (a *App) setWindowTitle(title string) {
	if a.wv == nil {
		return
	}
	a.wv.Dispatch(func() {
		a.wv.SetTitle(title)
	})
}

func (a *App) getHWND() uintptr {
	if a.wv == nil {
		return 0
	}
	return uintptr(a.wv.Window())
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *App) checkToken(r *http.Request) bool {
	if r.Header.Get("X-LightMD-Token") == a.token {
		return true
	}
	if r.URL.Query().Get("token") == a.token {
		return true
	}
	return false
}

func (a *App) startHTTPServer(initialFile string) (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}

	assetsSub, err := fs.Sub(embeddedAssets, "assets")
	if err != nil {
		return "", err
	}

	mux := http.NewServeMux()

	// Serve index.html with injected per-session token
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/index.html" {
			http.FileServer(http.FS(assetsSub)).ServeHTTP(w, r)
			return
		}
		raw, err := fs.ReadFile(assetsSub, "index.html")
		if err != nil {
			http.Error(w, "missing index.html", 500)
			return
		}
		html := strings.Replace(string(raw), "__LIGHTMD_TOKEN__", a.token, 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(html))
	})

	// Serve local images/assets referenced inside a Markdown file
	mux.HandleFunc("/local-asset", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		base := r.URL.Query().Get("base")
		rel := r.URL.Query().Get("rel")
		if rel == "" {
			http.NotFound(w, r)
			return
		}
		if decoded, err := url.PathUnescape(rel); err == nil {
			rel = decoded
		}
		var target string
		if filepath.IsAbs(rel) {
			target = filepath.Clean(rel)
		} else {
			if base == "" {
				a.mu.Lock()
				if a.currentPath != "" {
					base = filepath.Dir(a.currentPath)
				}
				a.mu.Unlock()
			}
			if base == "" {
				http.NotFound(w, r)
				return
			}
			target = filepath.Clean(filepath.Join(base, filepath.FromSlash(rel)))
		}
		if info, err := os.Stat(target); err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, target)
	})

	// API: init
	mux.HandleFunc("/api/init", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		payload := InitPayload{
			Recent:  a.loadRecent(),
			Assoc:   getAssocStatus(),
			Install: getAppInstallStatus(),
			Token:   a.token,
		}
		a.mu.Lock()
		target := a.currentPath
		if target == "" && initialFile != "" {
			target = initialFile
		}
		a.mu.Unlock()

		if target != "" {
			fp, err := readMarkdownFile(target)
			if err != nil {
				payload.InitialErr = err.Error()
			} else {
				a.mu.Lock()
				a.currentPath = fp.FilePath
				a.mu.Unlock()
				fp.Recent = a.addRecent(fp.FilePath)
				payload.File = fp
				payload.Recent = fp.Recent
				a.setWindowTitle(fp.FileName + " — LightMD")
			}
		}
		writeJSON(w, http.StatusOK, payload)
	})

	// API: open file by path (supports relative path against baseDir)
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Path    string `json:"path"`
			BaseDir string `json:"baseDir"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		target := strings.TrimSpace(req.Path)
		if target == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty path"})
			return
		}
		if !filepath.IsAbs(target) {
			base := req.BaseDir
			if base == "" {
				a.mu.Lock()
				if a.currentPath != "" {
					base = filepath.Dir(a.currentPath)
				}
				a.mu.Unlock()
			}
			if base != "" {
				target = filepath.Join(base, filepath.FromSlash(target))
			}
		}
		fp, err := readMarkdownFile(target)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		a.mu.Lock()
		a.currentPath = fp.FilePath
		a.mu.Unlock()
		fp.Recent = a.addRecent(fp.FilePath)
		a.setWindowTitle(fp.FileName + " — LightMD")
		writeJSON(w, http.StatusOK, fp)
	})

	// API: native Windows Open File dialog
	mux.HandleFunc("/api/open-dialog", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Dir string `json:"dir"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		dir := req.Dir
		if dir == "" {
			a.mu.Lock()
			if a.currentPath != "" {
				dir = filepath.Dir(a.currentPath)
			}
			a.mu.Unlock()
		}

		ch := make(chan string, 1)
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			ch <- openMarkdownFileDialog(a.getHWND(), dir)
		}()
		chosen := <-ch
		if chosen == "" {
			writeJSON(w, http.StatusOK, map[string]interface{}{"cancelled": true})
			return
		}
		fp, err := readMarkdownFile(chosen)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		a.mu.Lock()
		a.currentPath = fp.FilePath
		a.mu.Unlock()
		fp.Recent = a.addRecent(fp.FilePath)
		a.setWindowTitle(fp.FileName + " — LightMD")
		writeJSON(w, http.StatusOK, fp)
	})

	// API: save existing file
	mux.HandleFunc("/api/save", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		if req.Path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "文件路径为空，请使用另存为"})
			return
		}
		abs, err := filepath.Abs(req.Path)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := os.WriteFile(abs, []byte(req.Content), 0o644); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		info, _ := os.Stat(abs)
		var mtime int64
		if info != nil {
			mtime = info.ModTime().UnixMilli()
		}
		a.mu.Lock()
		a.currentPath = abs
		a.mu.Unlock()
		dir := filepath.Dir(abs)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"filePath": abs,
			"fileName": filepath.Base(abs),
			"dirPath":  dir,
			"mtime":    mtime,
			"siblings": listSiblingMarkdownFiles(dir),
			"recent":   a.addRecent(abs),
		})
	})

	// API: save as dialog
	mux.HandleFunc("/api/save-as", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Content       string `json:"content"`
			Dir           string `json:"dir"`
			SuggestedName string `json:"suggestedName"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		dir := req.Dir
		if dir == "" {
			a.mu.Lock()
			if a.currentPath != "" {
				dir = filepath.Dir(a.currentPath)
			}
			a.mu.Unlock()
		}
		suggested := req.SuggestedName
		if suggested == "" {
			suggested = "未命名.md"
		}

		ch := make(chan string, 1)
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			ch <- saveMarkdownFileDialog(a.getHWND(), dir, suggested)
		}()
		chosen := <-ch
		if chosen == "" {
			writeJSON(w, http.StatusOK, map[string]interface{}{"cancelled": true})
			return
		}
		if filepath.Ext(chosen) == "" {
			chosen += ".md"
		}
		if err := os.WriteFile(chosen, []byte(req.Content), 0o644); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		info, _ := os.Stat(chosen)
		var mtime int64
		if info != nil {
			mtime = info.ModTime().UnixMilli()
		}
		abs, _ := filepath.Abs(chosen)
		a.mu.Lock()
		a.currentPath = abs
		a.mu.Unlock()
		a.setWindowTitle(filepath.Base(abs) + " — LightMD")
		newDir := filepath.Dir(abs)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"filePath": abs,
			"fileName": filepath.Base(abs),
			"dirPath":  newDir,
			"mtime":    mtime,
			"siblings": listSiblingMarkdownFiles(newDir),
			"recent":   a.addRecent(abs),
		})
	})

	// API: stat file for external changes
	mux.HandleFunc("/api/stat", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Path == "" {
			writeJSON(w, http.StatusOK, map[string]interface{}{"exists": false, "mtime": 0})
			return
		}
		info, err := os.Stat(req.Path)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"exists": false, "mtime": 0})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"exists": true, "mtime": info.ModTime().UnixMilli()})
	})

	// API: new untitled file
	mux.HandleFunc("/api/new", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		a.mu.Lock()
		a.currentPath = ""
		a.mu.Unlock()
		a.setWindowTitle("未命名.md — LightMD")
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	// API: set window title
	mux.HandleFunc("/api/title", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Title string `json:"title"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Title != "" {
			a.setWindowTitle(req.Title)
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	// API: open external URL in default browser
	mux.HandleFunc("/api/open-external", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			URL string `json:"url"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		u := strings.TrimSpace(req.URL)
		if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "mailto:") {
			openURLInBrowser(u)
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	// API: reveal in explorer
	mux.HandleFunc("/api/reveal", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Path != "" {
			revealInExplorer(req.Path)
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	// API: file association management
	mux.HandleFunc("/api/assoc/status", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		writeJSON(w, http.StatusOK, getAssocStatus())
	})
	mux.HandleFunc("/api/assoc/register", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		st, err := registerFileAssociation()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, st)
	})
	mux.HandleFunc("/api/assoc/unregister", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		if err := unregisterFileAssociation(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, getAssocStatus())
	})
	mux.HandleFunc("/api/open-default-apps", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		openURLInBrowser("ms-settings:defaultapps")
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	// API: install / uninstall as Windows desktop app
	mux.HandleFunc("/api/app/status", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		writeJSON(w, http.StatusOK, getAppInstallStatus())
	})
	mux.HandleFunc("/api/app/install", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		st, err := installApp()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"install": st,
			"assoc":   getAssocStatus(),
		})
	})
	mux.HandleFunc("/api/app/uninstall", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		if err := uninstallApp(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"install": getAppInstallStatus(),
			"assoc":   getAssocStatus(),
		})
	})

	// API: export as Word (.doc) or HTML
	mux.HandleFunc("/api/export", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		var req struct {
			Format        string `json:"format"` // "doc" or "html"
			Content       string `json:"content"`
			Dir           string `json:"dir"`
			SuggestedName string `json:"suggestedName"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		dir := req.Dir
		if dir == "" {
			a.mu.Lock()
			if a.currentPath != "" {
				dir = filepath.Dir(a.currentPath)
			}
			a.mu.Unlock()
		}
		ext := "html"
		title := "导出为网页 (HTML)"
		filterDesc := "网页文件 (*.html)"
		filterPat := "*.html"
		if req.Format == "doc" {
			ext = "doc"
			title = "导出为 Word 文档 (.doc)"
			filterDesc = "Word 文档 (*.doc)"
			filterPat = "*.doc"
		}
		base := strings.TrimSuffix(req.SuggestedName, filepath.Ext(req.SuggestedName))
		if base == "" {
			base = "文档"
		}
		suggested := base + "." + ext

		ch := make(chan string, 1)
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			ch <- saveExportFileDialog(a.getHWND(), dir, suggested, title, ext, filterDesc, filterPat)
		}()
		chosen := <-ch
		if chosen == "" {
			writeJSON(w, http.StatusOK, map[string]interface{}{"cancelled": true})
			return
		}
		if err := os.WriteFile(chosen, []byte(req.Content), 0o644); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"filePath": chosen,
			"fileName": filepath.Base(chosen),
		})
	})

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		_ = srv.Serve(ln)
	}()

	return "http://" + ln.Addr().String(), nil
}

func main() {
	enablePerMonitorDPI()
	setAppUserModelID("LightMD.Desktop.App")

	doInstall := flag.Bool("install", false, "安装 LightMD 为 Windows 桌面应用（创建桌面与开始菜单图标）")
	doUninstall := flag.Bool("uninstall", false, "卸载 LightMD 应用及文件关联")
	silentMode := flag.Bool("silent", false, "静默执行安装或卸载（不弹窗）")
	doRegister := flag.Bool("register", false, "注册为 .md 文件的默认打开程序")
	doUnregister := flag.Bool("unregister", false, "取消 .md 文件关联")
	debugMode := flag.Bool("debug", false, "开启 WebView2 调试模式")
	flag.Parse()

	if *doInstall {
		st, err := installApp()
		if err != nil {
			if !*silentMode {
				showMessageBox("LightMD 安装失败", "无法完成应用安装：\n"+err.Error(), 0x10)
			}
			os.Exit(1)
		}
		if !*silentMode {
			msg := "已将 LightMD 安装为 Windows 桌面应用！\n\n" +
				"• 安装位置：" + st.InstallExePath + "\n" +
				"• 已创建「桌面快捷方式」与「开始菜单」图标\n" +
				"• 已添加「新建 → Markdown 文档」右键菜单\n" +
				"• 已在 Windows「设置 → 应用」中注册（可随时卸载）"
			assoc := getAssocStatus()
			if !assoc.IsDefault && assoc.UserChoiceProgID != "" {
				msg += fmt.Sprintf("\n\n提示：当前 .md 默认打开程序为 %s。\n请右键任意 .md 文件 →「打开方式」→「选择其他应用」→ 选择 LightMD → 点击「始终」，即可双击 .md 直接打开。", assoc.UserChoiceProgID)
			}
			showMessageBox("LightMD 安装成功", msg, 0x40)
		}
		return
	}

	if *doUninstall {
		if err := uninstallApp(); err != nil {
			if !*silentMode {
				showMessageBox("LightMD 卸载失败", err.Error(), 0x10)
			}
			os.Exit(1)
		}
		if !*silentMode {
			showMessageBox("LightMD 已卸载", "已移除 LightMD 桌面应用、快捷方式及相关文件关联。", 0x40)
		}
		return
	}

	if *doRegister {
		st, err := registerFileAssociation()
		if err != nil {
			showMessageBox("LightMD 注册失败", "无法写入文件关联：\n"+err.Error(), 0x10)
			os.Exit(1)
		}
		msg := "已成功将 LightMD 注册为 .md / .markdown 打开程序！\n\n程序路径：\n" + st.ExePath
		if !st.IsDefault && st.UserChoiceProgID != "" {
			msg += fmt.Sprintf("\n\n提示：检测到 Windows 当前已将 .md 锁定给其他程序 (%s)。\n如双击仍由旧程序打开，请右键任意 .md 文件 →「打开方式」→「选择其他应用」→ 选择 LightMD → 点击「始终」。", st.UserChoiceProgID)
		} else {
			msg += "\n\n现在可以直接双击任意 .md 文件用 LightMD 打开！"
		}
		showMessageBox("LightMD 文件关联成功", msg, 0x40)
		return
	}

	if *doUnregister {
		if err := unregisterFileAssociation(); err != nil {
			showMessageBox("LightMD 取消关联失败", err.Error(), 0x10)
			os.Exit(1)
		}
		showMessageBox("LightMD 已取消关联", "已移除当前用户的 LightMD .md 文件关联注册项。", 0x40)
		return
	}

	var initialFile string
	if flag.NArg() > 0 {
		candidate := strings.TrimSpace(flag.Arg(0))
		if abs, err := filepath.Abs(candidate); err == nil {
			initialFile = abs
		} else {
			initialFile = candidate
		}
	}

	app := newApp()
	baseURL, err := app.startHTTPServer(initialFile)
	if err != nil {
		showMessageBox("LightMD 启动失败", "无法启动本地服务："+err.Error(), 0x10)
		os.Exit(1)
	}

	winTitle := "LightMD — 轻量化 Markdown 阅读器"
	if initialFile != "" {
		winTitle = filepath.Base(initialFile) + " — LightMD"
	}

	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     *debugMode,
		AutoFocus: true,
		DataPath:  filepath.Join(app.dataDir, "WebView2"),
		WindowOptions: webview2.WindowOptions{
			Title:  winTitle,
			Width:  1160,
			Height: 800,
			IconId: 1,
			Center: true,
		},
	})
	if wv == nil {
		showMessageBox("LightMD 启动失败", "未能初始化 Microsoft Edge WebView2 组件。\n请确认系统已安装 WebView2 Runtime。", 0x10)
		os.Exit(1)
	}
	defer wv.Destroy()

	app.wv = wv
	setWindowIconFromPNG(uintptr(wv.Window()), appIconPNG)

	wv.Navigate(baseURL + "/")
	wv.Run()
}
