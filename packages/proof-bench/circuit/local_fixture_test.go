package main

import (
	"bytes"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

func TestNativeQuicknetWrapperMatchesRust(t *testing.T) {
	p := preparationFixture("testdata/prepared.json")
	wrapper, ok := quicknetWrapper(number("1000").Uint64(), nativeU8(p.Key[:]), nativeU8(p.Sigma[:]))
	if !ok || !bytes.Equal(wrapper, nativeU8(p.Wrapper[:])) {
		t.Fatal("native quicknet wrapper differs from independent Rust fixture")
	}
}
func TestLocalFixtureFundingAndBounds(t *testing.T) {
	r := localRequest{ChainID: "130", Settlement: "0x0101010101010101010101010101010101010101", Owner: "0x0202020202020202020202020202020202020202", Batch: "7", Round: "1000", Step: "0", Totals: [2]string{"0", "0"}, Budgets: [2]string{"1000", "1000"}, OldBlind: "0x" + string(bytes.Repeat([]byte("0"), 64)), ZeroForOne: true, Amount: "100", Minimum: "90", Salt: "0x" + string(bytes.Repeat([]byte("1"), 64))}
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &FundingCircuit{})
	if e != nil {
		t.Fatal(e)
	}
	check := func(r localRequest) {
		raw, e := json.Marshal(localFixture(r))
		if e != nil {
			t.Fatal(e)
		}
		path := filepath.Join(t.TempDir(), "fixture.json")
		if e = os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
		f := fixture(path)
		w, e := frontend.NewWitness(&f, ecc.BN254.ScalarField())
		if e != nil {
			t.Fatal(e)
		}
		if e = cs.IsSolved(w); e != nil {
			t.Fatal(e)
		}
		p := preparationFixture(path)
		online := onlineFixture(path)
		if !bytes.Equal(nativeU8(online.CiphertextHash[:]), hashParts(canonicalCiphertext(p, f, nativeU8(online.Nonce[:])))) {
			t.Fatal("ciphertext hash mismatch")
		}
	}
	check(r)
	r.Step = "1"
	r.Totals = [2]string{"100", "0"}
	r.OldBlind = "0x" + string(bytes.Repeat([]byte("2"), 64))
	r.ZeroForOne = false
	check(r)
	for _, mutate := range []func(*localRequest){func(r *localRequest) { r.Amount = "-1" }, func(r *localRequest) { r.Step = "64" }, func(r *localRequest) { r.Budgets[1] = "1" }, func(r *localRequest) { r.Owner = "0x01" }, func(r *localRequest) { r.Step = "0" }} {
		bad := r
		mutate(&bad)
		func() {
			defer func() {
				if recover() == nil {
					t.Error("invalid request accepted")
				}
			}()
			localFixture(bad)
		}()
	}
}

func TestLocalFixtureKeepsUint128AsDecimalStrings(t *testing.T) {
	r := localRequest{ChainID: "130", Settlement: "0x0101010101010101010101010101010101010101", Owner: "0x0202020202020202020202020202020202020202", Batch: "7", Round: "1000", Step: "0", Totals: [2]string{"0", "0"}, Budgets: [2]string{"340282366920938463463374607431768211455", "0"}, OldBlind: "0x" + string(bytes.Repeat([]byte("0"), 64)), ZeroForOne: true, Amount: "1000000000000000001", Minimum: "9007199254740993", Salt: "0x" + string(bytes.Repeat([]byte("1"), 64))}
	raw, e := json.Marshal(localFixture(r))
	if e != nil {
		t.Fatal(e)
	}
	var decoded []any
	if e = json.Unmarshal(raw, &decoded); e != nil {
		t.Fatal(e)
	}
	order := decoded[3].(map[string]any)["order"].(map[string]any)
	if order["amount"] != r.Amount || order["minimum"] != r.Minimum {
		t.Fatal("large integers would lose precision in a JavaScript JSON roundtrip")
	}
	path := filepath.Join(t.TempDir(), "fixture.json")
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	f := fixture(path)
	if f.Amount.(*big.Int).String() != r.Amount || f.Minimum.(*big.Int).String() != r.Minimum {
		t.Fatal("fixture parser changed integer")
	}
}

func TestAdvancePreparationBinding(t *testing.T) {
	r := localRequest{ChainID: "31337", Settlement: "0x0101010101010101010101010101010101010101", Owner: "0x0202020202020202020202020202020202020202", Batch: "7", Round: "1000"}
	prepared := preparationOnlyFixture(r)
	r.Preparation = prepared["preparation"].(*localPreparation)
	// Order and funding values are chosen only after the preparation has been produced.
	r.Step = "0"
	r.Totals = [2]string{"0", "0"}
	r.Budgets = [2]string{"1000", "1000"}
	r.OldBlind = "0x" + string(bytes.Repeat([]byte("0"), 64))
	r.Salt = r.OldBlind
	r.Amount = "100"
	r.Minimum = "90"
	r.ZeroForOne = true
	f := localFixture(r)
	before, _ := json.Marshal(prepared["fixture"])
	after, _ := json.Marshal(f[:2])
	if !bytes.Equal(before, after) {
		t.Fatal("online order changed the prepared statement or key")
	}
	for _, mutate := range []func(*localRequest){
		func(r *localRequest) { r.ChainID = "1" }, func(r *localRequest) { r.Owner = r.Settlement },
		func(r *localRequest) { r.Settlement = r.Owner }, func(r *localRequest) { r.Batch = "8" },
		func(r *localRequest) { r.Round = "1001" },
		func(r *localRequest) {
			p := *r.Preparation
			p.Key = "0x" + string(bytes.Repeat([]byte("0"), 32))
			r.Preparation = &p
		},
	} {
		bad := r
		mutate(&bad)
		func() {
			defer func() {
				if recover() == nil {
					t.Error("foreign or corrupted preparation accepted")
				}
			}()
			localFixture(bad)
		}()
	}
}
