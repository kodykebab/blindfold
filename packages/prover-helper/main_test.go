package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const testID = "eaoidifkamkmkbcomcbpldjlhipogdgo"

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	msg := map[string]any{"id": "1", "cmd": "hello", "note": "ünïcode"}
	if err := writeFrame(&buf, msg); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	if int(binary.LittleEndian.Uint32(raw[:4])) != len(raw)-4 {
		t.Fatal("length prefix is not 4-byte little-endian")
	}
	body, err := readFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if json.Unmarshal(body, &got) != nil || got["note"] != "ünïcode" || got["cmd"] != "hello" {
		t.Fatalf("round trip changed the message: %s", body)
	}
	if _, err := readFrame(&buf); err != io.EOF {
		t.Fatalf("clean end of stream should be io.EOF, got %v", err)
	}
	if _, err := readFrame(bytes.NewReader([]byte{5, 0, 0, 0, '{'})); err != io.ErrUnexpectedEOF {
		t.Fatalf("truncated frame accepted: %v", err)
	}
}

func TestOversizedFramesRefused(t *testing.T) {
	header := binary.LittleEndian.AppendUint32(nil, maxMessage+1)
	if _, err := readFrame(bytes.NewReader(header)); err != errTooLarge {
		t.Fatalf("oversized request accepted: %v", err)
	}
	if err := writeFrame(io.Discard, strings.Repeat("x", maxMessage)); err != errTooLarge {
		t.Fatalf("oversized response written: %v", err)
	}
	var buf bytes.Buffer
	if err := respond(&buf, "7", strings.Repeat("x", maxMessage), nil); err != nil {
		t.Fatal(err)
	}
	if r := decode(t, &buf); r.ID != "7" || r.OK || r.Error.Code != "E_TOO_LARGE" {
		t.Fatalf("oversized result not replaced by E_TOO_LARGE: %+v", r)
	}
	// End to end: the host answers an oversized request with E_TOO_LARGE and exits.
	h := start(t, fakeSetup(t), "chrome-extension://"+testID+"/", nil)
	h.stdin.Write(header)
	if r := h.recv(); r.OK || r.Error.Code != "E_TOO_LARGE" {
		t.Fatalf("got %+v", r)
	}
	if code := h.wait(); code != 1 {
		t.Fatalf("exit %d", code)
	}
}

// S2: only the configured extension origin may use the helper.
func TestWrongOriginRefused(t *testing.T) {
	s := fakeSetup(t)
	for _, origin := range []string{"", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/", "chrome-extension://" + testID, "https://evil.example/"} {
		var args []string
		if origin != "" {
			args = []string{origin}
		}
		h := startArgs(t, s, args, nil)
		if r := h.recv(); r.OK || r.Error.Code != "E_ORIGIN" {
			t.Fatalf("origin %q: got %+v", origin, r)
		}
		if code := h.wait(); code != 1 {
			t.Fatalf("origin %q: exit %d", origin, code)
		}
	}
}

