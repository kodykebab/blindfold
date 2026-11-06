package main

// Local-only proving commands. Setup artifacts are immutable and explicitly development-only;
// callers pin the manifest hash alongside their deployed verifier addresses.
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	bn "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/backend/solidity"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/logger"
)

type localManifest struct {
	Version         int               `json:"version"`
	DevelopmentOnly bool              `json:"developmentOnly"`
	Files           map[string]string `json:"files"`
}

func fileDigest(path string) string {
	f, e := os.Open(path)
	must(e)
	defer f.Close()
	h := sha256.New()
	_, e = io.Copy(h, f)
	must(e)
	return hex.EncodeToString(h.Sum(nil))
}
func writeObject(path string, value io.WriterTo) {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	must(e)
	_, e = value.WriteTo(f)
	must(e)
	must(f.Close())
}
func readObject(path string, value io.ReaderFrom) {
	f, e := os.Open(path)
	must(e)
	defer f.Close()
	_, e = value.ReadFrom(f)
	must(e)
	var b [1]byte
	n, e := f.Read(b[:])
	if n != 0 || e != io.EOF {
		panic("trailing parameter bytes")
	}
}
func setupLocal(dir string) {
	// Never replace keys under an already deployed verifier or reuse a partial setup.
	must(os.Mkdir(dir, 0700))
	m := localManifest{Version: 1, DevelopmentOnly: true, Files: map[string]string{}}
	for _, mode := range []string{"preparation", "online"} {
		fmt.Fprintln(os.Stderr, "compiling and creating local development setup:", mode)
		var shape frontend.Circuit = &PreparationCircuit{}
		if mode == "online" {
			shape = &OnlineCircuit{}
		}
		cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, shape)
		must(e)
		pk, vk, e := groth16.Setup(cs)
		must(e)
		for suffix, obj := range map[string]io.WriterTo{"r1cs": cs, "pk": pk, "vk": vk} {
			name := mode + "." + suffix
			writeObject(filepath.Join(dir, name), obj)
			m.Files[name] = fileDigest(filepath.Join(dir, name))
		}
		name := mode + ".sol"
		f, e := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		must(e)
		must(vk.ExportSolidity(f))
		must(f.Close())
		m.Files[name] = fileDigest(filepath.Join(dir, name))
	}
	data, e := json.MarshalIndent(m, "", "  ")
	must(e)
	must(os.WriteFile(filepath.Join(dir, "manifest.json"), append(data, '\n'), 0600))
	fmt.Println(fileDigest(filepath.Join(dir, "manifest.json")))
}
func loadLocalManifest(dir, pin, mode string) {
	if len(pin) != 64 || fileDigest(filepath.Join(dir, "manifest.json")) != pin {
		panic("parameter manifest does not match pinned SHA-256")
	}
	data, e := os.ReadFile(filepath.Join(dir, "manifest.json"))
	must(e)
	var m localManifest
	must(json.Unmarshal(data, &m))
	if m.Version != 1 || !m.DevelopmentOnly {
		panic("unsupported local parameter manifest")
	}
	for _, suffix := range []string{"r1cs", "pk", "vk", "sol"} {
		name := mode + "." + suffix
		if m.Files[name] == "" || fileDigest(filepath.Join(dir, name)) != m.Files[name] {
			panic("parameter integrity failure: " + name)
		}
	}
}
func proveLocal(dir, pin, mode string, assignment frontend.Circuit) map[string]any {
	start := time.Now()
	loadLocalManifest(dir, pin, mode)
	cs := groth16.NewCS(ecc.BN254)
	readObject(filepath.Join(dir, mode+".r1cs"), cs)
	pk := groth16.NewProvingKey(ecc.BN254)
	readObject(filepath.Join(dir, mode+".pk"), pk)
	vk := groth16.NewVerifyingKey(ecc.BN254)
	readObject(filepath.Join(dir, mode+".vk"), vk)

	loadSeconds := time.Since(start).Seconds()
	start = time.Now()
	w, e := frontend.NewWitness(assignment, ecc.BN254.ScalarField())
	must(e)
	p, e := groth16.Prove(cs, pk, w, solidity.WithProverTargetSolidityVerifier(backend.GROTH16))
	must(e)
	proveSeconds := time.Since(start).Seconds()
	start = time.Now()
	public, e := w.Public()
	must(e)
	must(groth16.Verify(p, vk, public, solidity.WithVerifierTargetSolidityVerifier(backend.GROTH16)))
	var journal []byte
	switch c := assignment.(type) {
	case *PreparationCircuit:
		journal = preparationStatement(*c)
	case *OnlineCircuit:
		journal = onlineStatement(*c)
	}
	var usage syscall.Rusage
	must(syscall.Getrusage(syscall.RUSAGE_SELF, &usage))
	rss := usage.Maxrss
	if runtime.GOOS != "darwin" {
		rss *= 1024
	}
	return map[string]any{"peakRssBytes": rss, "goVersion": runtime.Version(), "timings": map[string]float64{"load_s": loadSeconds, "prove_s": proveSeconds, "verify_s": time.Since(start).Seconds()}, "seal": "0x" + hex.EncodeToString(p.(*bn.Proof).MarshalSolidity()), "journal": "0x" + hex.EncodeToString(journal)}
}
func localCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "fixture-local", "prepare-fixture-local":
		if len(args) != 1 {
			panic("usage: fixture-local < request.json")
		}
		fixtureCommand(args[0] == "prepare-fixture-local")
		return true
	case "setup-local":
		if len(args) != 2 {
			panic("usage: setup-local new-directory")
		}
		logger.Disable()
		setupLocal(args[1])
		return true
	case "prove-local":
		if len(args) != 5 {
			panic("usage: prove-local directory manifest-sha256 preparation|online fixture.json")
		}
		logger.Disable()
		var assignment frontend.Circuit
		switch args[3] {
		case "preparation":
			c := preparationFixture(args[4])
			assignment = &c
		case "online":
			c := onlineFixture(args[4])
			assignment = &c
		default:
			panic("invalid circuit mode")
		}
		must(json.NewEncoder(os.Stdout).Encode(proveLocal(args[1], args[2], args[3], assignment)))
		return true
	}
	return false
}
