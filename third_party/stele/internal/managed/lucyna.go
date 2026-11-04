// Package managed connects the pinned engine to Lucyna's single library writer.
package managed

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

func Request(route string, input any, output any) error {
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", os.Getenv("LUCYNA_ENGINE_CALLBACK")+route, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("LUCYNA_ENGINE_TOKEN"))
	req.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return fmt.Errorf("Lucyna managed operation: %d %s", response.StatusCode, body)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(output)
	}
	return nil
}
func Enabled() bool { return os.Getenv("LUCYNA_ENGINE_CALLBACK") != "" }
func Unified() bool { return Enabled() && os.Getenv("LUCYNA_UNIFIED_KNOWLEDGE") == "1" }
func Create(path string, content []byte) error {
	return Request("/internal/write", map[string]any{"path": path, "content": string(content), "expected": "new"}, nil)
}
