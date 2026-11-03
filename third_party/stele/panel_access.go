package main

import "net/http"

func localPanelHandler(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !writeGuard(r) {
			writeJSONError(w, "local same-origin access required", http.StatusForbidden)
			return
		}
		handler(w, r)
	}
}
