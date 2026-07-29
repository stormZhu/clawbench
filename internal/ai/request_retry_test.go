package ai

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"clawbench/internal/model"

	"github.com/stretchr/testify/require"
)

type scriptedBackend struct {
	name     string
	calls    int
	scripts  []func(ctx context.Context, ch chan<- StreamEvent) error
	startErr []error // optional per-call start errors
}

func (b *scriptedBackend) Name() string { return b.name }

func (b *scriptedBackend) ExecuteStream(ctx context.Context, req ChatRequest) (<-chan StreamEvent, error) {
	idx := b.calls
	b.calls++
	if idx < len(b.startErr) && b.startErr[idx] != nil {
		return nil, b.startErr[idx]
	}
	ch := make(chan StreamEvent, 16)
	go func() {
		defer close(ch)
		if idx < len(b.scripts) && b.scripts[idx] != nil {
			_ = b.scripts[idx](ctx, ch)
		}
	}()
	return ch, nil
}

func collectRetryEvents(t *testing.T, ch <-chan StreamEvent, timeout time.Duration) []StreamEvent {
	t.Helper()
	var events []StreamEvent
	deadline := time.After(timeout)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return events
			}
			events = append(events, ev)
		case <-deadline:
			t.Fatalf("timed out collecting events, got %d so far", len(events))
		}
	}
}

func TestRequestRetry_SucceedsAfterTransientFailure(t *testing.T) {
	inner := &scriptedBackend{
		name: "mock",
		scripts: []func(context.Context, chan<- StreamEvent) error{
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "error", Error: "rate limited", Reason: ReasonRequestFailed}
				ch <- StreamEvent{Type: "done"}
				return nil
			},
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "content", Content: "hello"}
				ch <- StreamEvent{Type: "done"}
				return nil
			},
		},
	}
	backend := &RequestRetryBackend{
		inner:       inner,
		maxAttempts: 3,
		baseDelay:   time.Millisecond,
		sleep: func(ctx context.Context, d time.Duration) error {
			return nil
		},
	}

	ch, err := backend.ExecuteStream(context.Background(), ChatRequest{SessionID: "s1"})
	require.NoError(t, err)
	events := collectRetryEvents(t, ch, 2*time.Second)

	require.GreaterOrEqual(t, len(events), 3)
	assert.Equal(t, 2, inner.calls)

	var retryEv *StreamEvent
	var contentEv *StreamEvent
	var doneCount int
	for i := range events {
		switch events[i].Type {
		case "retry":
			retryEv = &events[i]
		case "content":
			contentEv = &events[i]
		case "done":
			doneCount++
		case "error":
			t.Fatalf("unexpected terminal error before success: %+v", events[i])
		}
	}
	require.NotNil(t, retryEv)
	assert.Equal(t, 2, retryEv.Attempt)
	assert.Equal(t, 3, retryEv.MaxAttempts)
	assert.Equal(t, ReasonRetrying, retryEv.Reason)
	require.NotNil(t, contentEv)
	assert.Equal(t, "hello", contentEv.Content)
	assert.Equal(t, 1, doneCount)
}

func TestRequestRetry_ExhaustsAttempts(t *testing.T) {
	inner := &scriptedBackend{
		name: "mock",
		scripts: []func(context.Context, chan<- StreamEvent) error{
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "warning", Content: "AI backend exited abnormally", Reason: ReasonBackendExit}
				return nil
			},
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "warning", Content: "AI backend exited abnormally", Reason: ReasonBackendExit}
				return nil
			},
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "warning", Content: "AI backend exited abnormally", Reason: ReasonBackendExit}
				return nil
			},
		},
	}
	backend := &RequestRetryBackend{
		inner:       inner,
		maxAttempts: 3,
		baseDelay:   time.Millisecond,
		sleep:       func(context.Context, time.Duration) error { return nil },
	}
	ch, err := backend.ExecuteStream(context.Background(), ChatRequest{SessionID: "s1"})
	require.NoError(t, err)
	events := collectRetryEvents(t, ch, 2*time.Second)

	assert.Equal(t, 3, inner.calls)
	retryCount := 0
	warnCount := 0
	for _, ev := range events {
		switch ev.Type {
		case "retry":
			retryCount++
		case "warning":
			warnCount++
			assert.Equal(t, ReasonBackendExit, ev.Reason)
		}
	}
	assert.Equal(t, 2, retryCount, "should emit retry before attempts 2 and 3")
	assert.Equal(t, 1, warnCount, "final failure should surface once")
}

func TestRequestRetry_DoesNotRetryAuthFailure(t *testing.T) {
	inner := &scriptedBackend{
		name: "mock",
		scripts: []func(context.Context, chan<- StreamEvent) error{
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "error", Error: "Unauthorized (401) invalid credentials", Reason: ReasonRequestFailed}
				ch <- StreamEvent{Type: "done"}
				return nil
			},
		},
	}
	backend := &RequestRetryBackend{
		inner:       inner,
		maxAttempts: 3,
		baseDelay:   time.Millisecond,
		sleep:       func(context.Context, time.Duration) error { return nil },
	}
	ch, err := backend.ExecuteStream(context.Background(), ChatRequest{})
	require.NoError(t, err)
	events := collectRetryEvents(t, ch, time.Second)
	assert.Equal(t, 1, inner.calls)
	for _, ev := range events {
		assert.NotEqual(t, "retry", ev.Type)
	}
}

