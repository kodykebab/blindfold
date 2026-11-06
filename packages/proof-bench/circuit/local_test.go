package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPinnedLocalParametersRejectReplacement(t *testing.T) {
	dir := t.TempDir()
	manifest := localManifest{Version: 1, DevelopmentOnly: true, Files: map[string]string{}}
	for _, suffix := range []string{"r1cs", "pk", "vk", "sol"} {
		name := "online." + suffix
		if e := os.WriteFile(filepath.Join(dir, name), []byte(name), 0600); e != nil {
			t.Fatal(e)
		}
		manifest.Files[name] = fileDigest(filepath.Join(dir, name))
	}
	data, e := json.Marshal(manifest)
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, "manifest.json")
	if e = os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
	pin := fileDigest(path)
	loadLocalManifest(dir, pin, "online")
	rejects := func(fn func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Error("changed parameters accepted")
			}
		}()
		fn()
	}
	rejects(func() { loadLocalManifest(dir, "", "online") })
	if e = os.WriteFile(filepath.Join(dir, "online.pk"), []byte("replacement"), 0600); e != nil {
		t.Fatal(e)
	}
	rejects(func() { loadLocalManifest(dir, pin, "online") })
	if e = os.WriteFile(path, append(data, ' '), 0600); e != nil {
		t.Fatal(e)
	}
	rejects(func() { loadLocalManifest(dir, pin, "online") })
}
