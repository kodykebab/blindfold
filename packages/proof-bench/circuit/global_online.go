package main

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
)

type GlobalOnlineCircuit struct {
	Digest                     [2]frontend.Variable `gnark:",public"`
	Funding                    GlobalFundingCircuit
	Round                      frontend.Variable
	Commitment, CiphertextHash [32]uints.U8
	Key                        [16]uints.U8
	Blind                      [32]uints.U8
	Wrapper                    [128]uints.U8
	Nonce                      [16]uints.U8
	Digits                     [20]frontend.Variable
	DigitCount                 frontend.Variable
}

func (c *GlobalOnlineCircuit) Define(api frontend.API) error {
	if e := c.Funding.Define(api); e != nil {
		return e
	}
	f := &c.Funding
	shared := OnlineCircuit{Funding: FundingCircuit{Chain: f.Chain, Settlement: f.Settlement, Owner: f.Owner, Batch: f.Batch}, Round: c.Round, Commitment: c.Commitment, CiphertextHash: c.CiphertextHash, Key: c.Key, Blind: c.Blind, Wrapper: c.Wrapper, Nonce: c.Nonce, Digits: c.Digits, DigitCount: c.DigitCount}
	plaintext := append(address(f.Owner), word(api, f.Input, 3)...)
	plaintext = append(plaintext, word(api, f.Output, 3)...)
	plaintext = append(plaintext, word(api, f.Amount, 128)...)
	plaintext = append(plaintext, word(api, f.Minimum, 128)...)
	plaintext = append(plaintext, f.Salt[:]...)
	if e := shared.ciphertextRelation(api, plaintext); e != nil {
		return e
	}
	round := word(api, c.Round, 64)
	prep, e := hash(api, constantHash("blindfold.prepared-key.v1"), word(api, f.Chain, 64), address(f.Settlement), address(f.Owner), word(api, f.Batch, 64), round, c.Commitment[:], constantHash(chainHash+publicKey))
	if e != nil {
		return e
	}
	budgets := []uints.U8{}
	for _, v := range f.Budgets {
		budgets = append(budgets, v[:]...)
	}
	return bindStatement(api, c.Digest, constantHash("blindfold.global.online.v1"), prep, f.RegistryHash[:], word(api, f.Step, 6), f.OldRoot[:], f.NewRoot[:], budgets, f.OrderHash[:], c.CiphertextHash[:])
}
