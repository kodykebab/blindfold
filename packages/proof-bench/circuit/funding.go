package main

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/hash/sha3"
	"github.com/consensys/gnark/std/math/cmp"
	"github.com/consensys/gnark/std/math/uints"
	"math/big"
)

// FundingCircuit proves the existing order hash and private reservation update.
// Encryption is a separate relation; this circuit alone does not admit an order.
type FundingCircuit struct {
	Chain, Batch, Step          frontend.Variable `gnark:",public"`
	Settlement, Owner           [20]uints.U8      `gnark:",public"`
	OldRoot, NewRoot, OrderHash [32]uints.U8      `gnark:",public"`
	Budgets                     [2][32]uints.U8   `gnark:",public"`
	Direction, Amount, Minimum  frontend.Variable
	Totals                      [2]frontend.Variable
	Salt, OldBlind, NewBlind    [32]uints.U8
}

func word(api frontend.API, x frontend.Variable, width int) []uints.U8 {
	bits := api.ToBinary(x, width)
	out := make([]uints.U8, 32)
	for i := range out {
		out[i] = uints.NewU8(0)
	}
	for i := 0; i < width; i += 8 {
		end := i + 8
		if end > width {
			end = width
		}
		out[31-i/8] = uints.U8{Val: api.FromBinary(bits[i:end]...)}
	}
	return out
}
func address(a [20]uints.U8) []uints.U8 {
	out := make([]uints.U8, 12)
	for i := range out {
		out[i] = uints.NewU8(0)
	}
	return append(out, a[:]...)
}
func hash(api frontend.API, chunks ...[]uints.U8) ([]uints.U8, error) {
	h, e := sha3.NewLegacyKeccak256(api)
	if e != nil {
		return nil, e
	}
	for _, c := range chunks {
		h.Write(c)
	}
	return h.Sum(), nil
}
func (c *FundingCircuit) Define(api frontend.API) error {
	b, e := uints.NewBytes(api)
	if e != nil {
		return e
	}
	api.AssertIsBoolean(c.Direction)
	chain, batch, step := word(api, c.Chain, 64), word(api, c.Batch, 64), word(api, c.Step, 6)
	amount, minimum := word(api, c.Amount, 128), word(api, c.Minimum, 128)
	owner, settlement := address(c.Owner), address(c.Settlement)
	order, e := hash(api, chain, settlement, batch, owner, word(api, c.Direction, 1), amount, minimum, c.Salt[:])
	if e != nil {
		return e
	}
	for i := range order {
		b.AssertIsEqual(order[i], c.OrderHash[i])
	}
	max := new(big.Int).Lsh(big.NewInt(1), 128)
	max.Sub(max, big.NewInt(1))
	max.Mul(max, big.NewInt(64))
	first := api.IsZero(c.Step)
	for i := range c.Totals {
		api.ToBinary(c.Totals[i], 134)
		api.AssertIsLessOrEqual(c.Totals[i], max)
		api.AssertIsEqual(api.Mul(first, c.Totals[i]), 0)
	}
	for i := range c.OldBlind {
		api.ToBinary(c.OldBlind[i].Val, 8)
		api.AssertIsEqual(api.Mul(first, c.OldBlind[i].Val), 0)
	}
	old, e := hash(api, chain, settlement, owner, batch, word(api, c.Totals[0], 134), word(api, c.Totals[1], 134), c.OldBlind[:], step)
	if e != nil {
		return e
	}
	for i := range old {
		b.AssertIsEqual(c.OldRoot[i], uints.U8{Val: api.Select(first, 0, old[i].Val)})
	}
	next := [2]frontend.Variable{api.Add(c.Totals[0], api.Mul(c.Direction, c.Amount)), api.Add(c.Totals[1], api.Mul(api.Sub(1, c.Direction), c.Amount))}
	for i := range next {
		nb := api.ToBinary(next[i], 134)
		api.AssertIsLessOrEqual(next[i], max)
		for len(nb) < 256 {
			nb = append(nb, 0)
		}
		budget := make([]frontend.Variable, 0, 256)
		for j := 31; j >= 0; j-- {
			budget = append(budget, api.ToBinary(c.Budgets[i][j].Val, 8)...)
		}
		api.AssertIsEqual(cmp.IsLessOrEqualBinary(api, nb, budget), 1)
	}
	root, e := hash(api, chain, settlement, owner, batch, word(api, next[0], 134), word(api, next[1], 134), c.NewBlind[:], word(api, api.Add(c.Step, 1), 7))
	if e != nil {
		return e
	}
	for i := range root {
		b.AssertIsEqual(root[i], c.NewRoot[i])
	}
	return nil
}
