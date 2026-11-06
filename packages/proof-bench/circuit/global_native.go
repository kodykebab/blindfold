package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/consensys/gnark/std/math/uints"
	"math/big"
	"os"
	"strconv"
	"strings"
)

type GlobalInput struct {
	Preparation string    `json:"preparation"`
	Tokens      []string  `json:"tokens"`
	Input       uint8     `json:"input"`
	Output      uint8     `json:"output"`
	Amount      string    `json:"amount"`
	Minimum     string    `json:"minimum"`
	Step        uint8     `json:"step"`
	Totals      [8]string `json:"totals"`
	Budgets     [8]string `json:"budgets"`
	OldBlind    string    `json:"oldBlind"`
	Salt        string    `json:"salt"`
}

func globalHash(parts ...[]byte) [32]uints.U8 {
	return bytes32([32]byte(nativeHashBytes(string(concatBytes(parts...)))))
}
func hexBytes(s string, n int) []byte {
	if s == "" {
		return make([]byte, n)
	}
	b, e := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	must(e)
	if len(b) != n {
		panic("wrong hex length")
	}
	return b
}
func globalRoot(f GlobalFundingCircuit, totals [8]*big.Int, blind [32]uints.U8, step uint64) [32]uints.U8 {
	data := []byte{}
	for _, v := range totals {
		data = append(data, nativeABI(v)...)
	}
	return globalHash(nativeHashBytes("blindfold.global.funding.v1"), nativeABI(f.Chain), nativeAddress(f.Settlement), nativeAddress(f.Owner), nativeU8(f.RegistryHash[:]), nativeABI(f.Batch), data, nativeU8(blind[:]), nativeABI(step))
}
func globalPlaintext(f GlobalFundingCircuit) []byte {
	return concatBytes(nativeAddress(f.Owner), nativeABI(f.Input), nativeABI(f.Output), nativeABI(f.Amount), nativeABI(f.Minimum), nativeU8(f.Salt[:]))
}
func globalStatement(c GlobalOnlineCircuit) []byte {
	f := c.Funding
	p := preparationStatement(PreparationCircuit{Chain: f.Chain, Settlement: f.Settlement, Owner: f.Owner, Batch: f.Batch, Round: c.Round, Commitment: c.Commitment})
	budget := []byte{}
	for _, b := range f.Budgets {
		budget = append(budget, nativeU8(b[:])...)
	}
	return concatBytes(nativeHashBytes("blindfold.global.online.v1"), nativeHashBytes(string(p)), nativeU8(f.RegistryHash[:]), nativeABI(f.Step), nativeU8(f.OldRoot[:]), nativeU8(f.NewRoot[:]), budget, nativeU8(f.OrderHash[:]), nativeU8(c.CiphertextHash[:]))
}
func globalAssignment(p PreparationCircuit, in GlobalInput) (GlobalOnlineCircuit, []byte) {
	if len(in.Tokens) < 2 || len(in.Tokens) > 8 || int(in.Input) >= len(in.Tokens) || int(in.Output) >= len(in.Tokens) || in.Input == in.Output || in.Step >= 64 {
		panic("invalid global order")
	}
	f := GlobalFundingCircuit{Chain: p.Chain, Settlement: p.Settlement, Owner: p.Owner, Batch: p.Batch, Step: in.Step, Input: in.Input, Output: in.Output, Amount: number(in.Amount), Minimum: number(in.Minimum)}
	registry := []byte{}
	for i := 0; i < 8; i++ {
		token := make([]byte, 20)
		if i < len(in.Tokens) {
			token = hexBytes(in.Tokens[i], 20)
			if new(big.Int).SetBytes(token).Sign() == 0 || (i > 0 && strings.Compare(hex.EncodeToString(token), hex.EncodeToString(nativeU8(f.Tokens[i-1][:]))) <= 0) {
				panic("tokens must be nonzero and sorted")
			}
		}
		copy(f.Tokens[i][:], uints.NewU8Array(token))
		registry = append(registry, nativeAddress(f.Tokens[i])...)
	}
	f.RegistryHash = globalHash(registry)
	copy(f.Salt[:], uints.NewU8Array(hexBytes(in.Salt, 32)))
	copy(f.OldBlind[:], uints.NewU8Array(hexBytes(in.OldBlind, 32)))
	var random [32]byte
	_, e := rand.Read(random[:])
	must(e)
	f.NewBlind = bytes32(random)
	totals := [8]*big.Int{}
	for i := 0; i < 8; i++ {
		total, budget := in.Totals[i], in.Budgets[i]
		if total == "" {
			total = "0"
		}
		if budget == "" {
			budget = "0"
		}
		totals[i] = number(total)
		f.Totals[i] = totals[i]
		f.Budgets[i] = bytes32([32]byte(number(budget).FillBytes(make([]byte, 32))))
	}
	f.OldRoot = bytes32([32]byte{})
	if in.Step > 0 {
		f.OldRoot = globalRoot(f, totals, f.OldBlind, uint64(in.Step))
	}
	next := totals
	next[in.Input] = new(big.Int).Add(totals[in.Input], number(in.Amount))
	f.NewRoot = globalRoot(f, next, f.NewBlind, uint64(in.Step)+1)
	f.OrderHash = globalHash(nativeHashBytes("blindfold.global.order.v1"), nativeABI(f.Chain), nativeAddress(f.Settlement), nativeU8(f.RegistryHash[:]), nativeABI(f.Batch), globalPlaintext(f))
	c := GlobalOnlineCircuit{Funding: f, Round: p.Round, Commitment: p.Commitment, Key: p.Key, Blind: p.Blind, Wrapper: p.Wrapper}
	nonce := make([]byte, 16)
	_, e = rand.Read(nonce)
	must(e)
	copy(c.Nonce[:], uints.NewU8Array(nonce))
	ct := canonicalPlaintext(p, globalPlaintext(f), nonce)
	c.CiphertextHash = globalHash(ct)
	digits := strconv.FormatUint(number(fmt.Sprint(p.Round)).Uint64(), 10)
	c.DigitCount = len(digits)
	for i := range c.Digits {
		c.Digits[i] = 0
		if i < len(digits) {
			c.Digits[i] = int(digits[i] - '0')
		}
	}
	c.Digest = nativeStatementDigest(globalStatement(c))
	return c, ct
}
func globalFixture(path string) GlobalOnlineCircuit {
	data, e := os.ReadFile(path)
	must(e)
	var in GlobalInput
	must(json.Unmarshal(data, &in))
	if in.Salt == "" {
		var salt [32]byte
		_, e := rand.Read(salt[:])
		must(e)
		in.Salt = "0x" + hex.EncodeToString(salt[:])
	}
	p := preparationFixture(in.Preparation)
	c, ct := globalAssignment(p, in)
	if dir := os.Getenv("CIRCUIT_OUTPUT"); dir != "" {
		must(os.MkdirAll(dir, 0700))
		totals := [8]string{}
		for i, v := range c.Funding.Totals {
			n := number(fmt.Sprint(v))
			if i == int(in.Input) {
				n.Add(n, number(in.Amount))
			}
			totals[i] = n.String()
		}
		encode := func(v []uints.U8) string { return "0x" + hex.EncodeToString(nativeU8(v)) }
		out := map[string]any{"order": map[string]any{"owner": "0x" + hex.EncodeToString(nativeU8(c.Funding.Owner[:])), "tokenIn": in.Input, "tokenOut": in.Output, "amountIn": in.Amount, "minAmountOut": in.Minimum}, "salt": in.Salt, "ciphertext": "0x" + hex.EncodeToString(ct), "orderHash": encode(c.Funding.OrderHash[:]), "registryHash": encode(c.Funding.RegistryHash[:]), "root": encode(c.Funding.NewRoot[:]), "oldRoot": encode(c.Funding.OldRoot[:]), "keyCommitment": encode(c.Commitment[:]), "next": map[string]any{"totals": totals, "oldBlind": encode(c.Funding.NewBlind[:]), "step": in.Step + 1}, "input": in}
		result, e := json.MarshalIndent(out, "", "  ")
		must(e)
		must(os.WriteFile(dir+"/global-state.json", result, 0600))
	}
	return c
}
