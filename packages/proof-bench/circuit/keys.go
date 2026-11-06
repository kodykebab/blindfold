package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"io"
	"os"
	"path/filepath"
)

type keyIdentity struct {
	Mode          string `json:"mode"`
	CircuitSHA256 string `json:"circuitSHA256"`
}

// Explicit setup directories bind reusable keys to the compiled circuit, not just its input count.
// Local setup is suitable for development. Production parameters require a reviewed ceremony.
func provingKeys(cs constraint.ConstraintSystem, mode string) (groth16.ProvingKey, groth16.VerifyingKey, error) {
	dir := os.Getenv("CIRCUIT_KEYS")
	if dir == "" {
		return groth16.Setup(cs)
	}
	digest := sha256.New()
	if _, e := cs.WriteTo(digest); e != nil {
		return nil, nil, e
	}
	expected := keyIdentity{Mode: mode, CircuitSHA256: hex.EncodeToString(digest.Sum(nil))}
	manifest := filepath.Join(dir, "identity.json")
	if os.Getenv("CIRCUIT_SETUP") == "1" {
		if entries, e := os.ReadDir(dir); e == nil && len(entries) != 0 {
			return nil, nil, fmt.Errorf("setup directory must be empty")
		}
		if e := os.MkdirAll(dir, 0700); e != nil {
			return nil, nil, e
		}
		pk, vk, e := groth16.Setup(cs)
		if e != nil {
			return nil, nil, e
		}
		write := func(name string, value io.WriterTo) error {
			file, e := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil {
				return e
			}
			_, err := value.WriteTo(file)
			closeErr := file.Close()
			if err != nil {
				return err
			}
			return closeErr
		}
		if e = write("proving.key", pk); e != nil {
			return nil, nil, e
		}
		if e = write("verifying.key", vk); e != nil {
			return nil, nil, e
		}
		data, e := json.MarshalIndent(expected, "", "  ")
		if e != nil {
			return nil, nil, e
		}
		if e = os.WriteFile(manifest, data, 0600); e != nil {
			return nil, nil, e
		}
		return pk, vk, nil
	}
	data, e := os.ReadFile(manifest)
	if e != nil {
		return nil, nil, fmt.Errorf("load circuit keys: %w", e)
	}
	var actual keyIdentity
	if e = json.Unmarshal(data, &actual); e != nil {
		return nil, nil, e
	}
	if actual != expected {
		return nil, nil, fmt.Errorf("proving key circuit identity mismatch")
	}
	read := func(name string, value io.ReaderFrom) error {
		file, e := os.Open(filepath.Join(dir, name))
		if e != nil {
			return e
		}
		defer file.Close()
		_, e = value.ReadFrom(file)
		return e
	}
	pk, vk := groth16.NewProvingKey(ecc.BN254), groth16.NewVerifyingKey(ecc.BN254)
	if e = read("proving.key", pk); e != nil {
		return nil, nil, e
	}
	if e = read("verifying.key", vk); e != nil {
		return nil, nil, e
	}
	return pk, vk, nil
}
