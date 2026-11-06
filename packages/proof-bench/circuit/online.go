package main

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/hash/sha3"
	"github.com/consensys/gnark/std/math/cmp"
	"github.com/consensys/gnark/std/math/uints"
	"math/big"
)

// OnlineCircuit accepts the canonical single-recipient AGE encoding produced below.
// The complete ciphertext is constructed in-circuit and bound by its Keccak digest.
type OnlineCircuit struct {
	Digest                     [2]frontend.Variable `gnark:",public"`
	Funding                    FundingCircuit
	Round                      frontend.Variable
	Commitment, CiphertextHash [32]uints.U8
	Key                        [16]uints.U8
	Blind                      [32]uints.U8
	Wrapper                    [128]uints.U8
	Nonce                      [16]uints.U8
	Digits                     [20]frontend.Variable
	DigitCount                 frontend.Variable
}

func base64Circuit(api frontend.API, in []uints.U8) []uints.U8 {
	bits := make([]frontend.Variable, 0, len(in)*8)
	for _, b := range in {
		lsb := api.ToBinary(b.Val, 8)
		for j := 7; j >= 0; j-- {
			bits = append(bits, lsb[j])
		}
	}
	for len(bits)%6 != 0 {
		bits = append(bits, 0)
	}
	out := make([]uints.U8, len(bits)/6)
	for i := range out {
		var lsb [6]frontend.Variable
		for j := 0; j < 6; j++ {
			lsb[j] = bits[i*6+5-j]
		}
		v := api.FromBinary(lsb[:]...)
		le := func(n int64) frontend.Variable {
			return cmp.IsLessOrEqualBinary(api, lsb[:], bigBits(big.NewInt(n), 6))
		}
		value := api.Select(le(25), api.Add(v, 65), api.Select(le(51), api.Add(v, 71), api.Select(le(61), api.Sub(v, 4), api.Select(api.IsZero(api.Sub(v, 62)), 43, 47))))
		out[i] = uints.U8{Val: value}
	}
	return out
}
func selectEncoding(api frontend.API, choices []frontend.Variable, encodings [][]uints.U8) []uints.U8 {
	out := zeros(len(encodings[len(encodings)-1]))
	for k, encoding := range encodings {
		for i, b := range encoding {
			out[i].Val = api.Add(out[i].Val, api.Mul(choices[k], b.Val))
		}
	}
	return out
}
func (c *OnlineCircuit) Define(api frontend.API) error {
	if e := c.Funding.Define(api); e != nil {
		return e
	}
	f := &c.Funding
	plaintext := append(address(f.Owner), word(api, f.Direction, 1)...)
	plaintext = append(plaintext, word(api, f.Amount, 128)...)
	plaintext = append(plaintext, word(api, f.Minimum, 128)...)
	plaintext = append(plaintext, f.Salt[:]...)
	if e := c.ciphertextRelation(api, plaintext); e != nil {
		return e
	}
	round := word(api, c.Round, 64)
	return bindStatement(api, c.Digest, constantHash("blindfold.prepared-key.v1"), word(api, f.Chain, 64), address(f.Settlement), address(f.Owner), word(api, f.Batch, 64), round, c.Commitment[:], constantHash(chainHash+publicKey), word(api, f.Step, 6), f.OldRoot[:], f.NewRoot[:], f.Budgets[0][:], f.Budgets[1][:], f.OrderHash[:], c.CiphertextHash[:])
}

// Shared canonical AGE relation; global and pair orders differ only in plaintext and public statements.
func (c *OnlineCircuit) ciphertextRelation(api frontend.API, plaintext []uints.U8) error {
	f := &c.Funding
	b, e := uints.NewBytes(api)
	if e != nil {
		return e
	}
	round := word(api, c.Round, 64)
	api.AssertIsDifferent(c.Round, 0)
	wh, e := hash(api, c.Wrapper[:])
	if e != nil {
		return e
	}
	commitment, e := hash(api, constantHash("blindfold.prepared-key.v1"), word(api, f.Chain, 64), address(f.Settlement), address(f.Owner), word(api, f.Batch, 64), round, constantHash(chainHash), constantHash(publicKey), wh, c.Key[:], c.Blind[:])
	if e != nil {
		return e
	}
	for i := range commitment {
		b.AssertIsEqual(commitment[i], c.Commitment[i])
	}
	choices := make([]frontend.Variable, 20)
	sum := frontend.Variable(0)
	value := frontend.Variable(0)
	selected := frontend.Variable(0)
	for i, d := range c.Digits {
		api.ToBinary(d, 4)
		api.AssertIsLessOrEqual(d, 9)
		choices[i] = api.IsZero(api.Sub(c.DigitCount, i+1))
		sum = api.Add(sum, choices[i])
		value = api.Add(api.Mul(value, 10), d)
		selected = api.Add(selected, api.Mul(choices[i], value))
	}
	api.AssertIsEqual(sum, 1)
	api.AssertIsDifferent(c.Digits[0], 0)
	api.AssertIsEqual(selected, c.Round)
	wrapped := base64Circuit(api, c.Wrapper[:])
	body := make([]uints.U8, 0, 174)
	for i, v := range wrapped {
		body = append(body, v)
		if (i+1)%64 == 0 {
			body = append(body, uints.NewU8('\n'))
		}
	}
	body = append(body, uints.NewU8('\n'))
	headers := make([][]uints.U8, 20)
	for d := 1; d <= 20; d++ {
		h := uints.NewU8Array([]byte("age-encryption.org/v1\n-> tlock "))
		for i := 0; i < d; i++ {
			h = append(h, uints.U8{Val: api.Add(c.Digits[i], 48)})
		}
		h = append(h, uints.NewU8Array([]byte(" "+chainHash+"\n"))...)
		h = append(h, body...)
		h = append(h, uints.NewU8Array([]byte("---"))...)
		headers[d-1] = h
	}
	header := selectEncoding(api, choices, headers)
	headerLength := api.Add(len(headers[0])-1, c.DigitCount)
	headerKey := hkdf32(api, nil, c.Key[:], "header")
	mac := base64Circuit(api, hmac256(api, headerKey, header, headerLength))
	payloadKey := hkdf32(api, c.Nonce[:], c.Key[:], "payload")
	payload := encryptPayload(api, payloadKey, plaintext)
	encodings := make([][]uints.U8, 20)
	for i, h := range headers {
		ct := append([]uints.U8{}, h...)
		ct = append(ct, uints.NewU8(' '))
		ct = append(ct, mac...)
		ct = append(ct, uints.NewU8('\n'))
		ct = append(ct, c.Nonce[:]...)
		ct = append(ct, payload...)
		encodings[i] = ct
	}
	ciphertext := selectEncoding(api, choices, encodings)
	length := api.Add(len(encodings[0])-1, c.DigitCount)
	digest, e := sha3.NewLegacyKeccak256(api)
	if e != nil {
		return e
	}
	digest.Write(ciphertext)
	computed := digest.FixedLengthSum(length)
	for i := range computed {
		b.AssertIsEqual(computed[i], c.CiphertextHash[i])
	}
	return nil
}
