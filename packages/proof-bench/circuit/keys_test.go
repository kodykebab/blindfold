package main

import (
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"testing"
)

type reusableKeyTest struct {
	X frontend.Variable `gnark:",public"`
	Y frontend.Variable
}

func (c *reusableKeyTest) Define(api frontend.API) error {
	api.AssertIsEqual(c.X, api.Mul(c.Y, c.Y))
	return nil
}
func TestReusableKeys(t *testing.T) {
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &reusableKeyTest{})
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("CIRCUIT_KEYS", t.TempDir())
	t.Setenv("CIRCUIT_SETUP", "1")
	_, vk, e := provingKeys(cs, "test")
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = provingKeys(cs, "test"); e == nil {
		t.Fatal("overwrote existing keys")
	}
	t.Setenv("CIRCUIT_SETUP", "")
	pk, _, e := provingKeys(cs, "test")
	if e != nil {
		t.Fatal(e)
	}
	w, e := frontend.NewWitness(&reusableKeyTest{X: 9, Y: 3}, ecc.BN254.ScalarField())
	if e != nil {
		t.Fatal(e)
	}
	proof, e := groth16.Prove(cs, pk, w)
	if e != nil {
		t.Fatal(e)
	}
	public, e := w.Public()
	if e != nil {
		t.Fatal(e)
	}
	if e = groth16.Verify(proof, vk, public); e != nil {
		t.Fatal(e)
	}
	if _, _, e = provingKeys(cs, "another circuit"); e == nil {
		t.Fatal("accepted wrong key identity")
	}
}
