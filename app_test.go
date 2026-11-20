package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHTTPServerAndFileOperations(t *testing.T) {
	tmpDir := t.TempDir()
	f1 := filepath.Join(tmpDir, "01_Hello.md")
	f2 := filepath.Join(tmpDir, "02_Next.md")
	// Include UTF-8 BOM in f1 to verify stripping
	if err := os.WriteFile(f1, []byte("\uFEFF# 标题一\n\n跳转到 [下一篇](./02_Next.md)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f2, []byte("# 第二篇\n\n正文内容\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := newApp()
	baseURL, err := app.startHTTPServer(f1)
	if err != nil {
		t.Fatalf("startHTTPServer failed: %v", err)
	}

	// 1. Unauthorized API call must be rejected with 403
	resp, err := http.Get(baseURL + "/api/init")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 without token, got %d", resp.StatusCode)
	}

	// 2. Authorized /api/init must load initial file, strip BOM, and list siblings
	req, _ := http.NewRequest("GET", baseURL+"/api/init", nil)
	req.Header.Set("X-LightMD-Token", app.token)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var initData InitPayload
	if err := json.NewDecoder(resp.Body).Decode(&initData); err != nil {
		t.Fatal(err)
	}
	if initData.File == nil {
		t.Fatal("expected initial file payload")
	}
	if strings.HasPrefix(initData.File.Content, "\uFEFF") {
		t.Fatal("expected UTF-8 BOM to be stripped")
	}
	if len(initData.File.Siblings) != 2 {
		t.Fatalf("expected 2 sibling markdown files, got %d", len(initData.File.Siblings))
	}

	// 3. Relative path open (./02_Next.md)
	body, _ := json.Marshal(map[string]string{"path": "./02_Next.md", "baseDir": tmpDir})
	req2, _ := http.NewRequest("POST", baseURL+"/api/open", bytes.NewReader(body))
	req2.Header.Set("X-LightMD-Token", app.token)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var fp2 FilePayload
	if err := json.NewDecoder(resp2.Body).Decode(&fp2); err != nil {
		t.Fatal(err)
	}
	if fp2.FileName != "02_Next.md" || !strings.Contains(fp2.Content, "第二篇") {
		t.Fatalf("unexpected open result: %+v", fp2)
	}

	// 4. Save edited content
	saveBody, _ := json.Marshal(map[string]string{"path": f2, "content": "# 第二篇（已更新）\n"})
	req3, _ := http.NewRequest("POST", baseURL+"/api/save", bytes.NewReader(saveBody))
	req3.Header.Set("X-LightMD-Token", app.token)
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("save failed with status %d", resp3.StatusCode)
	}
	updated, err := os.ReadFile(f2)
	if err != nil {
		t.Fatal(err)
	}
	if string(updated) != "# 第二篇（已更新）\n" {
		t.Fatalf("file content mismatch: %q", string(updated))
	}

	// 5. Index page injects session token
	idxResp, err := http.Get(baseURL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer idxResp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(idxResp.Body)
	if !strings.Contains(buf.String(), app.token) {
		t.Fatal("expected index.html to contain session token")
	}
}
