package ai

import (
	"context"
	"log/slog"
	"strings"
	"time"
)

// Default request-retry policy for transient AI failures (rate limits, network
// blips, backend crashes with no partial output).
const (
	defaultMaxRequestAttempts = 3
	defaultRetryBaseDelay     = 1 * time.Second
)

// defaultRequestRetrySleep is the backoff implementation used by WithRequestRetry.
// Tests may replace it via SetRequestRetrySleepForTest to avoid real waits.
var defaultRequestRetrySleep = sleepContext

// RequestRetryBackend wraps an AIBackend and automatically re-runs ExecuteStream
// when the first attempt ends with a retriable failure and produced no
// meaningful content (text / thinking / tools). Intermediate failures emit a
// "retry" stream event so the UI can show "Retrying (n/max)".
type RequestRetryBackend struct {
	inner       AIBackend
	maxAttempts int
	baseDelay   time.Duration
	// sleep is injectable for tests; defaults to time.Sleep.
	sleep func(context.Context, time.Duration) error
}

// WithRequestRetry wraps backend with the default retry policy.
// Nil backends are returned unchanged.
func WithRequestRetry(backend AIBackend) AIBackend {
	if backend == nil {
		return nil
	}
	if _, ok := backend.(*RequestRetryBackend); ok {
		return backend
	}
	return &RequestRetryBackend{
		inner:       backend,
		maxAttempts: defaultMaxRequestAttempts,
		baseDelay:   defaultRetryBaseDelay,
		sleep:       defaultRequestRetrySleep,
	}
}

// Name returns the wrapped backend name.
func (b *RequestRetryBackend) Name() string {
	return b.inner.Name()
}

// Unwrap returns the inner backend (for type assertions through wrappers).
func (b *RequestRetryBackend) Unwrap() AIBackend {
	return b.inner
}

// ExecuteStream proxies the inner stream and retries on retriable empty failures.
func (b *RequestRetryBackend) ExecuteStream(ctx context.Context, req ChatRequest) (<-chan StreamEvent, error) {
	outerCh := make(chan StreamEvent, streamChanSize)
	maxAttempts := b.maxAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultMaxRequestAttempts
	}
	baseDelay := b.baseDelay
	if baseDelay <= 0 {
		baseDelay = defaultRetryBaseDelay
	}
	sleepFn := b.sleep
	if sleepFn == nil {
		sleepFn = sleepContext
	}

	go func() {
		defer close(outerCh)

		var lastFail *StreamEvent
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			if ctx.Err() != nil {
				return
			}

			innerCh, err := b.inner.ExecuteStream(ctx, req)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				if !isRetriableStartError(err) || attempt >= maxAttempts {
					forwardEvent(outerCh, StreamEvent{
						Type:   "error",
						Error:  err.Error(),
						Reason: ReasonRequestFailed,
					})
					forwardEvent(outerCh, StreamEvent{Type: "done"})
					return
				}
				lastFail = &StreamEvent{
					Type:    "error",
					Error:   err.Error(),
					Reason:  ReasonRequestFailed,
					Content: err.Error(),
				}
				emitRetryAndWait(ctx, outerCh, attempt, maxAttempts, lastFail, baseDelay, sleepFn, req.SessionID)
				continue
			}

			outcome := proxyAttempt(ctx, innerCh, outerCh)
			if outcome.cancelled {
				return
			}
			if outcome.hasContent || outcome.pendingFail == nil || !isRetriableFailureEvent(*outcome.pendingFail) || attempt >= maxAttempts {
				if outcome.pendingFail != nil {
					forwardEvent(outerCh, *outcome.pendingFail)
				}
				if outcome.gotDone || outcome.pendingFail != nil {
					forwardEvent(outerCh, StreamEvent{Type: "done"})
				}
				return
			}

			lastFail = outcome.pendingFail
			emitRetryAndWait(ctx, outerCh, attempt, maxAttempts, lastFail, baseDelay, sleepFn, req.SessionID)
		}
	}()

	return outerCh, nil
}

type attemptOutcome struct {
	hasContent  bool
	gotDone     bool
	cancelled   bool
	pendingFail *StreamEvent
}

