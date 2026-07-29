package ai

import (
	"fmt"
	"strings"
	"testing"

	acp "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
)

func TestFormatACPUserError_PrefersDataOverGenericMessage(t *testing.T) {
	err := &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/responses: Invalid or expired credentials",
	}
	got := formatACPUserError(err)
	assert.Equal(t, "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/responses: Invalid or expired credentials", got)
	assert.NotContains(t, got, "Internal error")
	assert.NotContains(t, got, `"code"`)
}

func TestFormatACPUserError_DataMapErrorKey(t *testing.T) {
	err := &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    map[string]any{"error": "write |1: broken pipe"},
	}
	assert.Equal(t, "write |1: broken pipe", formatACPUserError(err))
}

func TestFormatACPUserError_SpecificMessageKept(t *testing.T) {
	err := &acp.RequestError{
		Code:    -32601,
		Message: "Method not found",
	}
	assert.Equal(t, "Method not found", formatACPUserError(err))
}

func TestFormatACPUserError_MessagePlusDataWhenMessageUseful(t *testing.T) {
	err := &acp.RequestError{
		Code:    -32000,
		Message: "Authentication required",
		Data:    "token expired",
	}
	assert.Equal(t, "Authentication required: token expired", formatACPUserError(err))
}

func TestFormatACPPromptUserError_NoDoublePrefix(t *testing.T) {
	inner := &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    "rate limited",
	}
	// conn.Prompt wraps once
	wrapped := fmt.Errorf("acp: prompt: %w", inner)
	got := formatACPPromptUserError(wrapped)
	assert.Equal(t, "acp: prompt: rate limited", got)
	assert.Equal(t, 1, strings.Count(got, "acp: prompt:"))
}

func TestFormatACPPromptUserError_DoubleWrappedString(t *testing.T) {
	// Historical path: wrap then sprintf again produced double prefix + JSON.
	raw := `acp: prompt: acp: prompt: {"code":-32603,"message":"Internal error","data":"Unauthorized (401) invalid credentials"}`
	got := formatACPPromptUserError(fmt.Errorf("%s", raw))
	assert.Equal(t, "acp: prompt: Unauthorized (401) invalid credentials", got)
}

func TestFormatACPUserError_Nil(t *testing.T) {
	assert.Equal(t, "", formatACPUserError(nil))
}

func TestParseRequestErrorJSON_Embedded(t *testing.T) {
	s := `acp: prompt: {"code":-32603,"message":"Internal error","data":"boom"}`
	assert.Equal(t, "boom", parseRequestErrorJSON(s))
}

func TestFormatACPPromptUserError_GrokStyleFullMessage(t *testing.T) {
	data := "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/responses: Invalid or expired credentials (auth_kind=none)\n\n  Model:     grok-4.5\n  Auth:      ApiKey"
	err := fmt.Errorf("acp: prompt: %w", &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    data,
	})
	got := formatACPPromptUserError(err)
	assert.True(t, strings.HasPrefix(got, "acp: prompt: Unauthorized (401)"))
	assert.Contains(t, got, "Invalid or expired credentials")
	assert.Contains(t, got, "Model:     grok-4.5")
	assert.NotContains(t, got, `"code":-32603`)
}

func TestFormatACPPromptUserError_AnnotationsSerialization(t *testing.T) {
	err := fmt.Errorf("acp: prompt: %w", &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    "serialization error: missing field `annotations`",
	})
	got := formatACPPromptUserError(err)
	assert.Contains(t, got, "serialization error")
	assert.Contains(t, got, "annotations")
	assert.Contains(t, got, "auto-recovery")
	assert.Equal(t, 1, strings.Count(got, "acp: prompt:"))
}

func TestIsACPAnnotationsSerializationError(t *testing.T) {
	assert.False(t, isACPAnnotationsSerializationError(nil))
	assert.False(t, isACPAnnotationsSerializationError(fmt.Errorf("rate limited")))
	err := &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    "serialization error: missing field `annotations`",
	}
	assert.True(t, isACPAnnotationsSerializationError(err))
	assert.True(t, isACPAnnotationsSerializationError(fmt.Errorf("acp: prompt: %w", err)))
}
