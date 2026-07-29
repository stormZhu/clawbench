package ai

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"clawbench/internal/model"
)

// setupTestBackends registers backend factories for testing.
// We can't import backend sub-packages due to import cycles,
// so we register lightweight stubs that satisfy NewBackend's lookup.

func hasAutoResumeWrapper(backend AIBackend) bool {
	for backend != nil {
		switch b := backend.(type) {
		case *AutoResumeBackend:
			return true
		case backendUnwrapper:
			backend = b.Unwrap()
		default:
			return false
		}
	}
	return false
}

func hasRequestRetryWrapper(backend AIBackend) bool {
	_, ok := backend.(*RequestRetryBackend)
	return ok
}

func concreteBackend(backend AIBackend) AIBackend {
	return UnwrapBackend(backend)
}

func setupTestBackends() {
	backendFactoriesMu.Lock()
	defer backendFactoriesMu.Unlock()
	backendFactories = make(map[string]*BackendFactoryEntry)

	stubs := map[string]bool{
		"claude":    true,
		"codebuddy": true,
		"opencode":  false,
		"qoder":     true,
		"vecli":     false,
		"pi":        true,
		"deepseek":  true,
		"cline":     true,
		"kimi":      true,
		"copilot":   true,
		"codex":     false,
		"mimo":      true,
		"grok":      true,
	}
	for id, needsAR := range stubs {
		backendType := id // capture for closure
		switch backendType {
		case "vecli":
			backendFactories[backendType] = &BackendFactoryEntry{
				NewBackendFn:    func() AIBackend { return NewVeCLIBackend() },
				NeedsAutoResume: needsAR,
			}
		case "codex":
			backendFactories[backendType] = &BackendFactoryEntry{
				NewBackendFn:    func() AIBackend { return &CodexBackend{} },
				NeedsAutoResume: needsAR,
			}
		default:
			backendFactories[backendType] = &BackendFactoryEntry{
				NewBackendFn: func() AIBackend {
					return &CLIBackend{
						BackendName: backendType,
						Cmd:         backendType,
						BuildArgsFn: func(req ChatRequest) []string { return nil },
						NewParserFn: func() LineParser { return &StreamParser{} },
					}
				},
				NeedsAutoResume: needsAR,
			}
		}
	}
}

func TestNewBackend_Claude(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("claude")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "claude", backend.Name())
	// Claude is wrapped in AutoResumeBackend (ExitPlanMode auto-resume)
	assert.True(t, hasRequestRetryWrapper(backend), "claude should be wrapped in RequestRetryBackend")
	assert.True(t, hasAutoResumeWrapper(backend), "claude should be wrapped in AutoResumeBackend")
}

func TestNewBackend_Codebuddy(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("codebuddy")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "codebuddy", backend.Name())
	// Codebuddy is wrapped in AutoResumeBackend (ExitPlanMode auto-resume)
	assert.True(t, hasRequestRetryWrapper(backend), "codebuddy should be wrapped in RequestRetryBackend")
	assert.True(t, hasAutoResumeWrapper(backend), "codebuddy should be wrapped in AutoResumeBackend")
}

func TestNewBackend_OpenCode(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("opencode")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "opencode", backend.Name())
	// OpenCode is NOT wrapped in AutoResumeBackend (no ExitPlanMode issue)
	assert.True(t, hasRequestRetryWrapper(backend), "opencode should be wrapped in RequestRetryBackend")
	assert.False(t, hasAutoResumeWrapper(backend), "opencode should NOT be wrapped in AutoResumeBackend")
}

func TestNewBackend_Qoder(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("qoder")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "qoder", backend.Name())
	// Verify AutoResumeBackend wrapping (Qoder has EnterPlanMode/ExitPlanMode)
	assert.True(t, hasAutoResumeWrapper(backend), "qoder should be wrapped in AutoResumeBackend")
}

