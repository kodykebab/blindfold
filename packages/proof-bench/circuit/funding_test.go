package main

import (
	"fmt"
	"golang.org/x/crypto/sha3"
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
)

// The accepted values are produced by the existing Rust checker, not this circuit.
func TestRustFixtureAndBoundaries(t *testing.T) {
	c := fixture("testdata/prepared.json")
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &FundingCircuit{})
	if e != nil {
		t.Fatal(e)
	}
	check := func(c FundingCircuit) error {
		w, e := frontend.NewWitness(&c, ecc.BN254.ScalarField())
		if e != nil {
			return e
		}
		return cs.IsSolved(w)
	}
	if e := check(c); e != nil {
		t.Fatal(e)
	}
	cases := map[string]func(*FundingCircuit){
		"wrong owner":          func(c *FundingCircuit) { c.Owner[0] = uints.NewU8(3) },
		"wrong deployment":     func(c *FundingCircuit) { c.Settlement[0] = uints.NewU8(3) },
		"wrong chain":          func(c *FundingCircuit) { c.Chain = 131 },
		"wrong batch":          func(c *FundingCircuit) { c.Batch = 8 },
		"wrong order amount":   func(c *FundingCircuit) { c.Amount = 101 },
		"nonboolean direction": func(c *FundingCircuit) { c.Direction = 2 },
		"amount overflow":      func(c *FundingCircuit) { c.Amount = new(big.Int).Lsh(big.NewInt(1), 128) },
		"step overflow":        func(c *FundingCircuit) { c.Step = 64 },
		"insufficient budget": func(c *FundingCircuit) {
			for i := range c.Budgets[0] {
				c.Budgets[0][i] = uints.NewU8(0)
			}
		},
		"noncanonical budget byte": func(c *FundingCircuit) { c.Budgets[0][0] = uints.U8{Val: 256} },
		"initial totals nonzero":   func(c *FundingCircuit) { c.Totals[0] = 1 },
		"initial blind nonzero":    func(c *FundingCircuit) { c.OldBlind[0] = uints.NewU8(1) },
		"initial root nonzero":     func(c *FundingCircuit) { c.OldRoot[0] = uints.NewU8(1) },
		"changed new root":         func(c *FundingCircuit) { c.NewRoot[0] = uints.U8{Val: 257} },
		"changed salt":             func(c *FundingCircuit) { c.Salt[0] = uints.U8{Val: 256} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bad := c
			mutate(&bad)
			if check(bad) == nil {
				t.Fatal("invalid statement accepted")
			}
		})
	}
	for _, tc := range []struct {
		name                    string
		step                    uint64
		direction               int
		amount, minimum, t0, t1 *big.Int
	}{
		{"continuation other direction", 1, 0, big.NewInt(40), big.NewInt(20), big.NewInt(100), big.NewInt(25)},
		{"last step padding maximum totals", 63, 1, big.NewInt(0), new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 128), big.NewInt(1)), maxTotal(), maxTotal()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := c
			a.Step = tc.step
			a.Direction = tc.direction
			a.Amount = tc.amount
			a.Minimum = tc.minimum
			a.Totals = [2]frontend.Variable{tc.t0, tc.t1}
			a.OldBlind = a.NewBlind
			setNativeHashes(&a)
			if e := check(a); e != nil {
				t.Fatal(e)
			}
			a.OldBlind[0] = uints.U8{Val: 256}
			if check(a) == nil {
				t.Fatal("bad continuation opening accepted")
			}
		})
	}
	// A 256-bit public budget must remain valid even above the SNARK scalar field.
	for i := range c.Budgets {
		for j := range c.Budgets[i] {
			c.Budgets[i][j] = uints.NewU8(255)
		}
	}
	c.Digest = nativeStatementDigest(fundingStatement(c))
	if e := check(c); e != nil {
		t.Fatalf("full uint256 budgets: %v", e)
	}
}

func maxTotal() *big.Int {
	return new(big.Int).Mul(new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 128), big.NewInt(1)), big.NewInt(64))
}
func nativeNumber(v frontend.Variable) *big.Int {
	n, ok := new(big.Int).SetString(fmt.Sprint(v), 10)
	if !ok {
		panic("not an integer")
	}
	return n
}
func nativeWord(v frontend.Variable) []byte { return nativeNumber(v).FillBytes(make([]byte, 32)) }
func nativeBytes(v []uints.U8) []byte {
	out := make([]byte, len(v))
	for i := range v {
		out[i] = byte(nativeNumber(v[i].Val).Uint64())
	}
	return out
}
func nativeHash(parts ...[]byte) [32]uints.U8 {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	var r [32]byte
	copy(r[:], h.Sum(nil))
	return bytes32(r)
}
func setNativeHashes(c *FundingCircuit) {
	chain, batch := nativeWord(c.Chain), nativeWord(c.Batch)
	owner := append(make([]byte, 12), nativeBytes(c.Owner[:])...)
	settlement := append(make([]byte, 12), nativeBytes(c.Settlement[:])...)
	c.OrderHash = nativeHash(chain, settlement, batch, owner, nativeWord(c.Direction), nativeWord(c.Amount), nativeWord(c.Minimum), nativeBytes(c.Salt[:]))
	c.OldRoot = nativeHash(chain, settlement, owner, batch, nativeWord(c.Totals[0]), nativeWord(c.Totals[1]), nativeBytes(c.OldBlind[:]), nativeWord(c.Step))
	next := [2]*big.Int{nativeNumber(c.Totals[0]), nativeNumber(c.Totals[1])}
	idx := 1
	if nativeNumber(c.Direction).Sign() != 0 {
		idx = 0
	}
	next[idx].Add(next[idx], nativeNumber(c.Amount))
	c.NewRoot = nativeHash(chain, settlement, owner, batch, nativeWord(next[0]), nativeWord(next[1]), nativeBytes(c.NewBlind[:]), nativeWord(new(big.Int).Add(nativeNumber(c.Step), big.NewInt(1))))
	c.Digest = nativeStatementDigest(fundingStatement(*c))
}
