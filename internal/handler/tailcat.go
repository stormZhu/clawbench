package handler

import (
	"context"
	"net/http"
)

// tailcatStateDisabled is the transport state reported when no Tailcat
// manager is wired up. JSON keys are reused from frp_info.go's shared key
// constants (frpKeyState / frpKeyRunning), matching tts_audio_ws.go.
const tailcatStateDisabled = "disabled"

func ServeTailcatStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeLocalizedErrorf(w, r, http.StatusMethodNotAllowed, "MethodNotAllowed")
		return
	}
	if tailcatManager == nil {
		writeJSON(w, http.StatusOK, map[string]any{frpKeyState: tailcatStateDisabled, frpKeyRunning: false})
		return
	}
	writeJSON(w, http.StatusOK, tailcatManager.Status())
}

func ServeTailcatStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeLocalizedErrorf(w, r, http.StatusMethodNotAllowed, "MethodNotAllowed")
		return
	}
	if tailcatManager == nil {
		writeLocalizedErrorf(w, r, http.StatusNotImplemented, "InternalError")
		return
	}
	if err := tailcatManager.StartExisting(context.Background()); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{strReqError: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, tailcatManager.Status())
}

func ServeTailcatStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeLocalizedErrorf(w, r, http.StatusMethodNotAllowed, "MethodNotAllowed")
		return
	}
	if tailcatManager != nil {
		if err := tailcatManager.Stop(context.Background()); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{strReqError: err.Error()})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
