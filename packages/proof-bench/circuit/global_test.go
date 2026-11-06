package main

import (
	"fmt"
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
	"testing"
)

func globalTestInput() GlobalInput {
	in := GlobalInput{Input: 1, Output: 2, Amount: "100", Minimum: "90"}
	for i := 0; i < 8; i++ {
		in.Tokens = append(in.Tokens, fmt.Sprintf("0x%040x", i+1))
		in.Budgets[i] = "1000"
	}
	return in
}
func TestGlobalOnline(t *testing.T) {
	p := preparationFixture("testdata/prepared.json")
	in := globalTestInput()
	c, _ := globalAssignment(p, in)
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &GlobalOnlineCircuit{})
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("global online constraints: %d", cs.GetNbConstraints())
	check := func(c GlobalOnlineCircuit) error {
		w, e := frontend.NewWitness(&c, ecc.BN254.ScalarField())
		if e != nil {
			return e
		}
		return cs.IsSolved(w)
	}
	if e := check(c); e != nil {
		t.Fatal(e)
	}
	for name, mutate := range map[string]func(*GlobalOnlineCircuit){
		"input token":    func(c *GlobalOnlineCircuit) { c.Funding.Input = 0 },
		"output token":   func(c *GlobalOnlineCircuit) { c.Funding.Output = 0 },
		"token registry": func(c *GlobalOnlineCircuit) { c.Funding.Tokens[0][0] = uints.NewU8(1) },
		"budget":         func(c *GlobalOnlineCircuit) { c.Funding.Budgets[1] = bytes32([32]byte{}) },
		"amount":         func(c *GlobalOnlineCircuit) { c.Funding.Amount = 101 },
		"minimum":        func(c *GlobalOnlineCircuit) { c.Funding.Minimum = 89 },
		"ciphertext":     func(c *GlobalOnlineCircuit) { c.CiphertextHash[0] = uints.NewU8(1) },
		"round":          func(c *GlobalOnlineCircuit) { c.Round = 1001 },
		"step":           func(c *GlobalOnlineCircuit) { c.Funding.Step = 64 },
		"first totals":   func(c *GlobalOnlineCircuit) { c.Funding.Totals[0] = 1 },
		"previous root":  func(c *GlobalOnlineCircuit) { c.Funding.OldRoot[0] = uints.NewU8(1) },
		"next root":      func(c *GlobalOnlineCircuit) { c.Funding.NewRoot[0] = uints.NewU8(1) },
	} {
		t.Run(name, func(t *testing.T) {
			bad := c
			mutate(&bad)
			if check(bad) == nil {
				t.Fatal("invalid witness accepted")
			}
		})
	}
	for _, index := range []uint8{0, 7} {
		t.Run(fmt.Sprintf("funding_slot_%d", index), func(t *testing.T) {
			in := globalTestInput()
			in.Input = index
			in.Step = 1
			in.Totals[index] = "900"
			a, _ := globalAssignment(p, in)
			if e := check(a); e != nil {
				t.Fatal(e)
			}
			in.Totals[index] = "901"
			bad, _ := globalAssignment(p, in)
			if check(bad) == nil {
				t.Fatal("overspending accepted")
			}
		})
	}
}
