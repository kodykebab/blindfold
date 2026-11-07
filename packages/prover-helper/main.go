// Command blindfold-prover-helper is the Chrome native messaging host xyz.blindfold.prover. It makes the Groth16
// admission proofs on this machine by running local-prover, so the plaintext order never leaves the machine.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	protocol       = 1
	version        = "0.1.0"
	maxMessage     = 1024 * 1024 // Chrome's limit for host-to-browser messages; requests are capped the same
	devChain       = "31337"     // setup-local parameters are development-only (D2, D5)
	fixtureTimeout = time.Minute
	proveTimeout   = 10 * time.Minute
)

// guard deletes the witness directory when local-prover exits, even if the helper itself was killed first.
const guard = `d=$1; shift; trap 'rm -rf "$d"' EXIT; trap 'exit 1' HUP INT TERM; "$@"`

var (
	errTooLarge = errors.New("message exceeds 1 MB")
	extensionID = regexp.MustCompile(`^[a-p]{32}$`)
	sha256Hex   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// config is written next to the binary by install.sh.
type config struct {
	ExtensionID    string `json:"extensionId"`
	Prover         string `json:"prover"`
	Params         string `json:"params"`
	ManifestSha256 string `json:"manifestSha256"`
}

type request struct {
	ID             string          `json:"id"`
	Cmd            string          `json:"cmd"`
	Protocol       int             `json:"protocol"`
	ManifestSha256 string          `json:"manifestSha256"`
	Session        string          `json:"session"`
	Request        json.RawMessage `json:"request"`
}

type failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (f *failure) Error() string        { return f.Code + ": " + f.Message }
func fail(code, message string) *failure { return &failure{code, message} }

type proof struct {
	Seal    string `json:"seal"`
	Journal string `json:"journal"`
}

type host struct {
	cfg     config
	session string
	fixture []byte // private witness of the pending preparation; memory only, consumed by online
}

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout)) }

