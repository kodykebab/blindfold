package main

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
	"golang.org/x/crypto/sha3"
	"math/big"
)

func bindStatement(api frontend.API, expected [2]frontend.Variable, parts ...[]uints.U8) error {
	h, e := hash(api, parts...)
	if e != nil {
		return e
	}
	for i := 0; i < 2; i++ {
		bits := make([]frontend.Variable, 0, 128)
		for j := 15; j >= 0; j-- {
			bits = append(bits, api.ToBinary(h[i*16+j].Val, 8)...)
		}
		api.AssertIsEqual(expected[i], api.FromBinary(bits...))
	}
	return nil
}
func nativeStatementDigest(statement []byte) [2]frontend.Variable {
	h := sha3.NewLegacyKeccak256()
	h.Write(statement)
	digest := h.Sum(nil)
	return [2]frontend.Variable{new(big.Int).SetBytes(digest[:16]), new(big.Int).SetBytes(digest[16:])}
}
func nativeHashBytes(s string) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte(s))
	return h.Sum(nil)
}
func concatBytes(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
func nativeAddress(a [20]uints.U8) []byte { return append(make([]byte, 12), nativeU8(a[:])...) }
func fundingStatement(c FundingCircuit) []byte {
	return concatBytes(nativeABI(c.Chain), nativeAddress(c.Settlement), nativeAddress(c.Owner), nativeABI(c.Batch), nativeABI(c.Step), nativeU8(c.OldRoot[:]), nativeU8(c.NewRoot[:]), nativeU8(c.Budgets[0][:]), nativeU8(c.Budgets[1][:]), nativeU8(c.OrderHash[:]))
}
func preparationStatement(c PreparationCircuit) []byte {
	return concatBytes(nativeHashBytes("blindfold.prepared-key.v1"), nativeABI(c.Chain), nativeAddress(c.Settlement), nativeAddress(c.Owner), nativeABI(c.Batch), nativeABI(c.Round), nativeU8(c.Commitment[:]), nativeHashBytes(chainHash+publicKey))
}
func onlineStatement(c OnlineCircuit) []byte {
	f := c.Funding
	return concatBytes(preparationStatement(PreparationCircuit{Chain: f.Chain, Settlement: f.Settlement, Owner: f.Owner, Batch: f.Batch, Round: c.Round, Commitment: c.Commitment}), nativeABI(f.Step), nativeU8(f.OldRoot[:]), nativeU8(f.NewRoot[:]), nativeU8(f.Budgets[0][:]), nativeU8(f.Budgets[1][:]), nativeU8(f.OrderHash[:]), nativeU8(c.CiphertextHash[:]))
}
