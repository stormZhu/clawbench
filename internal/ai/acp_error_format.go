package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	acp "github.com/coder/acp-go-sdk"
)

// formatACPUserError builds a human-readable message from an ACP (or wrapped)
// error for UI and logs.
//
// Grok and other agents often return JSON-RPC:
//
//	{"code":-32603,"message":"Internal error","data":"<real reason>"}
//
// The useful text lives in Data; Message is a generic protocol label.
// RequestError.Error() dumps the whole JSON blob, which is noisy in the chat UI.
func formatACPUserError(err error) string {
	if err == nil {
		return ""
	}
	if detail := acpRequestErrorDetail(err); detail != "" {
		return detail
	}
	return stripACPPromptPrefix(err.Error())
}

// formatACPPromptUserError is the user-facing string for session/prompt failures.
// It unwraps RequestError.Data and avoids double "acp: prompt:" prefixes
// (conn.Prompt wraps once; ExecuteStream must not wrap again with %v).
func formatACPPromptUserError(err error) string {
	detail := formatACPUserError(err)
	if detail == "" {
		return "acp: prompt failed"
	}
	if strings.HasPrefix(detail, "acp: prompt:") {
		detail = strings.TrimSpace(strings.TrimPrefix(detail, "acp: prompt:"))
	}
	// Grok ACP occasionally fails packaging a completed turn; keep the raw
	// detail but make the cause recognizable in UI.
	if strings.Contains(strings.ToLower(detail), "serialization error") &&
		strings.Contains(strings.ToLower(detail), "annotations") {
		return "acp: prompt: " + detail + " (agent session packaging bug; auto-recovery may rotate session)"
	}
	return "acp: prompt: " + detail
}

// stripACPPromptPrefix removes one or more leading "acp: prompt:" wrappers.
func stripACPPromptPrefix(s string) string {
	for {
		t := strings.TrimSpace(s)
		if after, ok := strings.CutPrefix(t, "acp: prompt:"); ok {
			s = after
			continue
		}
		return t
	}
}

func acpRequestErrorDetail(err error) string {
	var re *acp.RequestError
	if errors.As(err, &re) && re != nil {
		if dataStr := formatACPErrorData(re.Data); dataStr != "" {
			msg := strings.TrimSpace(re.Message)
			if msg != "" && !isGenericJSONRPCMessage(msg) && !strings.Contains(dataStr, msg) {
				return msg + ": " + dataStr
			}
			return dataStr
		}
		if msg := strings.TrimSpace(re.Message); msg != "" {
			return msg
		}
		return ""
	}
	// Already stringified (e.g. after fmt.Errorf wrapping lost type in some paths).
	return parseRequestErrorJSON(err.Error())
}

func isGenericJSONRPCMessage(msg string) bool {
	switch strings.ToLower(strings.TrimSpace(msg)) {
	case "internal error", "server error", "unknown error":
		return true
	default:
		return false
	}
}

func formatACPErrorData(data any) string {
	if data == nil {
		return ""
	}
	switch d := data.(type) {
	case string:
		return strings.TrimSpace(d)
	case map[string]any:
		for _, k := range []string{"error", "details", "message", "detail", "reason"} {
			if v, ok := d[k].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
		b, err := json.Marshal(d)
		if err == nil {
			return string(b)
		}
	case json.RawMessage:
		return formatACPErrorDataBytes([]byte(d))
	case []byte:
		return formatACPErrorDataBytes(d)
	default:
		b, err := json.Marshal(d)
		if err == nil && string(b) != "null" {
			var s string
			if json.Unmarshal(b, &s) == nil {
				return strings.TrimSpace(s)
			}
			return string(b)
		}
	}
	return strings.TrimSpace(fmt.Sprint(data))
}

func formatACPErrorDataBytes(b []byte) string {
	b = bytesTrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		return ""
	}
	var asStr string
	if json.Unmarshal(b, &asStr) == nil {
		return strings.TrimSpace(asStr)
	}
	var asMap map[string]any
	if json.Unmarshal(b, &asMap) == nil {
		return formatACPErrorData(asMap)
	}
	return strings.TrimSpace(string(b))
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}

// parseRequestErrorJSON extracts a readable detail from a string that embeds a
// JSON-RPC error object (as produced by acp.RequestError.Error()).
func parseRequestErrorJSON(s string) string {
	s = stripACPPromptPrefix(s)
	start := strings.Index(s, `{"code":`)
	if start < 0 {
		return ""
	}
	raw := s[start:]
	var re struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &re); err != nil {
		// Truncate to outermost object if trailing junk present.
		if end := jsonObjectEnd(raw); end > 0 {
			if err2 := json.Unmarshal([]byte(raw[:end]), &re); err2 != nil {
				return ""
			}
		} else {
			return ""
		}
	}
	if dataStr := formatACPErrorDataBytes(re.Data); dataStr != "" {
		msg := strings.TrimSpace(re.Message)
		if msg != "" && !isGenericJSONRPCMessage(msg) && !strings.Contains(dataStr, msg) {
			return msg + ": " + dataStr
		}
		return dataStr
	}
	if msg := strings.TrimSpace(re.Message); msg != "" && !isGenericJSONRPCMessage(msg) {
		return msg
	}
	return ""
}

// jsonObjectEnd returns the index just past the outermost JSON object, or -1.
func jsonObjectEnd(s string) int {
	if s == "" || s[0] != '{' {
		return -1
	}
	depth := 0
	inString := false
	escape := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inString {
			if escape {
				escape = false
				continue
			}
			if c == '\\' {
				escape = true
				continue
			}
			if c == '"' {
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i + 1
			}
		}
	}
	return -1
}
