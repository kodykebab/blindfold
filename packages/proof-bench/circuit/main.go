package main

import (
	"encoding/json"
	"fmt"
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/backend/solidity"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
	"math/big"
	"os"
	"time"
)

func must(e error) {
	if e != nil {
		panic(e)
	}
}
func number(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 0)
	if !ok {
		panic("invalid integer")
	}
	return v
}
func bytes32(a [32]byte) (r [32]uints.U8) { copy(r[:], uints.NewU8Array(a[:])); return }
func fixture(path string) FundingCircuit {
	data, e := os.ReadFile(path)
	must(e)
	var raw []json.RawMessage
	must(json.Unmarshal(data, &raw))
	var online struct {
		Admission struct {
			Chain      uint64    `json:"chain_id"`
			Batch      uint64    `json:"batch"`
			Step       uint64    `json:"step"`
			Settlement [20]byte  `json:"settlement"`
			Owner      [20]byte  `json:"owner"`
			OldRoot    [32]byte  `json:"old_root"`
			NewRoot    [32]byte  `json:"new_root"`
			OrderHash  [32]byte  `json:"order_hash"`
			Budgets    [2]string `json:"budgets"`
		}
	}
	var witness struct {
		Order struct {
			Direction bool        `json:"zero_for_one"`
			Amount    json.Number `json:"amount"`
			Minimum   json.Number `json:"minimum"`
			Totals    [2]string   `json:"totals"`
			Salt      [32]byte    `json:"salt"`
			OldBlind  [32]byte    `json:"old_blind"`
			NewBlind  [32]byte    `json:"new_blind"`
		}
	}
	must(json.Unmarshal(raw[2], &online))
	must(json.Unmarshal(raw[3], &witness))
	s, w := online.Admission, witness.Order
	c := FundingCircuit{Chain: s.Chain, Batch: s.Batch, Step: s.Step, Direction: 0, Amount: number(string(w.Amount)), Minimum: number(string(w.Minimum)), OldRoot: bytes32(s.OldRoot), NewRoot: bytes32(s.NewRoot), OrderHash: bytes32(s.OrderHash), Salt: bytes32(w.Salt), OldBlind: bytes32(w.OldBlind), NewBlind: bytes32(w.NewBlind)}
	if w.Direction {
		c.Direction = 1
	}
	copy(c.Owner[:], uints.NewU8Array(s.Owner[:]))
	copy(c.Settlement[:], uints.NewU8Array(s.Settlement[:]))
	for i := 0; i < 2; i++ {
		c.Totals[i] = number(w.Totals[i])
		var buf [32]byte
		number(s.Budgets[i]).FillBytes(buf[:])
		c.Budgets[i] = bytes32(buf)
	}
	c.Digest = nativeStatementDigest(fundingStatement(c))
	return c
}
func main() {
	if len(os.Args) == 3 && os.Args[1] == "--export-tests" {
		regenerateVerifierTests(os.Args[2])
		return
	}
	if len(os.Args) == 4 && os.Args[1] == "--canonical-fixture" {
		canonicalFixture(os.Args[2], os.Args[3])
		fmt.Println("wrote synthetic canonical AGE fixture")
		return
	}
	var c, shape frontend.Circuit
	mode := "local_funding_component_groth16"
	if len(os.Args) == 3 && os.Args[1] == "--online" {
		assignment := onlineFixture(os.Args[2])
		c = &assignment
		shape = &OnlineCircuit{}
		mode = "local_online_groth16"
	} else if len(os.Args) == 3 && os.Args[1] == "--preparation" {
		assignment := preparationFixture(os.Args[2])
		c = &assignment
		shape = &PreparationCircuit{}
		mode = "local_preparation_groth16"
	} else if len(os.Args) == 2 {
		assignment := fixture(os.Args[1])
		c = &assignment
		shape = &FundingCircuit{}
	} else {
		panic("usage: circuitbench [--preparation|--online] fixture.json; --canonical-fixture source destination; --export-tests artifact-directory")
	}
	start := time.Now()
	cs, e := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, shape)
	must(e)
	compile := time.Since(start).Seconds()
	w, e := frontend.NewWitness(c, ecc.BN254.ScalarField())
	must(e)
	start = time.Now()
	pk, vk, e := groth16.Setup(cs)
	must(e)
	setup := time.Since(start).Seconds()
	start = time.Now()
	proof, e := groth16.Prove(cs, pk, w, solidity.WithProverTargetSolidityVerifier(backend.GROTH16))
	must(e)
	prove := time.Since(start).Seconds()
	public, e := w.Public()
	must(e)
	start = time.Now()
	must(groth16.Verify(proof, vk, public, solidity.WithVerifierTargetSolidityVerifier(backend.GROTH16)))
	verify := time.Since(start).Seconds()
	if dir := os.Getenv("CIRCUIT_OUTPUT"); dir != "" {
		exportArtifacts(dir, vk, proof, public, c)
	}
	switch assignment := c.(type) {
	case *FundingCircuit:
		assignment.NewRoot[0] = uints.NewU8(byte(number(fmt.Sprint(assignment.NewRoot[0].Val)).Uint64()) ^ 1)
		assignment.Digest = nativeStatementDigest(fundingStatement(*assignment))
	case *PreparationCircuit:
		assignment.Commitment[0] = uints.NewU8(byte(number(fmt.Sprint(assignment.Commitment[0].Val)).Uint64()) ^ 1)
		assignment.Digest = nativeStatementDigest(preparationStatement(*assignment))
	case *OnlineCircuit:
		assignment.CiphertextHash[0] = uints.NewU8(byte(number(fmt.Sprint(assignment.CiphertextHash[0].Val)).Uint64()) ^ 1)
		assignment.Digest = nativeStatementDigest(onlineStatement(*assignment))
	}
	bad, e := frontend.NewWitness(c, ecc.BN254.ScalarField())
	must(e)
	bp, e := bad.Public()
	must(e)
	if groth16.Verify(proof, vk, bp, solidity.WithVerifierTargetSolidityVerifier(backend.GROTH16)) == nil {
		panic("mutated public commitment accepted")
	}
	result := map[string]any{"mode": mode, "constraints": cs.GetNbConstraints(), "compile_s": compile, "setup_s": setup, "prove_s": prove, "verify_s": verify, "mutated_public_commitment_rejected": true, "setup": "ephemeral benchmark only"}
	if mode == "local_funding_component_groth16" {
		result["mutated_public_root_rejected"] = true
	}
	out, e := json.Marshal(result)
	must(e)
	fmt.Println(string(out))
}
