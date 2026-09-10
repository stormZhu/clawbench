package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"clawbench/internal/model"
	transport "clawbench/internal/tailcat"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setTailcatManager swaps the process-wide manager for the duration of a test.
func setTailcatManager(t *testing.T, m *transport.Manager) {
	t.Helper()
	orig := tailcatManager
	tailcatManager = m
	t.Cleanup(func() { tailcatManager = orig })
}

func decodeTailcatJSON(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var resp map[string]any
	require.NoError(t, json.Unmarshal(body, &resp))
	return resp
}

func TestServeTailcatStatus_NilManagerReportsDisabled(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()
	setTailcatManager(t, nil)

	req := withAuthCookie(httptest.NewRequest(http.MethodGet, "/api/tailcat/status", http.NoBody), model.SessionToken)
	w := httptest.NewRecorder()
	ServeTailcatStatus(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	resp := decodeTailcatJSON(t, w.Body.Bytes())
	assert.Equal(t, tailcatStateDisabled, resp["state"])
	assert.Equal(t, false, resp["running"])
}

func TestServeTailcatStatus_ReportsRefusalReason(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()

	// A transport that refuses to start must still explain itself on the
	// status endpoint, otherwise the operator sees only "not running".
	m := transport.New(transport.Config{Enabled: true, RequirePassword: false, AuthEnabled: true})
	require.ErrorIs(t, m.Start(t.Context(), 20000, http.NewServeMux()), transport.ErrRequirePasswordDisabled)
	setTailcatManager(t, m)

	w := httptest.NewRecorder()
	ServeTailcatStatus(w, httptest.NewRequest(http.MethodGet, "/api/tailcat/status", http.NoBody))

	require.Equal(t, http.StatusOK, w.Code)
	resp := decodeTailcatJSON(t, w.Body.Bytes())
	assert.Equal(t, string(transport.StateError), resp["state"])
	assert.Contains(t, resp["error"], "require_password")
}

func TestServeTailcatStatus_MethodNotAllowed(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()

	w := httptest.NewRecorder()
	ServeTailcatStatus(w, httptest.NewRequest(http.MethodPost, "/api/tailcat/status", http.NoBody))
	assert.Equal(t, http.StatusMethodNotAllowed, w.Code)
}

func TestServeTailcatStart_NilManager(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()
	setTailcatManager(t, nil)

	w := httptest.NewRecorder()
	ServeTailcatStart(w, httptest.NewRequest(http.MethodPost, "/api/tailcat/start", http.NoBody))
	assert.Equal(t, http.StatusNotImplemented, w.Code)
}

func TestServeTailcatStart_SurfacesError(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()
	setTailcatManager(t, transport.New(transport.Config{Enabled: true, RequirePassword: true, AuthEnabled: true}))

	w := httptest.NewRecorder()
	ServeTailcatStart(w, httptest.NewRequest(http.MethodPost, "/api/tailcat/start", http.NoBody))

	require.Equal(t, http.StatusBadGateway, w.Code)
	resp := decodeTailcatJSON(t, w.Body.Bytes())
	assert.NotEmpty(t, resp[strReqError])
}

func TestServeTailcatStart_MethodNotAllowed(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()

	w := httptest.NewRecorder()
	ServeTailcatStart(w, httptest.NewRequest(http.MethodGet, "/api/tailcat/start", http.NoBody))
	assert.Equal(t, http.StatusMethodNotAllowed, w.Code)
}

func TestServeTailcatStop_NilManagerIsNoop(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()
	setTailcatManager(t, nil)

	w := httptest.NewRecorder()
	ServeTailcatStop(w, httptest.NewRequest(http.MethodPost, "/api/tailcat/stop", http.NoBody))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, true, decodeTailcatJSON(t, w.Body.Bytes())["ok"])
}

func TestServeTailcatStop_StopsManager(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()
	m := transport.New(transport.Config{Enabled: true, RequirePassword: true, AuthEnabled: true})
	setTailcatManager(t, m)

	w := httptest.NewRecorder()
	ServeTailcatStop(w, httptest.NewRequest(http.MethodPost, "/api/tailcat/stop", http.NoBody))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, transport.StateStopped, m.Status().State)
}

func TestServeTailcatStop_MethodNotAllowed(t *testing.T) {
	_, teardown := setupTestEnv(t)
	defer teardown()

	w := httptest.NewRecorder()
	ServeTailcatStop(w, httptest.NewRequest(http.MethodGet, "/api/tailcat/stop", http.NoBody))
	assert.Equal(t, http.StatusMethodNotAllowed, w.Code)
}
