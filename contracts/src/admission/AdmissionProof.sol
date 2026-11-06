// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPreparationVerifier {
    function verifyProof(bytes calldata seal, uint256[2] calldata inputs) external view;
}

interface IOnlineVerifier {
    function verifyProof(bytes calldata seal, uint256[4] calldata inputs) external view;
}

library AdmissionProof {
    error InvalidEncoding();
    error InvalidContext();

    bytes32 internal constant DOMAIN = keccak256("blindfold.prepared-key.v1");
    bytes32 internal constant NETWORK = keccak256(
        "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
        "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
    );

    struct Statement {
        bytes32 domain;
        uint256 chainId;
        address settlement;
        address owner;
        uint256 batch;
        uint256 round;
        bytes32 keyCommitment;
        bytes32 network;
        uint256 step;
        bytes32 oldRoot;
        bytes32 newRoot;
        uint256 budget0;
        uint256 budget1;
        bytes32 orderHash;
        bytes32 ciphertextHash;
    }

    struct Pair {
        bytes preparationSeal;
        bytes preparationJournal;
        bytes onlineSeal;
        bytes onlineJournal;
    }

    function decode(bytes calldata proof) internal pure returns (Pair memory p, Statement memory a) {
        (p.preparationSeal, p.preparationJournal, p.onlineSeal, p.onlineJournal) =
            abi.decode(proof, (bytes, bytes, bytes, bytes));
        if (
            p.preparationJournal.length != 256 || p.onlineJournal.length != 480 || p.preparationSeal.length != 384
                || p.onlineSeal.length != 384
                || keccak256(proof)
                    != keccak256(abi.encode(p.preparationSeal, p.preparationJournal, p.onlineSeal, p.onlineJournal))
        ) {
            revert InvalidEncoding();
        }
        a = abi.decode(p.onlineJournal, (Statement));
        if (
            a.domain != DOMAIN || a.network != NETWORK
                || keccak256(p.preparationJournal)
                    != keccak256(
                        abi.encode(
                            a.domain, a.chainId, a.settlement, a.owner, a.batch, a.round, a.keyCommitment, a.network
                        )
                    )
        ) revert InvalidContext();
    }

    function verify(Pair memory p, Statement memory a, address preparation, address online) internal view {
        bytes32 pd = keccak256(p.preparationJournal);
        bytes32 od = keccak256(p.onlineJournal);
        bytes32 fd = keccak256(
            abi.encode(
                a.chainId,
                a.settlement,
                a.owner,
                a.batch,
                a.step,
                a.oldRoot,
                a.newRoot,
                a.budget0,
                a.budget1,
                a.orderHash
            )
        );
        IPreparationVerifier(preparation)
            .verifyProof(p.preparationSeal, [uint256(uint128(uint256(pd) >> 128)), uint256(uint128(uint256(pd)))]);
        IOnlineVerifier(online)
            .verifyProof(
                p.onlineSeal,
                [
                    uint256(uint128(uint256(od) >> 128)),
                    uint256(uint128(uint256(od))),
                    uint256(uint128(uint256(fd) >> 128)),
                    uint256(uint128(uint256(fd)))
                ]
            );
    }
}