// proxyAttempt forwards non-terminal events immediately. Terminal retriable
// failures are held back so the caller can decide whether to retry without
// flashing an error card first.
func proxyAttempt(ctx context.Context, innerCh <-chan StreamEvent, outerCh chan<- StreamEvent) attemptOutcome {
	var out attemptOutcome
	for {
		select {
		case <-ctx.Done():
			out.cancelled = true
			return out
		case event, ok := <-innerCh:
			if !ok {
				return out
			}
			switch event.Type {
			case "content", "thinking", "tool_use", "tool_result":
				out.hasContent = true
				// Once real work started, flush any held failure (shouldn't happen)
				// and stop treating later failures as auto-retriable for this attempt.
				if out.pendingFail != nil {
					forwardEvent(outerCh, *out.pendingFail)
					out.pendingFail = nil
				}
				forwardEvent(outerCh, event)
			case "error", "warning":
				if !out.hasContent && isRetriableFailureEvent(event) {
					// Hold the latest retriable failure; keep streaming non-fail noise.
					cp := event
					out.pendingFail = &cp
					continue
				}
				forwardEvent(outerCh, event)
			case "done":
				out.gotDone = true
				return out
			default:
				forwardEvent(outerCh, event)
			}
		}
	}
}

func emitRetryAndWait(
	ctx context.Context,
	outerCh chan<- StreamEvent,
	failedAttempt, maxAttempts int,
	fail *StreamEvent,
	baseDelay time.Duration,
	sleepFn func(context.Context, time.Duration) error,
	sessionID string,
) {
	nextAttempt := failedAttempt + 1
	detail := failureDetail(*fail)
	slog.Warn("ai request failed, auto-retrying",
		"session_id", sessionID,
		"failed_attempt", failedAttempt,
		"next_attempt", nextAttempt,
		"max_attempts", maxAttempts,
		"reason", fail.Reason,
		"detail", detail,
	)
	forwardEvent(outerCh, StreamEvent{
		Type:        "retry",
		Content:     detail,
		Reason:      ReasonRetrying,
		Attempt:     nextAttempt,
		MaxAttempts: maxAttempts,
	})
	delay := baseDelay * time.Duration(1<<uint(failedAttempt-1)) // 1s, 2s, 4s...
	if err := sleepFn(ctx, delay); err != nil {
		return
	}
}

func failureDetail(event StreamEvent) string {
	if event.Error != "" {
		return event.Error
	}
	return event.Content
}

// isRetriableFailureEvent reports whether a terminal error/warning is worth
// auto-retrying (transient request failures / backend crashes). Permanent
// auth failures are excluded.
func isRetriableFailureEvent(event StreamEvent) bool {
	if event.Type != "error" && event.Type != "warning" {
		return false
	}
	detail := failureDetail(event)
	if isNonRetriableErrorText(detail) {
		return false
	}
	switch event.Reason {
	case ReasonRequestFailed, ReasonBackendExit, ReasonEmpty, ReasonPanic, ReasonTimeout, ReasonParseError:
		return true
	case "":
		// Bare error events (no reason) — treat as retriable unless auth-like.
		return event.Type == "error"
	default:
		return false
	}
}

func isRetriableStartError(err error) bool {
	if err == nil {
		return false
	}
	return !isNonRetriableErrorText(err.Error())
}

func isNonRetriableErrorText(s string) bool {
	if s == "" {
		return false
	}
	lower := strings.ToLower(s)
	// Permanent credential / permission failures — retrying won't help.
	needles := []string{
		"unauthorized",
		"invalid api key",
		"invalid or expired credentials",
		"authentication failed",
		"auth required",
		"not authenticated",
		"permission denied",
		"forbidden",
		"account suspended",
		"billing",
		"payment required",
		// Schema / protocol bugs are deterministic — auto-retry just wastes time.
		"serialization error",
		"missing field",
		"unknown field",
		"method not found",
	}
	for _, n := range needles {
		if strings.Contains(lower, n) {
			return true
		}
	}
	return false
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}


// SetRequestRetrySleepForTest overrides the retry backoff sleep used by
// WithRequestRetry. Returns a restore function.
func SetRequestRetrySleepForTest(fn func(context.Context, time.Duration) error) func() {
	prev := defaultRequestRetrySleep
	if fn == nil {
		defaultRequestRetrySleep = sleepContext
	} else {
		defaultRequestRetrySleep = fn
	}
	return func() { defaultRequestRetrySleep = prev }
}
