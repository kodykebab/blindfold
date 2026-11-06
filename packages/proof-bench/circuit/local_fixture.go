package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"

	bls "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
	"github.com/consensys/gnark/std/math/uints"
)

type localRequest struct {
	ChainID    string    `json:"chainId"`
	Settlement string    `json:"settlement"`
	Owner      string    `json:"owner"`
	Batch      string    `json:"batch"`
	Round      string    `json:"round"`
	Step       string    `json:"step"`
	Totals     [2]string `json:"totals"`
	Budgets    [2]string `json:"budgets"`
	OldBlind   string    `json:"oldBlind"`
	ZeroForOne bool      `json:"zeroForOne"`
	Amount     string    `json:"amount"`
	Minimum    string    `json:"minimum"`
	Salt       string    `json:"salt"`
}

func bounded(s string, bits int) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 || v.BitLen() > bits {
		panic("integer outside supported domain")
	}
	return v
}
func fixedHex(s string, n int) []byte {
	if !strings.HasPrefix(s, "0x") {
		panic("hex must have 0x prefix")
	}
	b, e := hex.DecodeString(s[2:])
	must(e)
	if len(b) != n {
		panic("wrong hex length")
	}
	return b
}
func randomBytes(n int) []byte         { b := make([]byte, n); _, e := rand.Read(b); must(e); return b }
func hashParts(parts ...[]byte) []byte { return nativeHashBytes(string(concatBytes(parts...))) }

