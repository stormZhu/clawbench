package ai

import (
	"context"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"clawbench/internal/model"
)

// shortenDrainTimingsForTest shrinks the LoadSession drain timings so tests
// run fast, restoring the originals on cleanup.
func shortenDrainTimingsForTest(t *testing.T) {
	t.Helper()
	origPoll, origQuiet, origMax := loadSessionDrainPollInterval, loadSessionDrainQuietWindow, loadSessionDrainMaxWait
	loadSessionDrainPollInterval = 5 * time.Millisecond
	loadSessionDrainQuietWindow = 30 * time.Millisecond
	loadSessionDrainMaxWait = 300 * time.Millisecond
	t.Cleanup(func() {
		loadSessionDrainPollInterval = origPoll
		loadSessionDrainQuietWindow = origQuiet
		loadSessionDrainMaxWait = origMax
	})
}

func newDrainTestConn(t *testing.T) (*ACPConn, *ClawBenchACPClient) {
	t.Helper()
	conn := newACPConn(&model.Agent{ID: "drain-test", Backend: "acp-stdio"}, "session-drain")
	client := NewClawBenchACPClient()
	client.connRef = conn
	conn.client = client
	conn.loadSessionActive.Store(true)
	return conn, client
}

func replayNotificationForTest(text string) acp.SessionNotification {
	return acp.SessionNotification{
		SessionId: acp.SessionId("acp-sid-drain"),
		Update: acp.SessionUpdate{
			AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{
				Content: acp.TextBlock(text),
			},
		},
	}
}

// Regression test for the LoadSession replay race: agents keep streaming
// history replay notifications after the session/load RPC returns. The drain
// must capture those late notifications and discard them instead of letting
// loadSessionActive clear early and leak the replay into the live stream.
func TestDrainLoadSessionReplay_DiscardsLateReplay(t *testing.T) {
	shortenDrainTimingsForTest(t)
	conn, client := newDrainTestConn(t)

	// Replay chunk that arrived during the RPC (already buffered).
	require.NoError(t, client.SessionUpdate(context.Background(), replayNotificationForTest("early replay")))

	// Late replay chunk arriving after the RPC returned, while the drain is
	// still waiting — this is the one that previously leaked into the next
	// prompt's stream.
	go func() {
		time.Sleep(10 * time.Millisecond)
		_ = client.SessionUpdate(context.Background(), replayNotificationForTest("late replay"))
	}()

	conn.drainLoadSessionReplay(context.Background())

	assert.False(t, conn.loadSessionActive.Load(), "loadSessionActive must be cleared after drain")
	assert.Empty(t, client.GetAndClearLoadSessionBuf(), "replay notifications must be discarded, not left behind")

	// After the drain, new updates must not be buffered (flag is cleared);
	// with no route registered they are dropped, never leaked into a buffer
	// a later consumer could mistake for live output.
	require.NoError(t, client.SessionUpdate(context.Background(), replayNotificationForTest("post-drain")))
	assert.Empty(t, client.GetAndClearLoadSessionBuf())
}

// The drain must keep waiting while replay notifications are still arriving,
// only exiting once the stream has been quiet for the quiet window.
func TestDrainLoadSessionReplay_WaitsWhileReplayKeepsArriving(t *testing.T) {
	shortenDrainTimingsForTest(t)
	conn, client := newDrainTestConn(t)

	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(4 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = client.SessionUpdate(context.Background(), replayNotificationForTest("burst"))
			}
		}
	}()
	go func() {
		time.Sleep(60 * time.Millisecond)
		close(stop)
	}()

	start := time.Now()
	conn.drainLoadSessionReplay(context.Background())
	elapsed := time.Since(start)

	assert.False(t, conn.loadSessionActive.Load())
	assert.GreaterOrEqual(t, elapsed, 60*time.Millisecond,
		"drain must not exit while replay notifications are still arriving")
	assert.Empty(t, client.GetAndClearLoadSessionBuf())
}

// When the agent sends no replay after the RPC, the drain must exit after one
// quiet window, not wait for the full max wait.
func TestDrainLoadSessionReplay_NoReplayExitsAfterQuietWindow(t *testing.T) {
	shortenDrainTimingsForTest(t)
	conn, _ := newDrainTestConn(t)

	start := time.Now()
	conn.drainLoadSessionReplay(context.Background())
	elapsed := time.Since(start)

	assert.False(t, conn.loadSessionActive.Load())
	assert.Less(t, elapsed, loadSessionDrainMaxWait,
		"drain must exit after the quiet window when no replay arrives")
}

// A continuously replaying agent must not stall recovery forever: the drain is
// bounded by the max wait and clears the flag regardless.
func TestDrainLoadSessionReplay_BoundedByMaxWait(t *testing.T) {
	shortenDrainTimingsForTest(t)
	conn, client := newDrainTestConn(t)

	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = client.SessionUpdate(context.Background(), replayNotificationForTest("endless"))
			}
		}
	}()

	start := time.Now()
	conn.drainLoadSessionReplay(context.Background())
	elapsed := time.Since(start)

	assert.False(t, conn.loadSessionActive.Load(), "flag must be cleared even when replay never stops")
	assert.Less(t, elapsed, 1*time.Second, "drain must give up after the max wait, not track the endless replay")
}

// A cancelled context must abort the drain promptly while still clearing the
// flag so the connection is not left in replay mode.
func TestDrainLoadSessionReplay_ContextCancelled(t *testing.T) {
	shortenDrainTimingsForTest(t)
	conn, client := newDrainTestConn(t)

	ctx, cancel := context.WithCancel(context.Background())
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = client.SessionUpdate(context.Background(), replayNotificationForTest("endless"))
			}
		}
	}()
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	conn.drainLoadSessionReplay(ctx)
	elapsed := time.Since(start)

	assert.False(t, conn.loadSessionActive.Load())
	assert.Less(t, elapsed, loadSessionDrainMaxWait, "drain must stop promptly after context cancellation")
}

// StopAndTakeLoadSessionReplay closes the capture boundary atomically. A
// notification that races with the stop must be either in the returned batch
// or routed after capture, never appended to a stale buffer afterward.
func TestStopAndTakeLoadSessionReplay_AtomicBoundary(t *testing.T) {
	conn, client := newDrainTestConn(t)
	client.SetLoadSessionBufForTest([]acp.SessionNotification{replayNotificationForTest("before stop")})

	buf := client.StopAndTakeLoadSessionReplay()
	assert.Len(t, buf, 1)
	assert.False(t, conn.loadSessionActive.Load())

	require.NoError(t, client.SessionUpdate(context.Background(), replayNotificationForTest("after stop")))
	assert.Empty(t, client.LoadSessionBufLen(), "post-stop updates must not be appended to replay buffer")
}
