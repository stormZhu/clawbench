// Package tailcat provides the isolated Tailcat transport adapter.
package tailcat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"

	thirdparty "github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

type State string

const (
	StateDisabled State = "disabled"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateStopped  State = "stopped"
	StateError    State = "error"
)

var (
	// ErrRequirePasswordDisabled is returned when tailcat.require_password is
	// false. The Tailcat transport has no authentication of its own: the
	// address is a bearer credential and allow_clients is empty by default, so
	// an unauthenticated ClawBench channel over it is not supported.
	ErrRequirePasswordDisabled = errors.New("tailcat: tailcat.require_password must be true (the transport has no authentication of its own)")

	// ErrAuthDisabled is returned when ClawBench password authentication is not
	// active. Starting anyway would expose every route to anyone holding the
	// Tailcat address.
	ErrAuthDisabled = errors.New("tailcat: refusing to start without ClawBench password authentication")

	// ErrNotInitialized is returned by StartExisting before the first Start.
	ErrNotInitialized = errors.New("tailcat: transport has not been initialized")
)

type Config struct {
	Enabled      bool
	DERPMapURL   string
	FullAddress  bool
	AllowClients []string

	// RequirePassword must be true. It asserts that the Tailcat channel
	// presents the ClawBench session cookie rather than being trusted on the
	// strength of the address alone. Start fails closed when it is false.
	RequirePassword bool

	// AuthEnabled reports whether ClawBench password authentication is active
	// (model.SessionToken != ""). Start refuses to run without it, because the
	// transport adds no authentication of its own.
	AuthEnabled bool
}

type Status struct {
	State           State  `json:"state"`
	Running         bool   `json:"running"`
	Address         string `json:"address,omitempty"`
	Port            int    `json:"port,omitempty"`
	RequirePassword bool   `json:"require_password"`
	Error           string `json:"error,omitempty"`
}

// Manager owns one Tailcat server and terminates its virtual TCP port directly
// in an *http.Server, so tunneled requests are served in-process.
//
// It deliberately exposes only ClawBench types to callers so the third-party
// API remains isolated. The Tailcat address is a credential: it is never
// logged and never persisted.
type Manager struct {
	mu     sync.RWMutex
	cfg    Config
	status Status

	server  *thirdparty.Server
	ln      *Listener
	srv     *http.Server
	address string

	// listenPort and handler survive Stop so the authenticated control
	// endpoint can restart the transport. Both are fixed at the first Start
	// and never come from a client.
	listenPort int
	handler    http.Handler
}

func New(cfg Config) *Manager {
	state := StateDisabled
	if cfg.Enabled {
		state = StateStopped
	}
	return &Manager{cfg: cfg, status: Status{State: state, RequirePassword: cfg.RequirePassword}}
}

// validateStart checks everything that must hold before the transport is
// allowed to touch the network. It is a pure function so the checks are
// trivially testable and cannot leave partially-applied state behind.
func validateStart(cfg Config, port int, handler http.Handler) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("tailcat: invalid listener port %d", port)
	}
	if handler == nil {
		return errors.New("tailcat: no HTTP handler configured")
	}
	if !cfg.RequirePassword {
		return ErrRequirePasswordDisabled
	}
	if !cfg.AuthEnabled {
		return ErrAuthDisabled
	}
	return nil
}

// buildServer assembles the Tailcat server, serving only port and handing every
// such flow to ln. The port is captured by value so the OnTCP callback never
// reads manager state that another goroutine could be mutating.
func buildServer(cfg Config, port int, ln *Listener) (*thirdparty.Server, error) {
	s := &thirdparty.Server{Logf: func(format string, args ...any) {
		slog.Debug("tailcat", "message", fmt.Sprintf(format, args...))
	}}
	for _, raw := range cfg.AllowClients {
		var clientKey key.NodePublic
		if err := clientKey.UnmarshalText([]byte(raw)); err != nil {
			return nil, fmt.Errorf("invalid tailcat allow_clients key: %w", err)
		}
		s.AllowedClients = append(s.AllowedClients, clientKey)
	}
	if cfg.DERPMapURL != "" {
		s.DERPMapURL = cfg.DERPMapURL
	}
	s.OnTCP = func(connPort uint16) func(net.Conn) {
		if int(connPort) != port {
			return nil
		}
		return ln.Handle
	}
	return s, nil
}