// Standard quicknet IBE wrapper; byte serialization is independently checked against Rust fixtures.
func quicknetWrapper(round uint64, key, sigma []byte) ([]byte, bool) {
	digest := sha256.Sum256(concatBytes([]byte("IBE-H3"), sigma, key))
	var scalar *big.Int
	for i := 1; i <= scalarCandidates; i++ {
		c := sha256.Sum256(concatBytes([]byte{byte(i), 0}, digest[:]))
		c[0] >>= 1
		v := new(big.Int).SetBytes(c[:])
		if v.Cmp(fr.Modulus()) < 0 {
			scalar = v
			break
		}
	}
	if scalar == nil || scalar.Sign() == 0 {
		return nil, false
	}
	var u, pk, rpk bls.G2Affine
	u.ScalarMultiplicationBase(scalar)
	pkBytes, e := hex.DecodeString(publicKey)
	must(e)
	_, e = pk.SetBytes(pkBytes)
	must(e)
	rpk.ScalarMultiplication(&pk, scalar)
	var rb [8]byte
	binary.BigEndian.PutUint64(rb[:], round)
	rh := sha256.Sum256(rb[:])
	q, e := bls.HashToG1(rh[:], []byte(quicknetDST))
	must(e)
	gt, e := bls.Pair([]bls.G1Affine{q}, []bls.G2Affine{rpk})
	must(e)
	encoded := gt.Bytes()
	h2 := sha256.Sum256(concatBytes([]byte("IBE-H2"), encoded[:]))
	h4 := sha256.Sum256(concatBytes([]byte("IBE-H4"), sigma))
	ub := u.Bytes()
	out := append([]byte{}, ub[:]...)
	for i := 0; i < 16; i++ {
		out = append(out, sigma[i]^h2[i])
	}
	for i := 0; i < 16; i++ {
		out = append(out, key[i]^h4[i])
	}
	return out, true
}
func localFixture(r localRequest) []any {
	chain, batch, round, step := bounded(r.ChainID, 64), bounded(r.Batch, 64), bounded(r.Round, 64), bounded(r.Step, 6)
	if round.Sign() == 0 {
		panic("zero round")
	}
	settlement, owner := fixedHex(r.Settlement, 20), fixedHex(r.Owner, 20)
	amount, minimum := bounded(r.Amount, 128), bounded(r.Minimum, 128)
	totals := [2]*big.Int{bounded(r.Totals[0], 134), bounded(r.Totals[1], 134)}
	budgets := [2]*big.Int{bounded(r.Budgets[0], 256), bounded(r.Budgets[1], 256)}
	oldBlind := fixedHex(r.OldBlind, 32)
	salt := fixedHex(r.Salt, 32)
	if step.Sign() == 0 && (totals[0].Sign() != 0 || totals[1].Sign() != 0 || new(big.Int).SetBytes(oldBlind).Sign() != 0) {
		panic("noncanonical initial state")
	}
	next := [2]*big.Int{new(big.Int).Set(totals[0]), new(big.Int).Set(totals[1])}
	direction := 0
	idx := 1
	if r.ZeroForOne {
		direction = 1
		idx = 0
	}
	next[idx].Add(next[idx], amount)
	for i := range next {
		if next[i].Cmp(budgets[i]) > 0 {
			panic("cumulative private input exceeds budget")
		}
	}
	key, blind, newBlind, nonce := randomBytes(16), randomBytes(32), randomBytes(32), randomBytes(16)
	var sigma, wrapper []byte
	for {
		sigma = randomBytes(16)
		var ok bool
		wrapper, ok = quicknetWrapper(round.Uint64(), key, sigma)
		if ok {
			break
		}
	}
	addr := func(b []byte) []byte { return append(make([]byte, 12), b...) }
	commitment := hashParts(nativeHashBytes("blindfold.prepared-key.v1"), nativeABI(chain), addr(settlement), addr(owner), nativeABI(batch), nativeABI(round), nativeHashBytes(chainHash), nativeHashBytes(publicKey), hashParts(wrapper), key, blind)
	orderHash := hashParts(nativeABI(chain), addr(settlement), nativeABI(batch), addr(owner), nativeABI(direction), nativeABI(amount), nativeABI(minimum), salt)
	oldRoot := make([]byte, 32)
	if step.Sign() != 0 {
		oldRoot = hashParts(nativeABI(chain), addr(settlement), addr(owner), nativeABI(batch), nativeABI(totals[0]), nativeABI(totals[1]), oldBlind, nativeABI(step))
	}
	newRoot := hashParts(nativeABI(chain), addr(settlement), addr(owner), nativeABI(batch), nativeABI(next[0]), nativeABI(next[1]), newBlind, nativeABI(new(big.Int).Add(step, big.NewInt(1))))
	prep := map[string]any{"context": map[string]any{"chain_id": chain.String(), "settlement": integerBytes(settlement), "owner": integerBytes(owner), "batch": batch.String(), "round": round.String()}, "commitment": integerBytes(commitment)}
	privatePrep := map[string]any{"key": integerBytes(key), "sigma": integerBytes(sigma), "blind": integerBytes(blind), "wrapper": integerBytes(wrapper)}
	admission := map[string]any{"chain_id": chain.String(), "settlement": integerBytes(settlement), "owner": integerBytes(owner), "batch": batch.String(), "step": step.String(), "old_root": integerBytes(oldRoot), "new_root": integerBytes(newRoot), "budgets": r.Budgets, "order_hash": integerBytes(orderHash)}
	order := map[string]any{"zero_for_one": r.ZeroForOne, "amount": r.Amount, "minimum": r.Minimum, "totals": r.Totals, "salt": integerBytes(salt), "old_blind": integerBytes(oldBlind), "new_blind": integerBytes(newBlind)}
	// Build the same canonical AGE payload as the circuit, without temporary witness files.
	p := PreparationCircuit{Round: round}
	copyU8(p.Key[:], key)
	copyU8(p.Wrapper[:], wrapper)
	f := FundingCircuit{Direction: direction, Amount: amount, Minimum: minimum}
	copyU8(f.Owner[:], owner)
	copyU8(f.Salt[:], salt)
	ct := canonicalCiphertext(p, f, nonce)
	admission["ciphertext_hash"] = integerBytes(hashParts(ct))
	order["ciphertext"] = integerBytes(ct)
	return []any{prep, privatePrep, map[string]any{"admission": admission}, map[string]any{"order": order}}
}
func fixtureCommand() {
	var r localRequest
	d := json.NewDecoder(os.Stdin)
	d.DisallowUnknownFields()
	must(d.Decode(&r))
	must(json.NewEncoder(os.Stdout).Encode(localFixture(r)))
}

func copyU8(dst []uints.U8, src []byte) { copy(dst, uints.NewU8Array(src)) }

// Existing numeric fixtures remain readable; new CLI fixtures quote integers for lossless JavaScript transport.
type fixtureUint64 uint64

func (v *fixtureUint64) UnmarshalJSON(data []byte) error {
	s := string(data)
	if len(s) > 0 && s[0] == '"' {
		if e := json.Unmarshal(data, &s); e != nil {
			return e
		}
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok || n.Sign() < 0 || n.BitLen() > 64 {
		return fmt.Errorf("invalid uint64 fixture value")
	}
	*v = fixtureUint64(n.Uint64())
	return nil
}