func run(args []string, in io.Reader, out io.Writer) int {
	cfg, err := loadConfig()
	if err != nil {
		respond(out, nil, nil, err)
		return 1
	}
	// Chrome passes the caller's origin first. allowed_origins already filters callers; this is defense in depth.
	if len(args) == 0 || args[0] != "chrome-extension://"+cfg.ExtensionID+"/" {
		respond(out, nil, nil, fail("E_ORIGIN", "caller is not the configured Blindfold extension"))
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	frames := make(chan []byte)
	var readErr error
	go func() {
		defer close(frames)
		for {
			body, err := readFrame(in)
			if err != nil {
				readErr = err
				if err != errTooLarge {
					cancel() // Chrome closed the port: stop any running proof
				}
				return
			}
			select {
			case frames <- body:
			case <-ctx.Done():
				return
			}
		}
	}()
	h := &host{cfg: cfg}
	for {
		select {
		case <-ctx.Done():
			return 0
		case body, ok := <-frames:
			if !ok {
				if readErr == errTooLarge {
					respond(out, nil, nil, fail("E_TOO_LARGE", "request exceeds 1 MB"))
					return 1
				}
				return 0
			}
			var req request
			if json.Unmarshal(body, &req) != nil {
				respond(out, nil, nil, fail("E_BAD_REQUEST", "message is not a JSON request"))
				continue
			}
			result, err := h.handle(ctx, req)
			if respond(out, req.ID, result, err) != nil {
				return 1
			}
		}
	}
}

func (h *host) handle(ctx context.Context, req request) (any, error) {
	switch req.Cmd {
	case "hello":
		return h.hello()
	case "prepare", "online":
		if req.Protocol != protocol {
			return nil, fail("E_VERSION", fmt.Sprintf("helper %s speaks protocol %d", version, protocol))
		}
		if req.Cmd == "prepare" {
			return h.prepare(ctx, req)
		}
		return h.online(ctx, req)
	}
	return nil, fail("E_BAD_REQUEST", "unknown cmd")
}

func (h *host) hello() (any, error) {
	if err := h.checkParams(); err != nil {
		return nil, err
	}
	prover, err := fileSHA256(h.cfg.Prover)
	if err != nil {
		return nil, fail("E_CONFIG", "local-prover is missing; re-run install.sh")
	}
	return map[string]any{"protocol": protocol, "version": version, "chainId": devChain, "developmentOnly": true,
		"manifestSha256": h.cfg.ManifestSha256, "proverSha256": prover}, nil
}

// prepare mirrors the client's proveAdmission: fixture-local with fresh keys, then the preparation proof.
func (h *host) prepare(ctx context.Context, req request) (any, error) {
	h.session, h.fixture = "", nil
	if req.ManifestSha256 != h.cfg.ManifestSha256 {
		return nil, fail("E_PARAMS", "requested parameter manifest is not the one this helper pins")
	}
	if err := h.checkParams(); err != nil {
		return nil, err
	}
	var chain struct {
		ChainID string `json:"chainId"`
	}
	if json.Unmarshal(req.Request, &chain) != nil || chain.ChainID != devChain {
		return nil, fail("E_CHAIN", "development parameters are restricted to local chain "+devChain)
	}
	fixture, err := h.exec(ctx, fixtureTimeout, req.Request, true, h.cfg.Prover, "fixture-local")
	if err != nil {
		return nil, err
	}
	var fx [4]json.RawMessage
	var adm struct {
		Admission struct {
			OrderHash      []byte `json:"order_hash"`
			OldRoot        []byte `json:"old_root"`
			NewRoot        []byte `json:"new_root"`
			CiphertextHash []byte `json:"ciphertext_hash"`
		} `json:"admission"`
	}
	var ord struct {
		Order struct {
			Ciphertext []byte `json:"ciphertext"`
			NewBlind   []byte `json:"new_blind"`
		} `json:"order"`
	}
	a, o := &adm.Admission, &ord.Order
	if json.Unmarshal(fixture, &fx) != nil || json.Unmarshal(fx[2], &adm) != nil || json.Unmarshal(fx[3], &ord) != nil ||
		len(a.OrderHash) != 32 || len(a.OldRoot) != 32 || len(a.NewRoot) != 32 || len(a.CiphertextHash) != 32 ||
		len(o.NewBlind) != 32 || len(o.Ciphertext) < 192 {
		return nil, fail("E_PROVER", "local-prover returned an unexpected fixture")
	}
	prep, err := h.prove(ctx, "preparation", fixture)
	if err != nil {
		return nil, err
	}
	h.session, h.fixture = randomHex(16), fixture
	x := func(b []byte) string { return "0x" + hex.EncodeToString(b) }
	return map[string]any{"session": h.session, "orderHash": x(a.OrderHash), "oldRoot": x(a.OldRoot), "newRoot": x(a.NewRoot),
		"ciphertextHash": x(a.CiphertextHash), "ciphertext": x(o.Ciphertext), "newBlind": x(o.NewBlind), "preparation": prep}, nil
}

func (h *host) online(ctx context.Context, req request) (any, error) {
	if req.Session == "" || req.Session != h.session {
		return nil, fail("E_SESSION", "no matching preparation; call prepare first")
	}
	fixture := h.fixture
	h.session, h.fixture = "", nil // one ciphertext per preparation
	p, err := h.prove(ctx, "online", fixture)
	if err != nil {
		return nil, err
	}
	return map[string]any{"online": p}, nil
}

func (h *host) checkParams() error {
	if m, err := fileSHA256(filepath.Join(h.cfg.Params, "manifest.json")); err != nil || m != h.cfg.ManifestSha256 {
		return fail("E_PARAMS", "parameter manifest is missing or differs from the pinned SHA-256; re-run install.sh")
	}
	return nil
}

// prove hands the witness to prove-local in a private file that never outlives the prover process.
func (h *host) prove(ctx context.Context, mode string, fixture []byte) (*proof, error) {
	dir, err := os.MkdirTemp("", "blindfold-witness-") // 0700
	if err != nil {
		return nil, fail("E_INTERNAL", "cannot create a private temporary directory")
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "fixture.json")
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		_, err = f.Write(fixture)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		return nil, fail("E_INTERNAL", "cannot write the private witness file")
	}
	out, err := h.exec(ctx, proveTimeout, nil, false, "/bin/sh", "-c", guard, "sh", dir,
		h.cfg.Prover, "prove-local", h.cfg.Params, h.cfg.ManifestSha256, mode, file)
	if err != nil {
		return nil, err
	}
	var p proof
	if json.Unmarshal(out, &p) != nil || !strings.HasPrefix(p.Seal, "0x") || !strings.HasPrefix(p.Journal, "0x") {
		return nil, fail("E_PROVER", "local-prover returned an unexpected proof")
	}
	return &p, nil
}

