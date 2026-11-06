package main

import (
	"fmt"
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
	"golang.org/x/crypto/sha3"
	"strconv"
	"testing"
)

func TestOnlineCanonicalFixture(t *testing.T) {
	path := t.TempDir() + "/fixture.json"
	canonicalFixture("testdata/prepared.json", path)
	c := onlineFixture(path)
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &OnlineCircuit{})
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("online constraints: %d", cs.GetNbConstraints())
	check := func(c OnlineCircuit) error {
		w, e := frontend.NewWitness(&c, ecc.BN254.ScalarField())
		if e != nil {
			return e
		}
		return cs.IsSolved(w)
	}
	if e := check(c); e != nil {
		t.Fatal(e)
	}
	flip := func(b uints.U8) uints.U8 { return uints.NewU8(byte(nativeNumber(b.Val).Uint64()) ^ 1) }
	for name, mutate := range map[string]func(*OnlineCircuit){
		"key":               func(c *OnlineCircuit) { c.Key[0] = flip(c.Key[0]) },
		"nonce":             func(c *OnlineCircuit) { c.Nonce[0] = flip(c.Nonce[0]) },
		"wrapper":           func(c *OnlineCircuit) { c.Wrapper[0] = flip(c.Wrapper[0]) },
		"ciphertext":        func(c *OnlineCircuit) { c.CiphertextHash[0] = flip(c.CiphertextHash[0]) },
		"round":             func(c *OnlineCircuit) { c.Round = 1001 },
		"decimal length":    func(c *OnlineCircuit) { c.DigitCount = 5 },
		"leading zero":      func(c *OnlineCircuit) { c.Digits[0] = 0 },
		"non decimal digit": func(c *OnlineCircuit) { c.Digits[1] = 10 },
		"funding":           func(c *OnlineCircuit) { c.Funding.NewRoot[0] = flip(c.Funding.NewRoot[0]) },
		"order":             func(c *OnlineCircuit) { c.Funding.Amount = 101 },
	} {
		t.Run(name, func(t *testing.T) {
			bad := c
			mutate(&bad)
			if check(bad) == nil {
				t.Fatal("invalid online statement accepted")
			}
		})
	}
	// Round decimal encoding boundaries; wrapper correctness belongs to preparation.
	for _, round := range []uint64{1, 10000000, ^uint64(0)} {
		t.Run(fmt.Sprintf("round_digits_%d", round), func(t *testing.T) {
			a := c
			a.Round = round
			digits := strconv.FormatUint(round, 10)
			a.DigitCount = len(digits)
			for i := range a.Digits {
				a.Digits[i] = 0
				if i < len(digits) {
					a.Digits[i] = int(digits[i] - '0')
				}
			}
			p := PreparationCircuit{Chain: a.Funding.Chain, Settlement: a.Funding.Settlement, Owner: a.Funding.Owner, Batch: a.Funding.Batch, Round: round, Key: a.Key, Blind: a.Blind, Wrapper: a.Wrapper}
			wh := sha3.NewLegacyKeccak256()
			wh.Write(nativeU8(p.Wrapper[:]))
			h := sha3.NewLegacyKeccak256()
			h.Write(concatBytes(nativeHashBytes("blindfold.prepared-key.v1"), nativeABI(p.Chain), nativeAddress(p.Settlement), nativeAddress(p.Owner), nativeABI(p.Batch), nativeABI(p.Round), nativeHashBytes(chainHash), nativeHashBytes(publicKey), wh.Sum(nil), nativeU8(p.Key[:]), nativeU8(p.Blind[:])))
			var digest [32]byte
			copy(digest[:], h.Sum(nil))
			a.Commitment = bytes32(digest)
			ct := canonicalCiphertext(p, a.Funding, nativeU8(a.Nonce[:]))
			h.Reset()
			h.Write(ct)
			copy(digest[:], h.Sum(nil))
			a.CiphertextHash = bytes32(digest)
			a.Digest = nativeStatementDigest(onlineStatement(a))
			if e := check(a); e != nil {
				t.Fatal(e)
			}
		})
	}

}