// I3/S3: protocol and parameter pins are enforced; the happy path returns hex fields and a one-shot session.
func TestVersionParamsAndSession(t *testing.T) {
	s := fakeSetup(t)
	h := start(t, s, "chrome-extension://"+testID+"/", nil)
	defer h.close()
	hello := h.call(map[string]any{"cmd": "hello"})
	if !hello.OK || hello.Result["protocol"] != float64(protocol) || hello.Result["version"] != version ||
		hello.Result["manifestSha256"] != s.pin || hello.Result["chainId"] != "31337" || len(hello.Result["proverSha256"].(string)) != 64 {
		t.Fatalf("hello: %+v", hello)
	}
	good := map[string]any{"cmd": "prepare", "protocol": protocol, "manifestSha256": s.pin, "request": map[string]any{"chainId": "31337"}}
	with := func(k string, v any) map[string]any {
		m := map[string]any{}
		for a, b := range good {
			m[a] = b
		}
		m[k] = v
		return m
	}
	for _, c := range []struct {
		req  map[string]any
		code string
	}{
		{with("protocol", 2), "E_VERSION"},
		{with("protocol", nil), "E_VERSION"},
		{with("manifestSha256", strings.Repeat("0", 64)), "E_PARAMS"},
		{with("request", map[string]any{"chainId": "1"}), "E_CHAIN"},
		{map[string]any{"cmd": "online", "protocol": protocol, "session": "nope"}, "E_SESSION"},
		{map[string]any{"cmd": "selfdestruct"}, "E_BAD_REQUEST"},
	} {
		if r := h.call(c.req); r.OK || r.Error.Code != c.code {
			t.Fatalf("%v: want %s, got %+v", c.req, c.code, r)
		}
	}
	h.stdin.Write(binary.LittleEndian.AppendUint32(nil, 3))
	h.stdin.Write([]byte("{x}"))
	if r := h.recv(); r.OK || r.Error.Code != "E_BAD_REQUEST" {
		t.Fatalf("garbage: %+v", r)
	}

	prep := h.call(good)
	if !prep.OK {
		t.Fatalf("prepare: %+v", prep)
	}
	for _, k := range []string{"orderHash", "oldRoot", "newRoot", "ciphertextHash", "newBlind"} {
		if v, _ := prep.Result[k].(string); len(v) != 66 || !strings.HasPrefix(v, "0x") {
			t.Fatalf("%s = %v", k, prep.Result[k])
		}
	}
	if p := prep.Result["preparation"].(map[string]any); p["seal"] != "0x01" || p["journal"] != "0x02" {
		t.Fatalf("preparation: %v", p)
	}
	session := prep.Result["session"]
	if r := h.call(map[string]any{"cmd": "online", "protocol": protocol, "session": session}); !r.OK {
		t.Fatalf("online: %+v", r)
	}
	if r := h.call(map[string]any{"cmd": "online", "protocol": protocol, "session": session}); r.OK || r.Error.Code != "E_SESSION" {
		t.Fatalf("session reused: %+v", r)
	}
	if left := witnesses(t, h.tmp); len(left) != 0 {
		t.Fatalf("witness files left after proving: %v", left)
	}

	// Parameters swapped after install: refused before anything runs.
	os.WriteFile(filepath.Join(s.params, "manifest.json"), []byte(`{"version":1,"swapped":true}`), 0600)
	if r := h.call(map[string]any{"cmd": "hello"}); r.OK || r.Error.Code != "E_PARAMS" {
		t.Fatalf("hello with swapped params: %+v", r)
	}
	if r := h.call(good); r.OK || r.Error.Code != "E_PARAMS" {
		t.Fatalf("prepare with swapped params: %+v", r)
	}
}

// F3: a helper stopped mid-proof leaves no witness files, whether Chrome disconnects, terminates or kills it.
func TestKilledMidProofLeavesNoWitness(t *testing.T) {
	s := fakeSetup(t)
	for _, how := range []string{"disconnect", "SIGTERM", "SIGKILL"} {
		t.Run(how, func(t *testing.T) {
			sleep := "30"
			if how == "SIGKILL" {
				sleep = "2" // the orphaned prover finishes on its own; its guard then deletes the witness
			}
			h := start(t, s, "chrome-extension://"+testID+"/", []string{"FAKE_PROVE_SLEEP=" + sleep})
			h.send(map[string]any{"id": "p", "cmd": "prepare", "protocol": protocol, "manifestSha256": s.pin, "request": map[string]any{"chainId": "31337"}})
			var dir string
			waitFor(t, 10*time.Second, func() bool {
				w := witnesses(t, h.tmp)
				if len(w) == 1 {
					dir = w[0]
				}
				return dir != ""
			})
			waitFor(t, 5*time.Second, func() bool { _, err := os.Stat(filepath.Join(dir, "fixture.json")); return err == nil })
			for path, mode := range map[string]os.FileMode{dir: 0700, filepath.Join(dir, "fixture.json"): 0600} {
				if st, err := os.Stat(path); err != nil || st.Mode().Perm() != mode {
					t.Fatalf("%s: mode %v (%v)", path, st.Mode().Perm(), err)
				}
			}
			switch how {
			case "disconnect":
				h.stdin.Close()
			case "SIGTERM":
				h.cmd.Process.Signal(syscall.SIGTERM)
			case "SIGKILL":
				h.cmd.Process.Kill()
			}
			h.wait()
			waitFor(t, 10*time.Second, func() bool { return len(witnesses(t, h.tmp)) == 0 })
		})
	}
}

