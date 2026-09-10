package tailcat

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"

	"clawbench/internal/middleware"
	"clawbench/internal/model"
	"github.com/stretchr/testify/require"
)

// nilAddrConn models the connection Tailcat actually hands us: gonet.TCPConn
// returns nil from RemoteAddr/LocalAddr until the TCP handshake completes.
type nilAddrConn struct{ net.Conn }

func (nilAddrConn) RemoteAddr() net.Addr { return nil }
func (nilAddrConn) LocalAddr() net.Addr  { return nil }

// This is the regression test for the reason this listener exists.
//
// The old transport dialed the ClawBench HTTP listener over 127.0.0.1, so every
// tunneled request arrived with a loopback RemoteAddr, matched
// middleware.ShouldBypassAuth, and skipped authentication entirely. The
// underlying connection here genuinely reports 127.0.0.1; the assertion is
// that requests served over it still require a session cookie.
func TestTailcatChannelIsNotTreatedAsLocalhost(t *testing.T) {
	tcpLn, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = tcpLn.Close() }()

	client, err := net.Dial("tcp", tcpLn.Addr().String())
	require.NoError(t, err)
	defer func() { _ = client.Close() }()
	serverConn, err := tcpLn.Accept()
	require.NoError(t, err)

	host, _, err := net.SplitHostPort(serverConn.RemoteAddr().String())
	require.NoError(t, err)
	require.Equal(t, "127.0.0.1", host, "precondition: the raw connection looks local")

	origSession, origCookie, origExempt := model.SessionToken, model.CookieToken, model.LocalhostAuthExempt
	model.SessionToken, model.CookieToken, model.LocalhostAuthExempt = "session-token", "cookie-token", true
	t.Cleanup(func() {
		model.SessionToken, model.CookieToken, model.LocalhostAuthExempt = origSession, origCookie, origExempt
	})

	ln := newListener()
	srv := &http.Server{Handler: middleware.Auth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() {
		_ = srv.Close()
		_ = ln.Close()
	})

	go ln.Handle(serverConn)

	_, err = fmt.Fprintf(client, "GET /api/config HTTP/1.1\r\nHost: clawbench\r\nConnection: close\r\n\r\n")
	require.NoError(t, err)

	resp, err := http.ReadResponse(bufio.NewReader(client), nil)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusUnauthorized, resp.StatusCode,
		"a Tailcat connection must not inherit the localhost auth bypass")
}

func TestConnNeverReportsNilOrLocalhostAddr(t *testing.T) {
	c := &Conn{Conn: nilAddrConn{}, done: make(chan struct{})}

	require.NotNil(t, c.RemoteAddr())
	require.NotNil(t, c.LocalAddr())
	require.Equal(t, "tailcat", c.RemoteAddr().String())
	require.False(t, middleware.IsLocalhost(&http.Request{RemoteAddr: c.RemoteAddr().String()}))
}

func TestHandleUnblocksWhenListenerCloses(t *testing.T) {
	ln := newListener()
	serverEnd, clientEnd := net.Pipe()
	defer func() { _ = clientEnd.Close() }()

	returned := make(chan struct{})
	go func() {
		ln.Handle(serverEnd)
		close(returned)
	}()

	conn, err := ln.Accept()
	require.NoError(t, err)
	require.NotNil(t, conn)

	select {
	case <-returned:
		t.Fatal("Handle returned while its connection was still open")
	default:
	}

	require.NoError(t, ln.Close())

	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("Handle did not return after the listener was closed")
	}

	_, err = ln.Accept()
	require.ErrorIs(t, err, ErrListenerClosed)
}

func TestHandleAfterCloseClosesConn(t *testing.T) {
	ln := newListener()
	require.NoError(t, ln.Close())

	serverEnd, clientEnd := net.Pipe()
	defer func() { _ = clientEnd.Close() }()

	ln.Handle(serverEnd)

	// A flow that arrives after shutdown must be closed, not parked.
	_, err := clientEnd.Read(make([]byte, 1))
	require.Error(t, err)
}

func TestListenerAddrIsChannelAddress(t *testing.T) {
	ln := newListener()
	require.Equal(t, "tailcat", ln.Addr().Network())
	require.Equal(t, "tailcat", ln.Addr().String())
	require.NoError(t, ln.Close())
	require.NoError(t, ln.Close(), "Close must be idempotent")
}
