package tailcat

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	thirdparty "github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

func TestManagerDisabledDoesNotStart(t *testing.T) {
	m := New(Config{Enabled: false, RequirePassword: true})
	require.NoError(t, m.Start(context.Background(), 20000, http.NewServeMux()))
	require.Equal(t, StateDisabled, m.Status().State)
	require.Empty(t, m.Address())
	require.Nil(t, m.Listener())
}

func TestManagerStopWithoutStart(t *testing.T) {
	m := New(Config{Enabled: true, RequirePassword: true})
	require.NoError(t, m.Stop(context.Background()))
	require.Equal(t, StateStopped, m.Status().State)
}

// The Tailcat transport has no authentication of its own, so it must refuse to
// run without the require_password assertion and without ClawBench password
// auth. Every guard is checked before any network access, which is why these
// tests stay offline.
func TestManagerRefusesToStart(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		port    int
		handler http.Handler
		wantErr error
	}{
		{
			name:    "require_password false",
			cfg:     Config{Enabled: true, RequirePassword: false, AuthEnabled: true},
			port:    20000,
			handler: http.NewServeMux(),
			wantErr: ErrRequirePasswordDisabled,
		},
		{
			name:    "password auth disabled",
			cfg:     Config{Enabled: true, RequirePassword: true, AuthEnabled: false},
			port:    20000,
			handler: http.NewServeMux(),
			wantErr: ErrAuthDisabled,
		},
		{
			name:    "nil handler",
			cfg:     Config{Enabled: true, RequirePassword: true, AuthEnabled: true},
			port:    20000,
			handler: nil,
		},
		{
			name:    "port out of range",
			cfg:     Config{Enabled: true, RequirePassword: true, AuthEnabled: true},
			port:    0,
			handler: http.NewServeMux(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := New(tt.cfg)
			err := m.Start(context.Background(), tt.port, tt.handler)
			require.Error(t, err)
			if tt.wantErr != nil {
				require.ErrorIs(t, err, tt.wantErr)
			}
			status := m.Status()
			require.Equal(t, StateError, status.State)
			require.False(t, status.Running)
			require.Contains(t, status.Error, err.Error())
			// A refused start must leave nothing half-initialized behind, so the
			// control endpoint has nothing to restart either.
			require.Nil(t, m.Listener())
			require.ErrorIs(t, m.StartExisting(context.Background()), ErrNotInitialized)
			require.NoError(t, m.Stop(context.Background()))
			require.Equal(t, StateStopped, m.Status().State)
		})
	}
}

func TestStartExistingBeforeFirstStart(t *testing.T) {
	m := New(Config{Enabled: true, RequirePassword: true, AuthEnabled: true})
	require.ErrorIs(t, m.StartExisting(context.Background()), ErrNotInitialized)
}

func TestValidateStartPortBounds(t *testing.T) {
	cfg := Config{Enabled: true, RequirePassword: true, AuthEnabled: true}
	require.Error(t, validateStart(cfg, -1, http.NewServeMux()))
	require.Error(t, validateStart(cfg, 70000, http.NewServeMux()))
	require.NoError(t, validateStart(cfg, 1, http.NewServeMux()))
	require.NoError(t, validateStart(cfg, 65535, http.NewServeMux()))
}

func TestBuildServerServesOnlyTheClawBenchPort(t *testing.T) {
	s, err := buildServer(Config{}, 20000, newListener())
	require.NoError(t, err)
	require.NotNil(t, s.OnTCP, "OnTCP must be installed or every flow is reset")
	require.NotNil(t, s.OnTCP(20000), "the ClawBench port must be served")
	require.Nil(t, s.OnTCP(20001), "every other port must be reset")
}

func TestBuildServerAppliesDERPMapURL(t *testing.T) {
	const derpURL = "https://example.invalid/derpmap.json"
	s, err := buildServer(Config{DERPMapURL: derpURL}, 20000, newListener())
	require.NoError(t, err)
	require.Equal(t, derpURL, s.DERPMapURL)
}

func TestBuildServerAllowClients(t *testing.T) {
	t.Run("round-trips a node key", func(t *testing.T) {
		encoded, err := key.NewNode().Public().MarshalText()
		require.NoError(t, err)

		s, err := buildServer(Config{AllowClients: []string{string(encoded)}}, 20000, newListener())
		require.NoError(t, err)
		require.Len(t, s.AllowedClients, 1)
	})

	t.Run("rejects a malformed key", func(t *testing.T) {
		_, err := buildServer(Config{AllowClients: []string{"not-a-node-key"}}, 20000, newListener())
		require.ErrorContains(t, err, "allow_clients")
	})
}

// The resolving path calls out to the DERP map, so only the short circuit is
// covered here.
func TestResolveAddressShortCircuitsWhenFullAddressIsOff(t *testing.T) {
	blob := thirdparty.ConnBlob("tcom-test-blob")
	require.Equal(t, blob, resolveAddress(t.Context(), Config{FullAddress: false}, blob))
}
