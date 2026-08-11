package ai

import (
	"testing"

	acp "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestACPConnEmitPromptResponseUsageWithoutCachedState(t *testing.T) {
	conn := newACPConn(nil, "prompt-usage-no-cache")
	streamCh := make(chan StreamEvent, 2)
	usage := &acp.Usage{
		InputTokens:  100,
		OutputTokens: 20,
		TotalTokens:  120,
	}

	require.NotPanics(t, func() {
		conn.emitPromptResponseUsage(usage, streamCh)
	})

	metadataEvent := <-streamCh
	assert.Equal(t, "metadata", metadataEvent.Type)
	require.NotNil(t, metadataEvent.Meta)
	assert.Equal(t, 100, metadataEvent.Meta.InputTokens)
	assert.Equal(t, 20, metadataEvent.Meta.OutputTokens)

	usageEvent := <-streamCh
	assert.Equal(t, "usage_update", usageEvent.Type)
	require.NotNil(t, usageEvent.Usage)
	assert.Equal(t, 0, usageEvent.Usage.Used)
	assert.Equal(t, 0, usageEvent.Usage.Size)
	assert.Equal(t, 100, usageEvent.Usage.InputTokens)
	assert.Equal(t, 20, usageEvent.Usage.OutputTokens)
	assert.Equal(t, 120, usageEvent.Usage.TotalTokens)

	assert.Equal(t, usageEvent.Usage, conn.GetCachedUsageState())
}

func TestACPConnEmitPromptResponseUsagePreservesCachedContext(t *testing.T) {
	conn := newACPConn(nil, "prompt-usage-with-cache")
	conn.SetCachedUsageState(&UsageState{
		Used:     500,
		Size:     2000,
		Cost:     0.25,
		Currency: "USD",
	})
	streamCh := make(chan StreamEvent, 2)
	cachedRead := 40
	cachedWrite := 10
	thought := 5

	conn.emitPromptResponseUsage(&acp.Usage{
		InputTokens:       100,
		OutputTokens:      20,
		TotalTokens:       175,
		CachedReadTokens:  &cachedRead,
		CachedWriteTokens: &cachedWrite,
		ThoughtTokens:     &thought,
	}, streamCh)

	<-streamCh
	usageEvent := <-streamCh
	require.NotNil(t, usageEvent.Usage)
	assert.Equal(t, 500, usageEvent.Usage.Used)
	assert.Equal(t, 2000, usageEvent.Usage.Size)
	assert.Equal(t, 0.25, usageEvent.Usage.Cost)
	assert.Equal(t, "USD", usageEvent.Usage.Currency)
	assert.Equal(t, 40, usageEvent.Usage.CachedReadTokens)
	assert.Equal(t, 10, usageEvent.Usage.CachedWriteTokens)
	assert.Equal(t, 5, usageEvent.Usage.ThoughtTokens)
}
