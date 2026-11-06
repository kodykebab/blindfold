package main

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"

	native "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fp"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/algebra/emulated/fields_bls12381"
	sw "github.com/consensys/gnark/std/algebra/emulated/sw_bls12381"
	"github.com/consensys/gnark/std/hash/sha2"
	"github.com/consensys/gnark/std/math/cmp"
	"github.com/consensys/gnark/std/math/emulated"
	"github.com/consensys/gnark/std/math/uints"
	"golang.org/x/crypto/sha3"
)

const chainHash = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
const publicKey = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
const quicknetDST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_"

// This fixed circuit accepts the first eight standard scalar-derivation candidates.
// If none succeeds, preparation must resample sigma; it cannot select a later candidate.
const scalarCandidates = 8

type PreparationCircuit struct {
	Digest              [2]frontend.Variable `gnark:",public"`
	Chain, Batch, Round frontend.Variable
	Settlement, Owner   [20]uints.U8
	Commitment          [32]uints.U8
	Key, Sigma          [16]uints.U8
	Blind               [32]uints.U8
	Wrapper             [128]uints.U8
}

func sha256Circuit(api frontend.API, parts ...[]uints.U8) []uints.U8 {
	h, e := sha2.New(api)
	must(e)
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum()
}
func constantHash(s string) []uints.U8 {
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte(s))
	return uints.NewU8Array(h.Sum(nil))
}
func bigBits(n *big.Int, width int) []frontend.Variable {
	r := make([]frontend.Variable, width)
	for i := range r {
		r[i] = n.Bit(i)
	}
	return r
}
func fieldBytes(api frontend.API, f *emulated.Field[emulated.BLS12381Fp], v *emulated.Element[emulated.BLS12381Fp]) []uints.U8 {
	bits := f.ToBitsCanonical(v)
	for len(bits) < 384 {
		bits = append(bits, 0)
	}
	out := make([]uints.U8, 48)
	for i := range out {
		out[47-i] = uints.U8{Val: api.FromBinary(bits[i*8 : (i+1)*8]...)}
	}
	return out
}
func (c *PreparationCircuit) Define(api frontend.API) error {
	bytes, e := uints.NewBytes(api)
	if e != nil {
		return e
	}
	round := word(api, c.Round, 64)
	api.AssertIsDifferent(c.Round, 0)
	digest := sha256Circuit(api, uints.NewU8Array([]byte("IBE-H3")), c.Sigma[:], c.Key[:])
	scalarBits := make([]frontend.Variable, 255)
	for i := range scalarBits {
		scalarBits[i] = 0
	}
	found := frontend.Variable(0)
	for counter := 1; counter <= scalarCandidates; counter++ {
		candidate := sha256Circuit(api, []uints.U8{uints.NewU8(byte(counter)), uints.NewU8(0)}, digest)
		bits := make([]frontend.Variable, 0, 256)
		for j := 31; j >= 0; j-- {
			b := api.ToBinary(candidate[j].Val, 8)
			if j == 0 {
				b = b[1:]
			} // standard tlock shifts the first byte right by one
			bits = append(bits, b...)
		}
		// The resulting scalar encoding has 255 bits.
		valid := cmp.IsLessOrEqualBinary(api, bits, bigBits(new(big.Int).Sub(fr.Modulus(), big.NewInt(1)), 255))
		take := api.Mul(api.Sub(1, found), valid)
		for j := range scalarBits {
			scalarBits[j] = api.Select(take, bits[j], scalarBits[j])
		}
		found = api.Or(found, valid)
	}
	api.AssertIsEqual(found, 1)
	sf, e := emulated.NewField[emulated.BLS12381Fr](api)
	if e != nil {
		return e
	}
	scalar := sf.FromBits(scalarBits...)
	// A zero scalar is excluded so compressed U has the ordinary finite-point form.
	sf.AssertIsDifferent(scalar, sf.Zero())
	g2, e := sw.NewG2(api)
	if e != nil {
		return e
	}
	_, _, _, generator := native.Generators()
	gen := sw.NewG2Affine(generator)
	u := g2.ScalarMul(&gen, scalar)
	f, e := emulated.NewField[emulated.BLS12381Fp](api)
	if e != nil {
		return e
	}
	ux := append(fieldBytes(api, f, &u.P.X.A1), fieldBytes(api, f, &u.P.X.A0)...)
	half := new(big.Int).Rsh(new(big.Int).Sub(fp.Modulus(), big.NewInt(1)), 1)
	positive := func(v *emulated.Element[emulated.BLS12381Fp]) frontend.Variable {
		bits := f.ToBitsCanonical(v)
		return api.Sub(1, cmp.IsLessOrEqualBinary(api, bits, bigBits(half, len(bits))))
	}
	sign := api.Select(f.IsZero(&u.P.Y.A1), positive(&u.P.Y.A0), positive(&u.P.Y.A1))
	ux[0] = uints.U8{Val: api.Add(ux[0].Val, 128, api.Mul(32, sign))}
	for i := range ux {
		bytes.AssertIsEqual(ux[i], c.Wrapper[i])
	}
	pkBytes, e := hex.DecodeString(publicKey)
	if e != nil {
		return e
	}
	var pk native.G2Affine
	if _, e = pk.SetBytes(pkBytes); e != nil {
		return e
	}
	master := sw.NewG2Affine(pk)
	rpk := g2.ScalarMul(&master, scalar)
	g1, e := sw.NewG1(api)
	if e != nil {
		return e
	}
	q, e := g1.HashToG1(sha256Circuit(api, round[24:]), []byte(quicknetDST))
	if e != nil {
		return e
	}
	pairing, e := sw.NewPairing(api)
	if e != nil {
		return e
	}
	shared, e := pairing.Pair([]*sw.G1Affine{q}, []*sw.G2Affine{rpk})
	if e != nil {
		return e
	}
	tower := fields_bls12381.NewExt12(api).ToTower(shared)
	encoded := make([]uints.U8, 0, 576)
	for i := 11; i >= 0; i-- {
		encoded = append(encoded, fieldBytes(api, f, tower[i])...)
	}
	h2 := sha256Circuit(api, uints.NewU8Array([]byte("IBE-H2")), encoded)
	h4 := sha256Circuit(api, uints.NewU8Array([]byte("IBE-H4")), c.Sigma[:])
	for i := 0; i < 16; i++ {
		bytes.AssertIsEqual(c.Wrapper[96+i], bytes.Xor(c.Sigma[i], h2[i]))
		bytes.AssertIsEqual(c.Wrapper[112+i], bytes.Xor(c.Key[i], h4[i]))
	}
	wh, e := hash(api, c.Wrapper[:])
	if e != nil {
		return e
	}
	commitment, e := hash(api, constantHash("blindfold.prepared-key.v1"), word(api, c.Chain, 64), address(c.Settlement), address(c.Owner), word(api, c.Batch, 64), round, constantHash(chainHash), constantHash(publicKey), wh, c.Key[:], c.Blind[:])
	if e != nil {
		return e
	}
	for i := range commitment {
		bytes.AssertIsEqual(commitment[i], c.Commitment[i])
	}
	return bindStatement(api, c.Digest, constantHash("blindfold.prepared-key.v1"), word(api, c.Chain, 64), address(c.Settlement), address(c.Owner), word(api, c.Batch, 64), round, c.Commitment[:], constantHash(chainHash+publicKey))
}
func preparationFixture(path string) PreparationCircuit {
	data, e := os.ReadFile(path)
	must(e)
	var raw []json.RawMessage
	must(json.Unmarshal(data, &raw))
	var p struct {
		Context struct {
			Chain      fixtureUint64 `json:"chain_id"`
			Batch      fixtureUint64 `json:"batch"`
			Round      fixtureUint64 `json:"round"`
			Owner      [20]byte      `json:"owner"`
			Settlement [20]byte      `json:"settlement"`
		}
		Commitment [32]byte
	}
	var w struct {
		Key     [16]byte
		Sigma   [16]byte
		Blind   [32]byte
		Wrapper []byte
	}
	must(json.Unmarshal(raw[0], &p))
	must(json.Unmarshal(raw[1], &w))
	if len(w.Wrapper) != 128 {
		panic("wrapper length")
	}
	c := PreparationCircuit{Chain: uint64(p.Context.Chain), Batch: uint64(p.Context.Batch), Round: uint64(p.Context.Round), Commitment: bytes32(p.Commitment), Blind: bytes32(w.Blind)}
	copy(c.Owner[:], uints.NewU8Array(p.Context.Owner[:]))
	copy(c.Settlement[:], uints.NewU8Array(p.Context.Settlement[:]))
	copy(c.Key[:], uints.NewU8Array(w.Key[:]))
	copy(c.Sigma[:], uints.NewU8Array(w.Sigma[:]))
	copy(c.Wrapper[:], uints.NewU8Array(w.Wrapper))
	c.Digest = nativeStatementDigest(preparationStatement(c))
	return c
}