// install.sh registers the host for installed browsers and extra profiles, and the installed host answers hello.
func TestInstallScript(t *testing.T) {
	s := fakeSetup(t)
	home, profile, bin := t.TempDir(), t.TempDir(), filepath.Join(t.TempDir(), "bin")
	chrome := filepath.Join(home, ".config", "google-chrome")
	edge := filepath.Join(home, ".config", "microsoft-edge")
	if runtime.GOOS == "darwin" {
		chrome = filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
		edge = filepath.Join(home, "Library", "Application Support", "Microsoft Edge")
	}
	os.MkdirAll(chrome, 0700)
	script := func(args ...string) {
		t.Helper()
		cmd := exec.Command("bash", args...)
		cmd.Env = append(os.Environ(), "HOME="+home, "XDG_CONFIG_HOME=", "INSTALL_DIR="+bin,
			"ADMISSION_PROVER="+filepath.Join(filepath.Dir(s.params), "local-prover"), "ADMISSION_PARAMS="+s.params)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	script("install.sh", testID, profile)
	for _, dir := range []string{chrome, profile} {
		var m struct {
			Name, Path, Type string
			AllowedOrigins   []string `json:"allowed_origins"`
		}
		data, err := os.ReadFile(filepath.Join(dir, "NativeMessagingHosts", "xyz.blindfold.prover.json"))
		if err != nil || json.Unmarshal(data, &m) != nil || m.Name != "xyz.blindfold.prover" || m.Type != "stdio" ||
			m.Path != filepath.Join(bin, "blindfold-prover-helper") || len(m.AllowedOrigins) != 1 || m.AllowedOrigins[0] != "chrome-extension://"+testID+"/" {
			t.Fatalf("%s: %v %s", dir, err, data)
		}
	}
	if _, err := os.Stat(edge); !os.IsNotExist(err) {
		t.Fatal("registered for a browser that is not installed")
	}
	if st, err := os.Stat(filepath.Join(bin, "config.json")); err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("config.json: %v %v", st, err)
	}
	h := startArgs(t, setup{dir: bin}, []string{"chrome-extension://" + testID + "/"}, nil)
	if r := h.call(map[string]any{"cmd": "hello"}); !r.OK || r.Result["manifestSha256"] != s.pin {
		t.Fatalf("installed host hello: %+v", r)
	}
	h.close()
	script("uninstall.sh", profile)
	for _, p := range []string{filepath.Join(chrome, "NativeMessagingHosts", "xyz.blindfold.prover.json"), filepath.Join(profile, "NativeMessagingHosts", "xyz.blindfold.prover.json"), bin} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s survived uninstall", p)
		}
	}
}

// ---- harness ----

type setup struct{ dir, params, pin string }

type response struct {
	ID     any            `json:"id"`
	OK     bool           `json:"ok"`
	Result map[string]any `json:"result"`
	Error  failure        `json:"error"`
}

var buildOnce sync.Once
var builtBinary string

func helperBinary(t *testing.T) string {
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "prover-helper-build-")
		if err != nil {
			t.Fatal(err)
		}
		builtBinary = filepath.Join(dir, "blindfold-prover-helper")
		if out, err := exec.Command("go", "build", "-o", builtBinary, ".").CombinedOutput(); err != nil {
			t.Fatalf("build: %v\n%s", err, out)
		}
	})
	return builtBinary
}

