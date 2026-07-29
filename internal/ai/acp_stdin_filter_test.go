package ai

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEnsureContentBlockAnnotations_AddsMissing(t *testing.T) {
	in := []byte(`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"hi"}]}}` + "\n")
	out := ensureContentBlockAnnotations(in)
	var msg map[string]any
	require.NoError(t, json.Unmarshal(bytes.TrimSpace(out), &msg))
	params := msg["params"].(map[string]any)
	prompt := params["prompt"].([]any)
	block := prompt[0].(map[string]any)
	assert.Equal(t, "hi", block["text"])
	_, ok := block["annotations"]
	assert.True(t, ok, "annotations should be injected")
	assert.True(t, bytes.HasSuffix(out, []byte("\n")))
}

func TestEnsureContentBlockAnnotations_PreservesExisting(t *testing.T) {
	in := []byte(`{"jsonrpc":"2.0","method":"session/prompt","params":{"prompt":[{"type":"text","text":"hi","annotations":{"priority":1}}]}}`)
	out := ensureContentBlockAnnotations(in)
	var msg map[string]any
	require.NoError(t, json.Unmarshal(out, &msg))
	block := msg["params"].(map[string]any)["prompt"].([]any)[0].(map[string]any)
	ann := block["annotations"].(map[string]any)
	assert.EqualValues(t, 1, ann["priority"])
}

func TestEnsureContentBlockAnnotations_NonJSONPassthrough(t *testing.T) {
	in := []byte("not-json\n")
	out := ensureContentBlockAnnotations(in)
	assert.Equal(t, in, out)
}

func TestACPStdinFilter_WriteLineBuffered(t *testing.T) {
	var buf bytes.Buffer
	// fake closer
	w := &writeCloser{Writer: &buf}
	f := newACPStdinFilter(w)

	part1 := []byte(`{"jsonrpc":"2.0","method":"session/prompt","params":{"prompt":[{"type":"text","text":"ab`)
	part2 := []byte(`c"}]}}` + "\n")
	n, err := f.Write(part1)
	require.NoError(t, err)
	assert.Equal(t, len(part1), n)
	assert.Equal(t, 0, buf.Len(), "should buffer until newline")

	n, err = f.Write(part2)
	require.NoError(t, err)
	assert.Equal(t, len(part2), n)

	var msg map[string]any
	require.NoError(t, json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &msg))
	block := msg["params"].(map[string]any)["prompt"].([]any)[0].(map[string]any)
	assert.Equal(t, "abc", block["text"])
	_, ok := block["annotations"]
	assert.True(t, ok)
}

type writeCloser struct {
	io.Writer
}

func (w *writeCloser) Close() error { return nil }