func TestNewBackend_Vecli(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("vecli")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "vecli", backend.Name())
	// VeCLI is NOT wrapped in AutoResumeBackend (no ExitPlanMode detection)
	assert.True(t, hasRequestRetryWrapper(backend), "vecli should be wrapped in RequestRetryBackend")
	assert.False(t, hasAutoResumeWrapper(backend), "vecli should NOT be wrapped in AutoResumeBackend")
	_, ok := concreteBackend(backend).(*VeCLIBackend)
	assert.True(t, ok, "vecli concrete backend should be VeCLIBackend")
}

func TestNewBackend_Pi(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("pi")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "pi", backend.Name())
	// Pi is wrapped in AutoResumeBackend (has ExitPlanMode)
	assert.True(t, hasAutoResumeWrapper(backend), "pi should be wrapped in AutoResumeBackend")
}

func TestNewBackend_DeepSeek(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("deepseek")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "deepseek", backend.Name())
	// DeepSeek is wrapped in AutoResumeBackend (supports ExitPlanMode)
	assert.True(t, hasAutoResumeWrapper(backend), "deepseek should be wrapped in AutoResumeBackend")
}

func TestNewBackend_Cline(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("cline")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "cline", backend.Name())
	// Cline is wrapped in AutoResumeBackend (supports ExitPlanMode)
	assert.True(t, hasAutoResumeWrapper(backend), "cline should be wrapped in AutoResumeBackend")
}

func TestNewBackend_Kimi(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("kimi")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "kimi", backend.Name())
	// Kimi is wrapped in AutoResumeBackend (supports plan mode)
	assert.True(t, hasAutoResumeWrapper(backend), "kimi should be wrapped in AutoResumeBackend")
}

func TestNewBackend_Copilot(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("copilot")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "copilot", backend.Name())
	// Copilot is wrapped in AutoResumeBackend (supports plan mode)
	assert.True(t, hasAutoResumeWrapper(backend), "copilot should be wrapped in AutoResumeBackend")
}

func TestNewBackend_Codex(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("codex")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "codex", backend.Name())
	// Codex is NOT wrapped in AutoResumeBackend (custom ExecuteStream, no ExitPlanMode)
	assert.True(t, hasRequestRetryWrapper(backend), "codex should be wrapped in RequestRetryBackend")
	assert.False(t, hasAutoResumeWrapper(backend), "codex should NOT be wrapped in AutoResumeBackend")
	_, ok := concreteBackend(backend).(*CodexBackend)
	assert.True(t, ok, "codex concrete backend should be CodexBackend")
}

func TestNewBackend_Unsupported(t *testing.T) {
	setupTestBackends()
	_, err := NewBackend("unsupported")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported backend type")
}

func TestNewBackend_Grok(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackend("grok")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "grok", backend.Name())
	assert.True(t, hasAutoResumeWrapper(backend), "grok should be wrapped in AutoResumeBackend")
}

func TestNewBackend_Empty(t *testing.T) {
	setupTestBackends()
	_, err := NewBackend("")
	assert.Error(t, err)
}

func TestNewBackend_CaseSensitive(t *testing.T) {
	setupTestBackends()
	// Backend type is case-sensitive
	_, err := NewBackend("Claude")
	assert.Error(t, err, "backend type should be case-sensitive")

	_, err = NewBackend("PI")
	assert.Error(t, err, "backend type should be case-sensitive")
}

// --- NewBackendForAgent tests ---

func TestNewBackendForAgent_NoAgentID_FallsBackToCLI(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackendForAgent("claude", "")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "claude", backend.Name())
	// Falls back to CLI (AutoResumeBackend wrapping)
	assert.True(t, hasAutoResumeWrapper(backend))
}

func TestNewBackendForAgent_UnknownAgentID_FallsBackToCLI(t *testing.T) {
	setupTestBackends()
	backend, err := NewBackendForAgent("claude", "nonexistent-agent")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "claude", backend.Name())
}