// install copies the helper next to a config.json, the layout install.sh creates.
func install(t *testing.T, prover, params, pin string) setup {
	dir := t.TempDir()
	exe, err := os.ReadFile(helperBinary(t))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "blindfold-prover-helper"), exe, 0700); err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(config{ExtensionID: testID, Prover: prover, Params: params, ManifestSha256: pin})
	if err = os.WriteFile(filepath.Join(dir, "config.json"), cfg, 0600); err != nil {
		t.Fatal(err)
	}
	return setup{dir, params, pin}
}

// fakeSetup uses a stand-in local-prover that answers instantly (or sleeps on FAKE_PROVE_SLEEP).
func fakeSetup(t *testing.T) setup {
	dir := t.TempDir()
	params := filepath.Join(dir, "params")
	os.Mkdir(params, 0700)
	os.WriteFile(filepath.Join(params, "manifest.json"), []byte(`{"version":1,"developmentOnly":true,"files":{}}`), 0600)
	pin, _ := fileSHA256(filepath.Join(params, "manifest.json"))
	b32 := "[" + strings.TrimSuffix(strings.Repeat("7,", 32), ",") + "]"
	ct := "[" + strings.TrimSuffix(strings.Repeat("1,", 200), ",") + "]"
	fixture := `[{},{},{"admission":{"order_hash":` + b32 + `,"old_root":` + b32 + `,"new_root":` + b32 + `,"ciphertext_hash":` + b32 + `}},{"order":{"ciphertext":` + ct + `,"new_blind":` + b32 + `}}]`
	os.WriteFile(filepath.Join(dir, "fixture.json"), []byte(fixture), 0600)
	prover := filepath.Join(dir, "local-prover")
	script := "#!/bin/sh\ncase \"$1\" in\nfixture-local) cat >/dev/null; cat '" + filepath.Join(dir, "fixture.json") + "' ;;\n" +
		"prove-local) [ -n \"$FAKE_PROVE_SLEEP\" ] && sleep \"$FAKE_PROVE_SLEEP\"; echo '{\"seal\":\"0x01\",\"journal\":\"0x02\"}' ;;\n*) exit 2 ;;\nesac\n"
	os.WriteFile(prover, []byte(script), 0700)
	return install(t, prover, params, pin)
}

type running struct {
	t     *testing.T
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   io.Reader
	tmp   string
	n     int
}

func start(t *testing.T, s setup, origin string, env []string) *running {
	return startArgs(t, s, []string{origin}, env)
}

func startArgs(t *testing.T, s setup, args []string, env []string) *running {
	tmp := t.TempDir()
	cmd := exec.Command(filepath.Join(s.dir, "blindfold-prover-helper"), args...)
	cmd.Env = append(append(os.Environ(), "TMPDIR="+tmp), env...)
	stdin, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	return &running{t: t, cmd: cmd, stdin: stdin, out: out, tmp: tmp}
}

func (h *running) send(req map[string]any) {
	body, _ := json.Marshal(req)
	h.stdin.Write(append(binary.LittleEndian.AppendUint32(nil, uint32(len(body))), body...))
}

func (h *running) recv() response { return decode(h.t, h.out) }

func (h *running) call(req map[string]any) response {
	h.n++
	req["id"] = fmt.Sprint("r", h.n)
	h.send(req)
	r := h.recv()
	if r.ID != req["id"] {
		h.t.Fatalf("response id %v for request %v", r.ID, req["id"])
	}
	return r
}

func (h *running) close() { h.stdin.Close(); h.wait() }

func (h *running) wait() int {
	h.cmd.Wait()
	return h.cmd.ProcessState.ExitCode()
}

func decode(t *testing.T, r io.Reader) response {
	t.Helper()
	body, err := readFrame(r)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var resp response
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("bad response %s: %v", body, err)
	}
	return resp
}

func witnesses(t *testing.T, tmp string) []string {
	m, err := filepath.Glob(filepath.Join(tmp, "blindfold-witness-*"))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func waitFor(t *testing.T, limit time.Duration, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(limit); !ok(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
	}
}
