package ai

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
)

// acpStdinFilter wraps the agent stdin writer and rewrites outbound JSON-RPC
// lines so content blocks always include an "annotations" object.
//
// Why: github.com/coder/acp-go-sdk ContentBlock.MarshalJSON only emits type/text
// (and strips annotations). Some agents (Grok ACP) later fail with
// "serialization error: missing field `annotations`" when packaging turns that
// include those blocks. Injecting {"annotations":{}} on the wire is a low-risk
// compatibility shim that does not require forking the SDK.
type acpStdinFilter struct {
	w   io.WriteCloser
	mu  sync.Mutex
	buf []byte
}

func newACPStdinFilter(w io.WriteCloser) *acpStdinFilter {
	return &acpStdinFilter{w: w}
}

func (f *acpStdinFilter) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.buf = append(f.buf, p...)
	written := len(p)

	for {
		idx := bytes.IndexByte(f.buf, '\n')
		if idx < 0 {
			break
		}
		line := f.buf[:idx+1] // include newline
		f.buf = f.buf[idx+1:]
		fixed := ensureContentBlockAnnotations(line)
		if _, err := f.w.Write(fixed); err != nil {
			return written, err
		}
	}
	return written, nil
}

func (f *acpStdinFilter) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.buf) > 0 {
		fixed := ensureContentBlockAnnotations(f.buf)
		f.buf = nil
		_, _ = f.w.Write(fixed)
	}
	return f.w.Close()
}

// ensureContentBlockAnnotations rewrites a single JSON-RPC line (with or without
// trailing newline) so every object that looks like a text/image/audio/
// resource_link content block has an annotations field.
func ensureContentBlockAnnotations(line []byte) []byte {
	trim := bytes.TrimSpace(line)
	if len(trim) == 0 || trim[0] != '{' {
		return line
	}
	var msg map[string]any
	if err := json.Unmarshal(trim, &msg); err != nil {
		return line
	}
	changed := false
	if params, ok := msg["params"].(map[string]any); ok {
		if injectAnnotationsInValue(params) {
			changed = true
		}
	}
	// Also handle rare top-level prompt arrays.
	if injectAnnotationsInValue(msg) {
		changed = true
	}
	if !changed {
		return line
	}
	out, err := json.Marshal(msg)
	if err != nil {
		return line
	}
	if len(line) > 0 && line[len(line)-1] == '\n' {
		out = append(out, '\n')
	}
	return out
}

func injectAnnotationsInValue(v any) bool {
	changed := false
	switch t := v.(type) {
	case map[string]any:
		if looksLikeContentBlock(t) {
			if _, ok := t["annotations"]; !ok {
				t["annotations"] = map[string]any{}
				changed = true
			}
		}
		for _, child := range t {
			if injectAnnotationsInValue(child) {
				changed = true
			}
		}
	case []any:
		for _, child := range t {
			if injectAnnotationsInValue(child) {
				changed = true
			}
		}
	}
	return changed
}

func looksLikeContentBlock(m map[string]any) bool {
	typ, _ := m["type"].(string)
	switch typ {
	case "text":
		_, ok := m["text"]
		return ok
	case "image", "audio":
		_, hasData := m["data"]
		_, hasMIME := m["mimeType"]
		return hasData && hasMIME
	case "resource_link":
		_, hasName := m["name"]
		_, hasURI := m["uri"]
		return hasName && hasURI
	case "resource":
		_, ok := m["resource"]
		return ok
	default:
		return false
	}
}
