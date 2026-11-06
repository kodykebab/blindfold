package main

import (
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
	"golang.org/x/crypto/chacha20poly1305"
	"testing"
)

type payloadCircuit struct {
	Key       [32]uints.U8
	Plaintext [160]uints.U8
	Expected  [176]uints.U8
}

func (c *payloadCircuit) Define(api frontend.API) error {
	b, e := uints.NewBytes(api)
	if e != nil {
		return e
	}
	out := encryptPayload(api, c.Key[:], c.Plaintext[:])
	for i := range out {
		b.AssertIsEqual(out[i], c.Expected[i])
	}
	return nil
}
func TestPayloadAgainstNativeAEAD(t *testing.T) {
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &payloadCircuit{})
	if e != nil {
		t.Fatal(e)
	}
	check := func(c payloadCircuit) error {
		w, e := frontend.NewWitness(&c, ecc.BN254.ScalarField())
		if e != nil {
			return e
		}
		return cs.IsSolved(w)
	}
	for _, fill := range []byte{0, 255, 73} {
		key, plain := make([]byte, 32), make([]byte, 160)
		for i := range key {
			key[i] = fill
		}
		for i := range plain {
			plain[i] = fill
			if fill == 73 {
				plain[i] = byte(i)
			}
		}
		aead, e := chacha20poly1305.New(key)
		if e != nil {
			t.Fatal(e)
		}
		nonce := make([]byte, 12)
		nonce[11] = 1
		expected := aead.Seal(nil, nonce, plain, nil)
		var c payloadCircuit
		copy(c.Key[:], uints.NewU8Array(key))
		copy(c.Plaintext[:], uints.NewU8Array(plain))
		copy(c.Expected[:], uints.NewU8Array(expected))
		if e := check(c); e != nil {
			t.Fatal(e)
		}
		for _, offset := range []int{0, 63, 64, 127, 128, 159, 160, 175} {
			bad := c
			bad.Expected[offset] = uints.NewU8(expected[offset] ^ 1)
			if check(bad) == nil {
				t.Fatalf("changed ciphertext/tag accepted at %d", offset)
			}
		}
	}
}
