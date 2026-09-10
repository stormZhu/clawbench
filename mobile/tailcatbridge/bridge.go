// Package tailcatbridge exposes the small, gomobile-friendly surface needed by
// the Android app. It intentionally hides Tailcat's unstable internal types.
package tailcatbridge

import (
	"context"
	"fmt"
	"net"
	"sync"

	"github.com/tailscale/tailcat"
)

// Forwarder maps a local TCP listener to a TCP port on a Tailcat server.
// Methods use only primitive/string types so gomobile can generate bindings.
type Forwarder struct {
	mu       sync.Mutex
	client   *tailcat.Client
	listener net.Listener
	closed   chan struct{}
	done     chan struct{}
	local    string
}

// Start creates a local loopback listener. localPort may be zero to let the OS
// choose a free port. Each accepted local connection is dialed to serverPort
// through the Tailcat data plane and proxied bidirectionally.
func Start(serverAddress string, serverPort int, localPort int) (*Forwarder, error) {
	if serverAddress == "" {
		return nil, fmt.Errorf("tailcat address is empty")
	}
	if serverPort < 1 || serverPort > 65535 {
		return nil, fmt.Errorf("invalid server port %d", serverPort)
	}
	if localPort < 0 || localPort > 65535 {
		return nil, fmt.Errorf("invalid local port %d", localPort)
	}
	// Both ports are range-checked above, so narrowing to uint16 here is safe.
	// Convert once at this boundary and thread the uint16 through the helpers
	// below, which are unexported and therefore invisible to gomobile.
	port := uint16(serverPort)

	// ListenConfig.Listen (rather than net.Listen) keeps the dialer-style
	// cancellation semantics, which noctx requires.
	var lc net.ListenConfig
	ln, err := lc.Listen(context.Background(), "tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		return nil, err
	}
	f := &Forwarder{
		client:   tailcat.NewClient(tailcat.ConnBlob(serverAddress)),
		listener: ln,
		closed:   make(chan struct{}),
		done:     make(chan struct{}),
		local:    ln.Addr().String(),
	}
	go f.acceptLoop(port)
	return f, nil
}

func (f *Forwarder) acceptLoop(serverPort uint16) {
	defer close(f.done)
	for {
		conn, err := f.listener.Accept()
		if err != nil {
			select {
			case <-f.closed:
				return
			default:
			}
			continue
		}
		go f.proxy(conn, serverPort)
	}
}

func (f *Forwarder) proxy(local net.Conn, serverPort uint16) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	remote, err := f.client.DialTCPPort(ctx, serverPort)
	if err != nil {
		_ = local.Close()
		return
	}
	tailcat.ProxyConns(local, remote)
}

// LocalAddress returns the loopback address that the Android WebView should
// load after Start succeeds.
func (f *Forwarder) LocalAddress() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.local
}

// Stop closes the local listener, all future accepts, and the Tailcat client.
func (f *Forwarder) Stop() error {
	f.mu.Lock()
	select {
	case <-f.closed:
		f.mu.Unlock()
		return nil
	default:
		close(f.closed)
	}
	err := f.listener.Close()
	_ = f.client.Close()
	f.mu.Unlock()
	<-f.done
	return err
}