// resolveAddress expands the connection blob into a full address when the
// operator asked for one, falling back to the blob if resolution fails.
func resolveAddress(ctx context.Context, cfg Config, blob thirdparty.ConnBlob) thirdparty.ConnBlob {
	if !cfg.FullAddress {
		return blob
	}
	opts := []any{thirdparty.ExpandForServer}
	if cfg.DERPMapURL != "" {
		opts = append(opts, thirdparty.DERPMapURL(cfg.DERPMapURL))
	}
	resolved, err := blob.Resolve(ctx, opts...)
	if err != nil {
		slog.Warn("tailcat full address resolution failed", "err", err)
		return blob
	}
	return resolved
}

// Start serves the ClawBench HTTP handler on the Tailcat transport.
//
// port is the ClawBench listener port, which doubles as the virtual Tailcat
// TCP port: clients dial <address>:<port> and land on this handler.
func (m *Manager) Start(ctx context.Context, port int, handler http.Handler) error {
	cfg := m.cfg
	if !cfg.Enabled {
		m.mu.Lock()
		m.status = Status{State: StateDisabled, RequirePassword: cfg.RequirePassword}
		m.mu.Unlock()
		return nil
	}
	if err := validateStart(cfg, port, handler); err != nil {
		m.setError(err)
		return err
	}

	// Claim the start under the same lock that records it, so a concurrent
	// call (boot plus the control endpoint) cannot build a second Tailcat
	// server and leak the first one.
	m.mu.Lock()
	if m.server != nil || m.status.State == StateStarting {
		m.mu.Unlock()
		return nil
	}
	m.listenPort = port
	m.handler = handler
	m.status = Status{State: StateStarting, RequirePassword: cfg.RequirePassword}
	m.mu.Unlock()

	if len(cfg.AllowClients) == 0 {
		// Operator-visible, not fatal: ClawBench password auth still applies to
		// every tunneled request, so an unlisted peer gains nothing.
		slog.Warn("tailcat: allow_clients is empty, any Tailcat peer may connect (ClawBench password auth still applies)")
	}

	ln := newListener()
	s, err := buildServer(cfg, port, ln)
	if err != nil {
		_ = ln.Close()
		m.setError(err)
		return err
	}
	if err := s.Start(); err != nil {
		_ = ln.Close()
		m.setError(err)
		return err
	}

	address := resolveAddress(ctx, cfg, s.ConnBlob())
	srv := &http.Server{Handler: handler}

	m.mu.Lock()
	m.server, m.ln, m.srv = s, ln, srv
	m.address = string(address)
	m.status = Status{
		State:           StateRunning,
		Running:         true,
		Address:         m.address,
		Port:            port,
		RequirePassword: cfg.RequirePassword,
	}
	m.mu.Unlock()

	slog.Info("tailcat transport listening (ClawBench password auth required on this channel)", slog.Int("port", port))

	go func() {
		if err := srv.Serve(ln); err != nil &&
			!errors.Is(err, http.ErrServerClosed) &&
			!errors.Is(err, ErrListenerClosed) {
			slog.Error("tailcat http listener stopped", slog.String("err", err.Error()))
		}
	}()
	return nil
}

// StartExisting restarts a stopped manager on the listener port supplied
// during the initial server startup. It is used by the authenticated control
// endpoint and never accepts a port or handler from the client.
func (m *Manager) StartExisting(ctx context.Context) error {
	m.mu.RLock()
	port, handler := m.listenPort, m.handler
	m.mu.RUnlock()
	if port == 0 || handler == nil {
		return ErrNotInitialized
	}
	return m.Start(ctx, port, handler)
}

// Listener returns the transport listener, or nil when not running. It exists
// for tests and diagnostics; the Manager serves it itself.
func (m *Manager) Listener() *Listener {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.ln
}

func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	s, srv, ln := m.server, m.srv, m.ln
	m.server, m.srv, m.ln = nil, nil, nil
	m.address = ""
	state := StateStopped
	if !m.cfg.Enabled {
		state = StateDisabled
	}
	m.status = Status{State: state, RequirePassword: m.cfg.RequirePassword}
	m.mu.Unlock()

	// Order matters. Closing the HTTP server first stops new tunneled requests
	// and closes in-flight connections, which lets the Tailcat flow handlers
	// return; only then is it safe to drop the Tailcat server itself.
	if srv != nil {
		_ = srv.Close()
	}
	if ln != nil {
		_ = ln.Close()
	}
	if s == nil {
		return nil
	}
	return s.Close()
}

func (m *Manager) Status() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Manager) Address() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.address
}

func (m *Manager) setError(err error) {
	m.mu.Lock()
	m.server = nil
	m.ln = nil
	m.srv = nil
	m.address = ""
	m.status = Status{
		State:           StateError,
		RequirePassword: m.cfg.RequirePassword,
		Error:           err.Error(),
	}
	m.mu.Unlock()
}