func TestRequestRetry_DoesNotRetryAfterContent(t *testing.T) {
	inner := &scriptedBackend{
		name: "mock",
		scripts: []func(context.Context, chan<- StreamEvent) error{
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "content", Content: "partial"}
				ch <- StreamEvent{Type: "error", Error: "boom", Reason: ReasonRequestFailed}
				ch <- StreamEvent{Type: "done"}
				return nil
			},
		},
	}
	backend := &RequestRetryBackend{
		inner:       inner,
		maxAttempts: 3,
		baseDelay:   time.Millisecond,
		sleep:       func(context.Context, time.Duration) error { return nil },
	}
	ch, err := backend.ExecuteStream(context.Background(), ChatRequest{})
	require.NoError(t, err)
	events := collectRetryEvents(t, ch, time.Second)
	assert.Equal(t, 1, inner.calls)
	for _, ev := range events {
		assert.NotEqual(t, "retry", ev.Type)
	}
}

func TestRequestRetry_StartErrorRetries(t *testing.T) {
	inner := &scriptedBackend{
		name: "mock",
		startErr: []error{
			errors.New("connection reset"),
			nil,
		},
		scripts: []func(context.Context, chan<- StreamEvent) error{
			nil,
			func(_ context.Context, ch chan<- StreamEvent) error {
				ch <- StreamEvent{Type: "content", Content: "ok"}
				ch <- StreamEvent{Type: "done"}
				return nil
			},
		},
	}
	backend := &RequestRetryBackend{
		inner:       inner,
		maxAttempts: 3,
		baseDelay:   time.Millisecond,
		sleep:       func(context.Context, time.Duration) error { return nil },
	}
	ch, err := backend.ExecuteStream(context.Background(), ChatRequest{})
	require.NoError(t, err)
	events := collectRetryEvents(t, ch, time.Second)
	assert.Equal(t, 2, inner.calls)
	foundRetry := false
	foundContent := false
	for _, ev := range events {
		if ev.Type == "retry" {
			foundRetry = true
		}
		if ev.Type == "content" {
			foundContent = true
		}
	}
	assert.True(t, foundRetry)
	assert.True(t, foundContent)
}

func TestIsRetriableFailureEvent(t *testing.T) {
	assert.True(t, isRetriableFailureEvent(StreamEvent{Type: "error", Error: "rate limited", Reason: ReasonRequestFailed}))
	assert.True(t, isRetriableFailureEvent(StreamEvent{Type: "warning", Content: "exit", Reason: ReasonBackendExit}))
	assert.False(t, isRetriableFailureEvent(StreamEvent{Type: "error", Error: "Unauthorized (401)", Reason: ReasonRequestFailed}))
	assert.False(t, isRetriableFailureEvent(StreamEvent{Type: "warning", Content: "user cancelled", Reason: ReasonUserCancel}))
}

func TestWithRequestRetry_Idempotent(t *testing.T) {
	inner := &scriptedBackend{name: "x"}
	once := WithRequestRetry(inner)
	twice := WithRequestRetry(once)
	assert.Same(t, once, twice)
	assert.True(t, hasRequestRetryWrapper(once))
}

func TestUnwrapBackend_PeelsWrappers(t *testing.T) {
	inner := &scriptedBackend{name: "x"}
	wrapped := WithRequestRetry(&AutoResumeBackend{inner: inner})
	assert.Same(t, inner, UnwrapBackend(wrapped))
	assert.False(t, IsACPBackend(wrapped))
}


func TestAccumulateBlock_RetryEvent(t *testing.T) {
	var blocks []model.ContentBlock
	AccumulateBlock(&blocks, StreamEvent{
		Type:        "retry",
		Content:     "rate limited",
		Reason:      ReasonRetrying,
		Attempt:     2,
		MaxAttempts: 3,
	})
	require.Len(t, blocks, 1)
	assert.Equal(t, "retry", blocks[0].Type)
	assert.Equal(t, "rate limited", blocks[0].Text)
	assert.Equal(t, ReasonRetrying, blocks[0].Reason)
	assert.Equal(t, 2, blocks[0].Attempt)
	assert.Equal(t, 3, blocks[0].MaxAttempts)
}

func TestAccumulateBlock_RetryEventUpdatesInPlace(t *testing.T) {
	var blocks []model.ContentBlock
	AccumulateBlock(&blocks, StreamEvent{
		Type:        "retry",
		Content:     "rate limited",
		Reason:      ReasonRetrying,
		Attempt:     2,
		MaxAttempts: 3,
	})
	AccumulateBlock(&blocks, StreamEvent{
		Type:        "retry",
		Content:     "timeout",
		Reason:      ReasonRetrying,
		Attempt:     3,
		MaxAttempts: 3,
	})
	require.Len(t, blocks, 1)
	assert.Equal(t, "retry", blocks[0].Type)
	assert.Equal(t, "timeout", blocks[0].Text)
	assert.Equal(t, 3, blocks[0].Attempt)
	assert.Equal(t, 3, blocks[0].MaxAttempts)
}

func TestIsNonRetriableErrorText_SerializationError(t *testing.T) {
	assert.True(t, isNonRetriableErrorText(`acp: prompt: serialization error: missing field annotations`))
	assert.True(t, isNonRetriableErrorText(`Method not found`))
	assert.False(t, isNonRetriableErrorText(`rate limited`))
}
