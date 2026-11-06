package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	bn "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/backend/witness"
	"github.com/consensys/gnark/frontend"
	"math/big"
	"os"
	"path/filepath"
)

func exportArtifacts(dir string, vk groth16.VerifyingKey, proof groth16.Proof, public witness.Witness, assignment frontend.Circuit) {
	must(os.MkdirAll(filepath.Join(dir, "src"), 0755))
	must(os.MkdirAll(filepath.Join(dir, "test"), 0755))
	file, e := os.Create(filepath.Join(dir, "src", "Verifier.sol"))
	must(e)
	must(vk.ExportSolidity(file))
	must(file.Close())
	vector := public.Vector().(fr.Vector)
	values := make([]*big.Int, len(vector))
	for i := range vector {
		values[i] = new(big.Int)
		vector[i].BigInt(values[i])
	}
	var journal, funding []byte
	switch c := assignment.(type) {
	case *FundingCircuit:
		journal = fundingStatement(*c)
	case *PreparationCircuit:
		journal = preparationStatement(*c)
	case *OnlineCircuit:
		journal = onlineStatement(*c)
		funding = fundingStatement(c.Funding)
	}
	data, e := json.MarshalIndent(map[string]any{"proof": "0x" + hex.EncodeToString(proof.(*bn.Proof).MarshalSolidity()), "publicInputs": values, "journal": "0x" + hex.EncodeToString(journal), "fundingJournal": "0x" + hex.EncodeToString(funding)}, "", "  ")
	must(e)
	must(os.WriteFile(filepath.Join(dir, "proof.json"), data, 0644))
	writeVerifierTests(dir, len(values))
}

func writeVerifierTests(dir string, count int) {
	must(os.WriteFile(filepath.Join(dir, "foundry.toml"), []byte("[profile.default]\nsolc = \"0.8.26\"\noptimizer = true\noptimizer_runs = 200\nfs_permissions = [{ access = \"read\", path = \"./\" }]\n"), 0644))
	test := fmt.Sprintf(`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Verifier} from "../src/Verifier.sol";
interface Vm {function readFile(string calldata) external view returns(string memory);function parseJsonBytes(string calldata,string calldata) external pure returns(bytes memory);function parseJsonUintArray(string calldata,string calldata) external pure returns(uint256[] memory);}
contract VerifierTest {
 Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
 Verifier verifier; bytes proof; uint256[%d] inputs;
 event log_named_uint(string key,uint256 value);
 function setUp() public {verifier=new Verifier();string memory json=vm.readFile("proof.json");proof=vm.parseJsonBytes(json,".proof");uint256[] memory a=vm.parseJsonUintArray(json,".publicInputs");require(a.length==inputs.length);for(uint i;i<a.length;i++) inputs[i]=a[i];}
 function test_statementDigest() public view {string memory json=vm.readFile("proof.json");bytes32 h=keccak256(vm.parseJsonBytes(json,".journal"));require(inputs[0]==uint128(uint256(h)>>128)&&inputs[1]==uint128(uint256(h)),"journal digest");if(inputs.length==4){bytes32 f=keccak256(vm.parseJsonBytes(json,".fundingJournal"));uint256[] memory a=vm.parseJsonUintArray(json,".publicInputs");require(a[2]==uint128(uint256(f)>>128)&&a[3]==uint128(uint256(f)),"funding digest");}}
 function test_acceptRealProof() public {uint256 beforeGas=gasleft();verifier.verifyProof(proof,inputs);emit log_named_uint("verifier_call_gas",beforeGas-gasleft());}
 function test_rejectEveryChangedPublicInput() public view {for(uint i;i<inputs.length;i++){uint256[%d] memory a=inputs;a[i]++;(bool ok,)=address(verifier).staticcall(abi.encodeCall(verifier.verifyProof,(proof,a)));require(!ok,"changed public input accepted");}}
 function test_rejectChangedProof() public view {bytes memory p=proof;p[0]=bytes1(uint8(p[0])^1);(bool ok,)=address(verifier).staticcall(abi.encodeCall(verifier.verifyProof,(p,inputs)));require(!ok,"changed proof accepted");}
 function test_rejectTruncatedProof() public view {bytes memory p=new bytes(proof.length-1);for(uint i;i<p.length;i++)p[i]=proof[i];(bool ok,)=address(verifier).staticcall(abi.encodeCall(verifier.verifyProof,(p,inputs)));require(!ok,"truncated proof accepted");}
}
`, count, count)
	must(os.WriteFile(filepath.Join(dir, "test", "Verifier.t.sol"), []byte(test), 0644))
}

func regenerateVerifierTests(dir string) {
	data, e := os.ReadFile(filepath.Join(dir, "proof.json"))
	must(e)
	var artifact struct {
		PublicInputs []json.RawMessage `json:"publicInputs"`
	}
	must(json.Unmarshal(data, &artifact))
	if len(artifact.PublicInputs) != 2 && len(artifact.PublicInputs) != 4 {
		panic("unexpected input count")
	}
	writeVerifierTests(dir, len(artifact.PublicInputs))
}
