package main

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/cmp"
	"github.com/consensys/gnark/std/math/uints"
	"math/big"
)

// GlobalFundingCircuit binds a fixed eight-slot token registry and cumulative private reservations.
// Empty registry slots are zero addresses and cannot be used by an order.
type GlobalFundingCircuit struct {
	Chain, Batch, Step                        frontend.Variable
	Settlement, Owner                         [20]uints.U8
	Tokens                                    [8][20]uints.U8
	RegistryHash, OldRoot, NewRoot, OrderHash [32]uints.U8
	Budgets                                   [8][32]uints.U8
	Input, Output, Amount, Minimum            frontend.Variable
	Totals                                    [8]frontend.Variable
	Salt, OldBlind, NewBlind                  [32]uints.U8
}

func (c *GlobalFundingCircuit) Define(api frontend.API) error {
	b, e := uints.NewBytes(api)
	if e != nil {
		return e
	}
	chain, batch, step := word(api, c.Chain, 64), word(api, c.Batch, 64), word(api, c.Step, 6)
	owner, settlement := address(c.Owner), address(c.Settlement)
	input, output := word(api, c.Input, 3), word(api, c.Output, 3)
	amount, minimum := word(api, c.Amount, 128), word(api, c.Minimum, 128)
	api.AssertIsDifferent(c.Amount, 0)
	api.AssertIsDifferent(c.Input, c.Output)
	registry := []uints.U8{}
	validIn, validOut := frontend.Variable(0), frontend.Variable(0)
	for i, t := range c.Tokens {
		registry = append(registry, address(t)...)
		nonzero := frontend.Variable(0)
		for _, v := range t {
			api.ToBinary(v.Val, 8)
			nonzero = api.Add(nonzero, v.Val)
		}
		validIn = api.Add(validIn, api.Mul(api.IsZero(api.Sub(c.Input, i)), nonzero))
		validOut = api.Add(validOut, api.Mul(api.IsZero(api.Sub(c.Output, i)), nonzero))
	}
	api.AssertIsDifferent(validIn, 0)
	api.AssertIsDifferent(validOut, 0)
	digest, e := hash(api, registry)
	if e != nil {
		return e
	}
	for i := range digest {
		b.AssertIsEqual(digest[i], c.RegistryHash[i])
	}
	order, e := hash(api, constantHash("blindfold.global.order.v1"), chain, settlement, c.RegistryHash[:], batch, owner, input, output, amount, minimum, c.Salt[:])
	if e != nil {
		return e
	}
	for i := range order {
		b.AssertIsEqual(order[i], c.OrderHash[i])
	}
	first := api.IsZero(c.Step)
	old := []uints.U8{}
	next := []uints.U8{}
	max := new(big.Int).Mul(new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 128), big.NewInt(1)), big.NewInt(64))
	for i, total := range c.Totals {
		api.ToBinary(total, 134)
		api.AssertIsLessOrEqual(total, max)
		api.AssertIsEqual(api.Mul(first, total), 0)
		old = append(old, word(api, total, 134)...)
		n := api.Add(total, api.Mul(api.IsZero(api.Sub(c.Input, i)), c.Amount))
		bits := api.ToBinary(n, 134)
		api.AssertIsLessOrEqual(n, max)
		next = append(next, word(api, n, 134)...)
		for len(bits) < 256 {
			bits = append(bits, 0)
		}
		budget := []frontend.Variable{}
		for j := 31; j >= 0; j-- {
			budget = append(budget, api.ToBinary(c.Budgets[i][j].Val, 8)...)
		}
		api.AssertIsEqual(cmp.IsLessOrEqualBinary(api, bits, budget), 1)
	}
	for _, v := range c.OldBlind {
		api.ToBinary(v.Val, 8)
		api.AssertIsEqual(api.Mul(first, v.Val), 0)
	}
	oldHash, e := hash(api, constantHash("blindfold.global.funding.v1"), chain, settlement, owner, c.RegistryHash[:], batch, old, c.OldBlind[:], step)
	if e != nil {
		return e
	}
	newHash, e := hash(api, constantHash("blindfold.global.funding.v1"), chain, settlement, owner, c.RegistryHash[:], batch, next, c.NewBlind[:], word(api, api.Add(c.Step, 1), 7))
	if e != nil {
		return e
	}
	for i := range oldHash {
		b.AssertIsEqual(c.OldRoot[i], uints.U8{Val: api.Select(first, 0, oldHash[i].Val)})
		b.AssertIsEqual(c.NewRoot[i], newHash[i])
	}
	return nil
}
