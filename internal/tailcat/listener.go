package tailcat

import (
	"errors"
	"net"
	"sync"
)

// ErrListenerClosed is returned by Accept once the listener has been closed.
var ErrListenerClosed = errors.New("tailcat: listener closed")

// channelAddr is the net.Addr reported for connections that arrive over the
// Tailcat transport.
//
// It is deliberately not an IP address. Two reasons:
//
//  1. The address would be invented. Tailcat authenticates peers by node
//     public key, and its OnTCP callback receives only the destination port —
//     the client's source address is dropped inside the library — so there is
//     no peer address to report.
//  2. Reporting a non-loopback address is what keeps tunneled requests out of
//     the localhost auth bypass in internal/middleware. Before this listener
//     existed the transport dialed the HTTP listener over 127.0.0.1, so every
//     tunneled request arrived looking local and skipped authentication
//     entirely: anyone holding the Tailcat address had unauthenticated access
//     to every /api route.
type channelAddr struct{}

func (channelAddr) Network() string { return "tailcat" }
func (channelAddr) String() string  { return "tailcat" }

// Conn is a Tailcat connection being handed to the HTTP server.
//
// RemoteAddr and LocalAddr are pinned to channelAddr. Pinning RemoteAddr is a
// security control, not a cosmetic one: requests on this transport must never
// be classifiable as localhost. Pinning LocalAddr is defensive — the
// underlying gonet.TCPConn reports nil for both until the TCP handshake
// completes, and net/http calls RemoteAddr().String() as soon as it starts
// serving a connection.
type Conn struct {
	net.Conn

	done chan struct{}
	once sync.Once
}

// RemoteAddr implements net.Conn. It never returns nil and never returns a
// loopback address; see the type comment.
func (c *Conn) RemoteAddr() net.Addr { return channelAddr{} }

// LocalAddr implements net.Conn and never returns nil, so callers that format
// both addresses cannot panic on a connection still completing its handshake.
func (c *Conn) LocalAddr() net.Addr { return channelAddr{} }

// Close implements net.Conn. It signals Handle, which is blocked waiting for
// the flow to finish.
func (c *Conn) Close() error {
	c.once.Do(func() { close(c.done) })
	return c.Conn.Close()
}

// Listener is a net.Listener fed by Tailcat flows.
//
// The Manager owns one and hands it to an http.Server, so the transport
// terminates in-process instead of bouncing through a loopback TCP hop. That
// in-process hop is the whole point: it is what lets the auth middleware see
// the connection as non-local.
type Listener struct {
	conns  chan *Conn
	closed chan struct{}
	once   sync.Once
}

func newListener() *Listener {
	return &Listener{
		conns:  make(chan *Conn, 128),
		closed: make(chan struct{}),
	}
}

// Accept implements net.Listener.
func (l *Listener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.closed:
		return nil, ErrListenerClosed
	}
}

// Close implements net.Listener. It is idempotent and unblocks Accept and any
// in-flight Handle call.
func (l *Listener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

// Addr implements net.Listener.
func (l *Listener) Addr() net.Addr { return channelAddr{} }

// Handle runs a single accepted Tailcat flow.
//
// The Tailcat flow handler must not return until the connection is finished —
// returning early tears the flow down — so Handle blocks until the HTTP server
// closes the connection, or the listener shuts down. Connections queue on a
// bounded buffer while the HTTP server is starting up; beyond that the send
// blocks rather than dropping the flow, because netstack already caps how many
// TCP flows one peer may have in flight.
func (l *Listener) Handle(conn net.Conn) {
	c := &Conn{Conn: conn, done: make(chan struct{})}
	select {
	case l.conns <- c:
	case <-l.closed:
		_ = conn.Close()
		return
	}
	select {
	case <-c.done:
	case <-l.closed:
		_ = conn.Close()
	}
}
