package main

import (
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
	"testing"
)

func TestPreparationRustFixture(t *testing.T) {
	c := preparationFixture("testdata/prepared.json")
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &PreparationCircuit{})
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("preparation constraints: %d", cs.GetNbConstraints())
	check := func(c PreparationCircuit) error {
		w, e := frontend.NewWitness(&c, ecc.BN254.ScalarField())
		if e != nil {
			return e
		}
		return cs.IsSolved(w)
	}
	if e := check(c); e != nil {
		t.Fatal(e)
	}
	for name, mutate := range map[string]func(*PreparationCircuit){
		"wrong round": func(c *PreparationCircuit) { c.Round = 1001 },
		"zero round":  func(c *PreparationCircuit) { c.Round = 0 },
		"wrong owner": func(c *PreparationCircuit) { c.Owner[0] = uints.NewU8(3) },
		"wrong key":   func(c *PreparationCircuit) { c.Key[0] = uints.NewU8(byte(nativeNumber(c.Key[0].Val).Uint64()) ^ 1) },
		"wrong wrapper": func(c *PreparationCircuit) {
			c.Wrapper[127] = uints.NewU8(byte(nativeNumber(c.Wrapper[127].Val).Uint64()) ^ 1)
		},
		"wrong sigma": func(c *PreparationCircuit) { c.Sigma[0] = uints.NewU8(byte(nativeNumber(c.Sigma[0].Val).Uint64()) ^ 1) },
		"wrong commitment": func(c *PreparationCircuit) {
			c.Commitment[0] = uints.NewU8(byte(nativeNumber(c.Commitment[0].Val).Uint64()) ^ 1)
		},
	} {
		t.Run(name, func(t *testing.T) {
			bad := c
			mutate(&bad)
			if check(bad) == nil {
				t.Fatal("invalid preparation accepted")
			}
		})
	}
}
