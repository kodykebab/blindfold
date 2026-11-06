package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/consensys/gnark/std/math/uints"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/sha3"
)

func nativeU8(in []uints.U8) []byte {
	out := make([]byte, len(in))
	for i, b := range in {
		out[i] = byte(number(fmt.Sprint(b.Val)).Uint64())
	}
	return out
}
func nativeABI(v any) []byte { return number(fmt.Sprint(v)).FillBytes(make([]byte, 32)) }
func nativeHMAC(key, msg []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(msg)
	return h.Sum(nil)
}
func nativeHKDF(salt, key []byte, label string) []byte {
	return nativeHMAC(nativeHMAC(salt, key), append([]byte(label), 1))
}
func canonicalCiphertext(p PreparationCircuit, f FundingCircuit, nonce []byte) []byte {
	plain := append(make([]byte, 12), nativeU8(f.Owner[:])...)
	plain = append(plain, nativeABI(f.Direction)...)
	plain = append(plain, nativeABI(f.Amount)...)
	plain = append(plain, nativeABI(f.Minimum)...)
	plain = append(plain, nativeU8(f.Salt[:])...)
	return canonicalPlaintext(p, plain, nonce)
}
func canonicalPlaintext(p PreparationCircuit, plain, nonce []byte) []byte {
	body := base64.RawStdEncoding.EncodeToString(nativeU8(p.Wrapper[:]))
	header := fmt.Sprintf("age-encryption.org/v1\n-> tlock %v %s\n", p.Round, chainHash)
	for len(body) > 64 {
		header += body[:64] + "\n"
		body = body[64:]
	}
	header += body + "\n---"
	key := nativeU8(p.Key[:])
	mac := nativeHMAC(nativeHKDF(nil, key, "header"), []byte(header))
	out := append([]byte(header+" "+base64.RawStdEncoding.EncodeToString(mac)+"\n"), nonce...)
	aead, e := chacha20poly1305.New(nativeHKDF(nonce, key, "payload"))
	must(e)
	streamNonce := make([]byte, 12)
	streamNonce[11] = 1
	return append(out, aead.Seal(nil, streamNonce, plain, nil)...)
}
func integerBytes(b []byte) []int {
	out := make([]int, len(b))
	for i := range b {
		out[i] = int(b[i])
	}
	return out
}
func canonicalFixture(source, destination string) {
	p, f := preparationFixture(source), fixture(source)
	nonce := make([]byte, 16)
	_, e := rand.Read(nonce)
	must(e)
	ct := canonicalCiphertext(p, f, nonce)
	data, e := os.ReadFile(source)
	must(e)
	var raw []json.RawMessage
	must(json.Unmarshal(data, &raw))
	var online, witness map[string]json.RawMessage
	must(json.Unmarshal(raw[2], &online))
	must(json.Unmarshal(raw[3], &witness))
	var admission, order map[string]json.RawMessage
	must(json.Unmarshal(online["admission"], &admission))
	must(json.Unmarshal(witness["order"], &order))
	h := sha3.NewLegacyKeccak256()
	h.Write(ct)
	admission["ciphertext_hash"], e = json.Marshal(integerBytes(h.Sum(nil)))
	must(e)
	order["ciphertext"], e = json.Marshal(integerBytes(ct))
	must(e)
	online["admission"], e = json.Marshal(admission)
	must(e)
	witness["order"], e = json.Marshal(order)
	must(e)
	raw[2], e = json.Marshal(online)
	must(e)
	raw[3], e = json.Marshal(witness)
	must(e)
	data, e = json.MarshalIndent(raw, "", "  ")
	must(e)
	must(os.WriteFile(destination, append(data, '\n'), 0600))
}
func onlineFixture(path string) OnlineCircuit {
	p, f := preparationFixture(path), fixture(path)
	data, e := os.ReadFile(path)
	must(e)
	var raw []json.RawMessage
	must(json.Unmarshal(data, &raw))
	var online struct {
		Admission struct {
			CiphertextHash [32]byte `json:"ciphertext_hash"`
		}
	}
	var witness struct{ Order struct{ Ciphertext []byte } }
	must(json.Unmarshal(raw[2], &online))
	must(json.Unmarshal(raw[3], &witness))
	ct := witness.Order.Ciphertext
	if len(ct) < 192 {
		panic("short ciphertext")
	}
	c := OnlineCircuit{Funding: f, Round: p.Round, Commitment: p.Commitment, CiphertextHash: bytes32(online.Admission.CiphertextHash), Key: p.Key, Blind: p.Blind, Wrapper: p.Wrapper}
	copy(c.Nonce[:], uints.NewU8Array(ct[len(ct)-192:len(ct)-176]))
	digits := strconv.FormatUint(number(fmt.Sprint(p.Round)).Uint64(), 10)
	c.DigitCount = len(digits)
	for i := range c.Digits {
		c.Digits[i] = 0
		if i < len(digits) {
			c.Digits[i] = int(digits[i] - '0')
		}
	}
	c.Digest = nativeStatementDigest(onlineStatement(c))
	return c
}