func TestNewBackendForAgent_ACPStdioTransport(t *testing.T) {
	setupTestBackends()
	// Set up a test agent with ACP acp-stdio transport
	origAgents := model.Agents
	t.Cleanup(func() { model.Agents = origAgents })

	model.Agents = map[string]*model.Agent{
		"test-acp": {
			ID:         "test-acp",
			Backend:    "claude",
			Transport:  "acp-stdio",
			AcpCommand: "claude acp",
		},
	}

	backend, err := NewBackendForAgent("claude", "test-acp")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "claude", backend.Name())

	// ACP backends are NOT wrapped in AutoResumeBackend (session/cancel replaces it)
	assert.True(t, hasRequestRetryWrapper(backend), "claude ACP should be wrapped in RequestRetryBackend")
	assert.True(t, IsACPBackend(backend), "claude ACP should be ACPBackend (no AutoResume wrapping)")
	assert.False(t, hasAutoResumeWrapper(backend), "claude ACP should not have AutoResume")
}

func TestNewBackendForAgent_ACPHttpTransport_Unsupported(t *testing.T) {
	setupTestBackends()
	origAgents := model.Agents
	t.Cleanup(func() { model.Agents = origAgents })

	model.Agents = map[string]*model.Agent{
		"test-http": {
			ID:        "test-http",
			Backend:   "codebuddy",
			Transport: "acp-http",
		},
	}

	// acp-http is no longer supported; should fall back to CLI backend
	backend, err := NewBackendForAgent("codebuddy", "test-http")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "codebuddy", backend.Name())

	// Should fall back to AutoResumeBackend (CLI mode), not ACPBackend
	assert.True(t, hasAutoResumeWrapper(backend), "acp-http should fall back to CLI AutoResumeBackend")
}

func TestNewBackendForAgent_ACPNoAutoResume(t *testing.T) {
	setupTestBackends()
	origAgents := model.Agents
	t.Cleanup(func() { model.Agents = origAgents })

	model.Agents = map[string]*model.Agent{
		"test-kimi": {
			ID:         "test-kimi",
			Backend:    "kimi",
			Transport:  "acp-stdio",
			AcpCommand: "kimi --acp",
		},
	}

	backend, err := NewBackendForAgent("kimi", "test-kimi")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "kimi", backend.Name())

	// kimi ACP is NOT wrapped in AutoResumeBackend
	assert.True(t, IsACPBackend(backend), "kimi ACP should be ACPBackend")
	assert.False(t, hasAutoResumeWrapper(backend), "kimi ACP should not have AutoResume")
}

func TestNewBackendForAgent_CLITransport_FallsBack(t *testing.T) {
	setupTestBackends()
	origAgents := model.Agents
	t.Cleanup(func() { model.Agents = origAgents })

	model.Agents = map[string]*model.Agent{
		"test-cli": {
			ID:        "test-cli",
			Backend:   "claude",
			Transport: "cli",
		},
	}

	backend, err := NewBackendForAgent("claude", "test-cli")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "claude", backend.Name())

	// Should be the standard CLI AutoResumeBackend (not ACPBackend)
	assert.True(t, hasAutoResumeWrapper(backend))
	_, ok := concreteBackend(backend).(*CLIBackend)
	assert.True(t, ok, "inner should be CLIBackend for cli transport")
}

func TestNewBackendForAgentWithTransport_ACPOverrideOnCLIAgent_FallsBack(t *testing.T) {
	setupTestBackends()
	origAgents := model.Agents
	t.Cleanup(func() { model.Agents = origAgents })

	model.Agents = map[string]*model.Agent{
		"test-pi": {
			ID:        "test-pi",
			Backend:   "pi",
			Transport: "cli",
		},
	}

	// Session had acp-stdio persisted but agent (pi) only supports CLI.
	// Should fall back gracefully to CLI backend instead of erroring out.
	backend, err := NewBackendForAgentWithTransport("pi", "test-pi", "acp-stdio")
	assert.NoError(t, err)
	assert.NotNil(t, backend)
	assert.Equal(t, "pi", backend.Name())

	// Should be AutoResumeBackend (CLI mode), NOT ACPBackend
	assert.True(t, hasAutoResumeWrapper(backend), "acp-stdio override on CLI agent should fall back to AutoResumeBackend")
	assert.False(t, IsACPBackend(backend), "acp-stdio override on CLI agent should not be ACPBackend")
}
