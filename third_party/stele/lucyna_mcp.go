package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type lucynaConnection struct {
	URL        string `json:"url"`
	Token      string `json:"token"`
	Root       string `json:"root"`
	InstanceID string `json:"instanceId"`
}

func readLucynaConnection(root string) (lucynaConnection, error) {
	var c lucynaConnection
	data, err := os.ReadFile(filepath.Join(root, "runtime", "connection.json"))
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || len(c.Token) != 64 || filepath.Clean(c.Root) != filepath.Clean(root) {
		return c, fmt.Errorf("invalid knowledge connection")
	}
	req, _ := http.NewRequest("GET", c.URL+"/api/health", nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	response, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return c, err
	}
	defer response.Body.Close()
	var health struct {
		Ready      bool   `json:"ready"`
		InstanceID string `json:"instanceId"`
	}
	if err = json.NewDecoder(response.Body).Decode(&health); err != nil || !health.Ready || health.InstanceID != c.InstanceID {
		return c, fmt.Errorf("knowledge engine not ready")
	}
	return c, nil
}
func ensureLucynaConnection(root string) (lucynaConnection, error) {
	if c, err := readLucynaConnection(root); err == nil {
		return c, nil
	}
	var launch struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	data, err := os.ReadFile(filepath.Join(root, "runtime", "launch.json"))
	if err != nil {
		return lucynaConnection{}, fmt.Errorf("open this knowledge library once in Lucyna to prepare its service")
	}
	if err = json.Unmarshal(data, &launch); err != nil || !filepath.IsAbs(launch.Command) {
		return lucynaConnection{}, fmt.Errorf("invalid service launcher")
	}
	command := exec.Command(launch.Command, launch.Args...)
	command.Env = append(os.Environ(), "LUCYNA_KNOWLEDGE_HOME="+root)
	hideLucynaConsole(command)
	if err = command.Start(); err != nil {
		return lucynaConnection{}, err
	}
	go command.Wait()
	for deadline := time.Now().Add(time.Minute); time.Now().Before(deadline); {
		if c, err := readLucynaConnection(root); err == nil {
			return c, nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return lucynaConnection{}, fmt.Errorf("knowledge service startup timed out")
}
func runLucynaMCP() int {
	flags := flag.NewFlagSet("lucyna-mcp", flag.ContinueOnError)
	root := flags.String("knowledge-data", "", "Lucyna knowledge profile directory")
	write := flags.Bool("write", false, "permit knowledge mutations")
	once := flags.Bool("once", false, "process one JSON-RPC frame")
	if flags.Parse(os.Args[2:]) != nil || !filepath.IsAbs(*root) {
		fmt.Fprintln(os.Stderr, "--knowledge-data must be absolute")
		return 1
	}
	connection, err := ensureLucynaConnection(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				_, _ = readLucynaConnection(*root)
			}
		}
	}()
	readonly := map[string]bool{}
	for _, name := range strings.Fields("work_material_list work_material_read wiki_search wiki_read wiki_component wiki_neighbors wiki_context wiki_sessions wiki_lint wiki_overview wiki_claim_search wiki_claim_get wiki_claims wiki_review_list todo_list library_list library_documents library_read library_history") {
		readonly[name] = true
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), 2<<20)
	client := &http.Client{Timeout: 10 * time.Minute}
	for scanner.Scan() {
		var message map[string]json.RawMessage
		if err = json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		var method string
		_ = json.Unmarshal(message["method"], &method)
		if strings.HasPrefix(method, "notifications/") {
			continue
		}
		var params struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(message["params"], &params)
		var output any
		if !*write && method == "tools/call" && !readonly[params.Name] {
			output = map[string]any{"jsonrpc": "2.0", "id": message["id"], "result": map[string]any{"isError": true, "content": []map[string]string{{"type": "text", "text": "MCP connection is read-only; --write is required"}}}}
		} else {
			req, _ := http.NewRequest("POST", connection.URL+"/mcp", bytes.NewReader(scanner.Bytes()))
			req.Header.Set("Authorization", "Bearer "+connection.Token)
			req.Header.Set("Content-Type", "application/json")
			response, callErr := client.Do(req)
			if callErr == nil {
				var value map[string]any
				callErr = json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(&value)
				response.Body.Close()
				if callErr == nil && response.StatusCode == http.StatusOK {
					if !*write && method == "tools/list" {
						if result, ok := value["result"].(map[string]any); ok {
							var allowed []any
							if list, ok := result["tools"].([]any); ok {
								for _, raw := range list {
									if tool, ok := raw.(map[string]any); ok && readonly[fmt.Sprint(tool["name"])] {
										allowed = append(allowed, tool)
									}
								}
							}
							result["tools"] = allowed
						}
					}
					output = value
				} else if callErr == nil {
					callErr = fmt.Errorf("knowledge service HTTP %d", response.StatusCode)
				}
			}
			if callErr != nil {
				output = map[string]any{"jsonrpc": "2.0", "id": message["id"], "error": map[string]any{"code": -32603, "message": callErr.Error()}}
			}
		}
		if _, ok := message["id"]; ok {
			_ = json.NewEncoder(os.Stdout).Encode(output)
		}
		if *once {
			break
		}
	}
	if scanner.Err() != nil {
		fmt.Fprintln(os.Stderr, scanner.Err())
		return 1
	}
	return 0
}
