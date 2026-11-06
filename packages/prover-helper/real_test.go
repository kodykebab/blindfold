package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// I4: real preparation and online proofs through the host, checked the way AdmittedSettlement.admit checks them:
// the generated Solidity verifiers on an isolated anvil, with public inputs derived from the journals.
// Opt-in like the client's admission-e2e test: needs check-admission.sh's parameters and minutes of CPU.
func TestRealProofsVerifyOnchain(t *testing.T) {
	params := os.Getenv("ADMISSION_PARAMS")
	if params == "" {
		t.Skip("set ADMISSION_PARAMS (run packages/proof-bench/check-admission.sh first)")
	}
	prover := os.Getenv("ADMISSION_PROVER")
	if prover == "" {
		prover = "../proof-bench/results/local-prover"
	}
	prover, _ = filepath.Abs(prover)
	params, _ = filepath.Abs(params)
	pin, err := fileSHA256(filepath.Join(params, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := start(t, install(t, prover, params, pin), "chrome-extension://"+testID+"/", nil)
	defer h.close()
	if r := h.call(map[string]any{"cmd": "hello"}); !r.OK || r.Result["manifestSha256"] != pin {
		t.Fatalf("hello: %+v", r)
	}
	// The request the client's proveAdmission sends to fixture-local for a first order in a batch.
	request := map[string]any{"chainId": "31337", "settlement": "0x" + strings.Repeat("11", 20), "owner": "0x" + strings.Repeat("22", 20),
		"batch": "3", "round": "1000000", "step": "0", "totals": []string{"0", "0"}, "budgets": []string{"100000000000000000000", "99000000000000000000"},
		"oldBlind": "0x" + strings.Repeat("00", 32), "zeroForOne": true, "amount": "1000000000000000000", "minimum": "1", "salt": "0x" + randomHex(32)}
	began := time.Now()
	prep := h.call(map[string]any{"cmd": "prepare", "protocol": protocol, "manifestSha256": pin, "request": request})
	prepared := time.Since(began)
	if !prep.OK {
		t.Fatalf("prepare: %+v", prep)
	}
	began = time.Now()
	online := h.call(map[string]any{"cmd": "online", "protocol": protocol, "session": prep.Result["session"]})
	if !online.OK {
		t.Fatalf("online: %+v", online)
	}
	t.Logf("prepare (fixture + preparation proof) %.1fs, online proof %.1fs", prepared.Seconds(), time.Since(began).Seconds())
	if left := witnesses(t, h.tmp); len(left) != 0 {
		t.Fatalf("witness files left: %v", left)
	}

	field := func(m map[string]any, k string) []byte {
		s, _ := m[k].(string)
		b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
		if err != nil || !strings.HasPrefix(s, "0x") {
			t.Fatalf("%s is not 0x-hex: %v", k, m[k])
		}
		return b
	}
	pp, op := prep.Result["preparation"].(map[string]any), online.Result["online"].(map[string]any)
	pSeal, pJournal, oSeal, oJournal := field(pp, "seal"), field(pp, "journal"), field(op, "seal"), field(op, "journal")
	// AdmissionProof.decode: lengths, and the preparation journal is the online statement's first eight words.
	if len(pSeal) != 384 || len(oSeal) != 384 || len(pJournal) != 256 || len(oJournal) != 480 || !bytes.Equal(oJournal[:256], pJournal) {
		t.Fatalf("encoding: seals %d/%d, journals %d/%d", len(pSeal), len(oSeal), len(pJournal), len(oJournal))
	}
	word := func(i int) []byte { return oJournal[32*i : 32*i+32] }
	for i, k := range map[int]string{9: "oldRoot", 10: "newRoot", 13: "orderHash", 14: "ciphertextHash"} {
		if !bytes.Equal(word(i), field(prep.Result, k)) {
			t.Fatalf("journal word %d differs from %s", i, k)
		}
	}
	if !bytes.Equal(word(9), make([]byte, 32)) {
		t.Fatal("first funding step must start from the zero root")
	}
	if keccak(t, field(prep.Result, "ciphertext")) != "0x"+hex.EncodeToString(word(14)) {
		t.Fatal("ciphertext hash is not keccak256(ciphertext)")
	}

	rpc := anvil(t)
	verifier := func(mode string) string {
		var art struct {
			Bytecode struct{ Object string } `json:"bytecode"`
		}
		data, err := os.ReadFile(filepath.Join(params, "out", mode+".sol", "Verifier.json"))
		if err != nil || json.Unmarshal(data, &art) != nil {
			t.Fatalf("%s verifier artifact (forge build --root %s): %v", mode, params, err)
		}
		var receipt struct {
			ContractAddress string `json:"contractAddress"`
		}
		out := cast(t, "send", "--rpc-url", rpc, "--unlocked", "--from", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "--json", "--create", art.Bytecode.Object)
		if json.Unmarshal([]byte(out), &receipt) != nil || receipt.ContractAddress == "" {
			t.Fatalf("deploy %s: %s", mode, out)
		}
		return receipt.ContractAddress
	}
	prepVerifier, onlineVerifier := verifier("preparation"), verifier("online")
	// AdmissionProof.verify: two 128-bit halves of each statement digest.
	halves := func(digest string) []string {
		b, _ := hex.DecodeString(strings.TrimPrefix(digest, "0x"))
		return []string{new(big.Int).SetBytes(b[:16]).String(), new(big.Int).SetBytes(b[16:]).String()}
	}
	funding := bytes.Join([][]byte{word(1), word(2), word(3), word(4), word(8), word(9), word(10), word(11), word(12), word(13)}, nil)
	pInputs := halves(keccak(t, pJournal))
	oInputs := append(halves(keccak(t, oJournal)), halves(keccak(t, funding))...)
	verify := func(addr, sig string, seal []byte, inputs []string) error {
		return exec.Command("cast", "call", "--rpc-url", rpc, addr, sig, "0x"+hex.EncodeToString(seal), "["+strings.Join(inputs, ",")+"]").Run()
	}
	if err := verify(prepVerifier, "verifyProof(bytes,uint256[2])", pSeal, pInputs); err != nil {
		t.Fatalf("preparation proof rejected onchain: %v", err)
	}
	if err := verify(onlineVerifier, "verifyProof(bytes,uint256[4])", oSeal, oInputs); err != nil {
		t.Fatalf("online proof rejected onchain: %v", err)
	}
	// The verifiers must not accept anything else.
	bad := append([]string{}, oInputs...)
	bad[2], bad[3] = bad[3], bad[2]
	if verify(onlineVerifier, "verifyProof(bytes,uint256[4])", oSeal, bad) == nil ||
		verify(prepVerifier, "verifyProof(bytes,uint256[2])", oSeal, pInputs) == nil {
		t.Fatal("verifier accepted a changed statement or the wrong proof")
	}
}

func cast(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("cast", args...).Output()
	if err != nil {
		t.Fatalf("cast %s: %v", args[0], err)
	}
	return strings.TrimSpace(string(out))
}

func keccak(t *testing.T, b []byte) string { return cast(t, "keccak", "0x"+hex.EncodeToString(b)) }

// anvil starts an isolated chain on the extension team's port 8562.
func anvil(t *testing.T) string {
	if c, err := net.Dial("tcp", "127.0.0.1:8562"); err == nil {
		c.Close()
		t.Fatal("port 8562 is already in use")
	}
	cmd := exec.Command("anvil", "--port", "8562")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	rpc := "http://127.0.0.1:8562"
	waitFor(t, 15*time.Second, func() bool { return exec.Command("cast", "chain-id", "--rpc-url", rpc).Run() == nil })
	if id := cast(t, "chain-id", "--rpc-url", rpc); id != "31337" {
		t.Fatalf("unexpected chain %s", id)
	}
	return rpc
}
