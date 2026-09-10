package tailcatbridge

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStartValidation(t *testing.T) {
	_, err := Start("", 20000, 0)
	require.ErrorContains(t, err, "empty")
	_, err = Start("tc-address", 0, 0)
	require.ErrorContains(t, err, "server port")
	_, err = Start("tc-address", 20000, -1)
	require.ErrorContains(t, err, "local port")
}
