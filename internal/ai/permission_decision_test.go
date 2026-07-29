package ai

import (
	"testing"

	acp "github.com/coder/acp-go-sdk"
	"github.com/stretchr/testify/assert"
)

func TestFormatPermissionDecisionOutput(t *testing.T) {
	assert.Equal(t,
		"approved|allow_once|allow_once|Allow Once",
		FormatPermissionDecisionOutput("approved", "allow_once", "allow_once", "Allow Once"),
	)
	assert.Equal(t,
		"approved|allow_always|accept_execpolicy_amendment|Allow Commands Starting With `./build.sh`",
		FormatPermissionDecisionOutput("approved", "allow_always", "accept_execpolicy_amendment", "Allow Commands Starting With `./build.sh`"),
	)
	assert.Equal(t, "cancelled|reject_once||", FormatPermissionDecisionOutput("cancelled", "reject_once", "", ""))
	assert.Equal(t, "auto_approved|||", FormatPermissionDecisionOutput("auto_approved", "", "", ""))
}

func TestLookupPermissionOption(t *testing.T) {
	opts := []acp.PermissionOption{
		{OptionId: "allow_once", Name: "Allow Once", Kind: acp.PermissionOptionKindAllowOnce},
		{OptionId: "allow_always", Name: "Allow for Session", Kind: acp.PermissionOptionKindAllowAlways},
		{OptionId: "accept_execpolicy_amendment", Name: "Allow Commands Starting With `./build.sh`", Kind: acp.PermissionOptionKindAllowAlways},
	}
	kind, name := lookupPermissionOption(opts, "accept_execpolicy_amendment")
	assert.Equal(t, "allow_always", kind)
	assert.Equal(t, "Allow Commands Starting With `./build.sh`", name)

	kind, name = lookupPermissionOption(opts, "missing")
	assert.Equal(t, "", kind)
	assert.Equal(t, "", name)
}
