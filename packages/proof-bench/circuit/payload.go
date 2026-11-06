package main

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/hash/sha2"
	"github.com/consensys/gnark/std/math/emulated"
	"github.com/consensys/gnark/std/math/uints"
	"math/big"
)

func zeros(n int) []uints.U8 {
	r := make([]uints.U8, n)
	for i := range r {
		r[i] = uints.NewU8(0)
	}
	return r
}
func hmac256(api frontend.API, key, msg []uints.U8, length frontend.Variable) []uints.U8 {
	b, e := uints.NewBytes(api)
	must(e)
	inner, outer := zeros(64), zeros(64)
	for i := 0; i < 64; i++ {
		k := uints.NewU8(0)
		if i < len(key) {
			k = key[i]
		}
		inner[i] = b.Xor(k, uints.NewU8(0x36))
		outer[i] = b.Xor(k, uints.NewU8(0x5c))
	}
	h, e := sha2.New(api)
	must(e)
	h.Write(inner)
	h.Write(msg)
	var digest []uints.U8
	if length == nil {
		digest = h.Sum()
	} else {
		digest = h.FixedLengthSum(api.Add(64, length))
	}
	return sha256Circuit(api, outer, digest)
}
func hkdf32(api frontend.API, salt, key []uints.U8, label string) []uints.U8 {
	prk := hmac256(api, salt, key, nil)
	return hmac256(api, prk, append(uints.NewU8Array([]byte(label)), uints.NewU8(1)), nil)
}
func chachaBlock(api frontend.API, key []uints.U8, counter uint32) []uints.U8 {
	u, e := uints.New[uints.U32](api)
	must(e)
	var state [16]uints.U32
	for i, v := range []uint32{0x61707865, 0x3320646e, 0x79622d32, 0x6b206574} {
		state[i] = uints.NewU32(v)
	}
	for i := 0; i < 8; i++ {
		state[4+i] = u.PackLSB(key[i*4 : i*4+4]...)
	}
	state[12] = uints.NewU32(counter)
	state[13] = uints.NewU32(0)
	state[14] = uints.NewU32(0)
	state[15] = uints.NewU32(0x01000000) // final, first AGE chunk
	x := state
	qr := func(a, b, c, d int) {
		x[a] = u.Add(x[a], x[b])
		x[d] = u.Lrot(u.Xor(x[d], x[a]), 16)
		x[c] = u.Add(x[c], x[d])
		x[b] = u.Lrot(u.Xor(x[b], x[c]), 12)
		x[a] = u.Add(x[a], x[b])
		x[d] = u.Lrot(u.Xor(x[d], x[a]), 8)
		x[c] = u.Add(x[c], x[d])
		x[b] = u.Lrot(u.Xor(x[b], x[c]), 7)
	}
	for i := 0; i < 10; i++ {
		qr(0, 4, 8, 12)
		qr(1, 5, 9, 13)
		qr(2, 6, 10, 14)
		qr(3, 7, 11, 15)
		qr(0, 5, 10, 15)
		qr(1, 6, 11, 12)
		qr(2, 7, 8, 13)
		qr(3, 4, 9, 14)
	}
	out := make([]uints.U8, 0, 64)
	for i := range x {
		out = append(out, u.UnpackLSB(u.Add(x[i], state[i]))...)
	}
	return out
}

type polyField struct{}

func (polyField) NbLimbs() uint     { return 3 }
func (polyField) BitsPerLimb() uint { return 64 }
func (polyField) IsPrime() bool     { return true }
func (polyField) Modulus() *big.Int {
	return new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 130), big.NewInt(5))
}
func byteBitsLE(api frontend.API, b []uints.U8) []frontend.Variable {
	out := make([]frontend.Variable, 0, len(b)*8)
	for _, v := range b {
		out = append(out, api.ToBinary(v.Val, 8)...)
	}
	return out
}
func encryptPayload(api frontend.API, key, plaintext []uints.U8) []uints.U8 {
	b, e := uints.NewBytes(api)
	must(e)
	out := make([]uints.U8, len(plaintext))
	for off := 0; off < len(out); off += 64 {
		stream := chachaBlock(api, key, uint32(off/64+1))
		for i := 0; i < 64 && off+i < len(out); i++ {
			out[off+i] = b.Xor(plaintext[off+i], stream[i])
		}
	}
	oneTime := chachaBlock(api, key, 0)
	rBits := byteBitsLE(api, oneTime[:16])
	for _, i := range []int{28, 29, 30, 31, 60, 61, 62, 63, 92, 93, 94, 95, 124, 125, 126, 127, 32, 33, 64, 65, 96, 97} {
		rBits[i] = 0
	}
	f, e := emulated.NewField[polyField](api)
	must(e)
	r := f.FromBits(rBits...)
	acc := f.Zero()
	// Empty associated data; order payload is 160 bytes, already a multiple of 16.
	for off := 0; off < len(out); off += 16 {
		bits := append(byteBitsLE(api, out[off:off+16]), frontend.Variable(1))
		acc = f.Mul(f.Add(acc, f.FromBits(bits...)), r)
	}
	lengths := zeros(16)
	lengths[8] = uints.NewU8(byte(len(out)))
	lengths[9] = uints.NewU8(byte(len(out) >> 8))
	acc = f.Mul(f.Add(acc, f.FromBits(append(byteBitsLE(api, lengths), frontend.Variable(1))...)), r)
	a := f.ToBitsCanonical(acc)
	s := api.FromBinary(byteBitsLE(api, oneTime[16:32])...)
	low := api.FromBinary(a[:128]...)
	tagBits := api.ToBinary(api.Add(low, s), 129)
	for i := 0; i < 16; i++ {
		out = append(out, uints.U8{Val: api.FromBinary(tagBits[i*8 : i*8+8]...)})
	}
	return out
}