// exec runs a command in its own process group with a timeout. Child output is captured, never inherited:
// stdout carries Chrome frames. detail passes local-prover's panic line through (fixture-local only: it
// describes request validation, while prove-local errors could mention witness values).
func (h *host) exec(ctx context.Context, timeout time.Duration, stdin []byte, detail bool, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// SIGTERM the whole group so the guard's cleanup trap still runs.
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = 5 * time.Second
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return nil, fail("E_TIMEOUT", fmt.Sprintf("local-prover did not finish within %s", timeout))
	case ctx.Err() != nil:
		return nil, fail("E_CANCELLED", "helper is shutting down")
	case err != nil:
		msg := "local-prover failed"
		if detail {
			msg += panicLine(stderr.String())
		}
		return nil, fail("E_PROVER", msg)
	}
	return stdout.Bytes(), nil
}

func panicLine(stderr string) string {
	for _, line := range strings.Split(stderr, "\n") {
		if m, ok := strings.CutPrefix(line, "panic: "); ok {
			if len(m) > 200 {
				m = m[:200]
			}
			return ": " + m
		}
	}
	return ""
}

func loadConfig() (config, error) {
	var cfg config
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	var data []byte
	if err == nil {
		data, err = os.ReadFile(filepath.Join(filepath.Dir(exe), "config.json"))
	}
	if err != nil || json.Unmarshal(data, &cfg) != nil || !extensionID.MatchString(cfg.ExtensionID) ||
		!sha256Hex.MatchString(cfg.ManifestSha256) || !filepath.IsAbs(cfg.Prover) || !filepath.IsAbs(cfg.Params) {
		return cfg, fail("E_CONFIG", "helper is not configured; run packages/prover-helper/install.sh")
	}
	return cfg, nil
}

func readFrame(r io.Reader) ([]byte, error) {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(n[:])
	if size > maxMessage {
		return nil, errTooLarge
	}
	body := make([]byte, size)
	_, err := io.ReadFull(r, body)
	return body, err
}

func writeFrame(w io.Writer, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(body) > maxMessage {
		return errTooLarge
	}
	frame := binary.LittleEndian.AppendUint32(make([]byte, 0, 4+len(body)), uint32(len(body)))
	_, err = w.Write(append(frame, body...))
	return err
}

func respond(w io.Writer, id any, result any, err error) error {
	msg := map[string]any{"id": id, "ok": err == nil}
	if err != nil {
		f, ok := err.(*failure)
		if !ok {
			f = fail("E_INTERNAL", err.Error())
		}
		msg["error"] = f
	} else {
		msg["result"] = result
	}
	if e := writeFrame(w, msg); e != errTooLarge {
		return e
	}
	return writeFrame(w, map[string]any{"id": id, "ok": false, "error": fail("E_TOO_LARGE", "response exceeds 1 MB")})
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
