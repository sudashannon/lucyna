package main

import (
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"os"
)

func serveLucyna(addr string, handler http.Handler) error {
	token := os.Getenv("LUCYNA_ENGINE_TOKEN")
	guarded := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Lucyna-Engine-Token")), []byte(token)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		handler.ServeHTTP(w, r)
	})
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	fmt.Printf("LUCYNA_ENGINE_READY %s\n", listener.Addr().String())
	return http.Serve(listener, guarded)
}
