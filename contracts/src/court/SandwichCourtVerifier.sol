// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RLPReader} from "./lib/RLPReader.sol";
import {MerkleTrie} from "./lib/MerkleTrie.sol";
import {Bytes} from "./lib/Bytes.sol";

interface IL1Block {
    function number() external view returns (uint64);
    function hash() external view returns (bytes32);
}

/// @title SandwichCourtVerifier
/// @notice Proves a Uniswap v3 or v4 sandwich fully onchain, from a block header:
///         1. the header hashes to a known block hash: BLOCKHASH, the EIP-2935 history contract, or (on an
///            OP-stack L2 such as Base) a checkpointed L1Block hash plus account+storage proofs of L1's
///            EIP-2935 contract (the "L1 anchor");
///         2. front, victim and back txs are proven into the tx trie at indices j < i < k, and their signers
///            are recovered onchain (legacy, EIP-155 and typed txs 1-4);
///         3. their receipts are proven into the receipt trie, and one Swap log per receipt (by index hint)
///            is decoded for the claimed pool;
///         4. the sandwich predicate: same pool, front and victim trade the same direction, back trades the
///            opposite way and closes the front position, front signer == back signer != victim signer,
///            and the attacker's net in its start token is positive.
contract SandwichCourtVerifier {
    using RLPReader for RLPReader.RLPItem;

    address public constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935; // EIP-2935
    uint256 public constant HISTORY_WINDOW = 8191;
    uint256 public constant CLOSE_TOLERANCE_BPS = 100; // back-leg input within 1% of front-leg output

    bytes32 public constant V3_SWAP = keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)");
    bytes32 public constant V4_SWAP = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    error UnknownBlock(uint256 number);
    error HeaderMismatch();
    error BadAnchor();
    error OutsideHistoryWindow(uint256 target, uint256 anchor);
    error BadOrder();
    error TxFailed(uint256 index);
    error NoSwapLog(uint256 index);
    error BadSignature(uint256 index);
    error NotSandwich(uint8 reason);

    event Checkpointed(uint256 indexed l1Number, bytes32 l1Hash);

    struct Leg {
        uint256 index;
        bytes rawTx;
        bytes[] txProof;
        bytes[] receiptProof;
        uint256 logIndex;
    }

    /// @dev Empty `header` = no anchor: the target block's hash is read locally.
    struct Anchor {
        bytes header;
        bytes[] accountProof;
        bytes[] storageProof;
    }

    struct Claim {
        bytes header;
        Leg front;
        Leg victim;
        Leg back;
        bool v4;
        address pool; // v3: the pool; v4: the PoolManager (log emitter)
        bytes32 poolId; // v4 only
        Anchor anchor;
    }

    struct Verdict {
        uint256 blockNumber;
        bytes32 blockHash;
        bytes32 victimTxHash;
        address attacker;
        address victim;
        bool profitInToken0;
        uint256 profit;
        uint256 frontIn; // what the front leg paid into the pool, in the profit token, swap fee included
    }

    struct Swap {
        address trader; // v3 recipient / v4 sender
        int256 amount0; // pool side: positive = paid into the pool
        int256 amount1;
    }

    struct Header {
        bytes32 hash;
        uint256 number;
        bytes32 stateRoot;
        bytes32 txRoot;
        bytes32 receiptRoot;
    }

    IL1Block public immutable l1Block; // 0x4200...0015 on OP-stack chains; address(0) on L1
    mapping(uint256 l1Number => bytes32 l1Hash) public checkpoints;

    constructor(IL1Block l1Block_) {
        l1Block = l1Block_;
    }

    /// @notice Permissionless: store the L1 block hash the L2 currently knows, for anchored claims.
    function checkpoint() external returns (uint256 n, bytes32 h) {
        n = l1Block.number();
        h = l1Block.hash();
        checkpoints[n] = h;
        emit Checkpointed(n, h);
    }

    function verify(Claim calldata c) external view returns (Verdict memory v) {
        Header memory h = _header(c.header);
        bytes32 known = c.anchor.header.length == 0 ? _localHash(h.number) : _anchoredHash(h.number, c.anchor);
        if (known != h.hash) revert HeaderMismatch();
        if (!(c.front.index < c.victim.index && c.victim.index < c.back.index)) revert BadOrder();

        Swap memory f = _swapOf(c.front, c, h);
        Swap memory vs = _swapOf(c.victim, c, h);
        Swap memory b = _swapOf(c.back, c, h);

        address fSigner = _proveAndRecover(c.front, h.txRoot);
        address vSigner = _proveAndRecover(c.victim, h.txRoot);
        address bSigner = _proveAndRecover(c.back, h.txRoot);

        (bool z, uint256 profit, uint256 frontIn) = _predicate(f, vs, b);
        if (fSigner != bSigner) revert NotSandwich(6);
        if (vSigner == fSigner) revert NotSandwich(7);

        v = Verdict({
            blockNumber: h.number,
            blockHash: h.hash,
            victimTxHash: keccak256(c.victim.rawTx),
            attacker: fSigner,
            victim: vSigner,
            profitInToken0: z,
            profit: profit,
            frontIn: frontIn
        });
    }

    // ---- 1. block hash

    function _header(bytes calldata raw) internal pure returns (Header memory h) {
        RLPReader.RLPItem[] memory f = RLPReader.readList(raw);
        h.hash = keccak256(raw);
        h.stateRoot = bytes32(RLPReader.readBytes(f[3]));
        h.txRoot = bytes32(RLPReader.readBytes(f[4]));
        h.receiptRoot = bytes32(RLPReader.readBytes(f[5]));
        h.number = _toUint(RLPReader.readBytes(f[8]));
    }

    function _localHash(uint256 n) internal view returns (bytes32 bh) {
        bh = blockhash(n);
        if (bh != 0) return bh;
        if (n >= block.number || block.number - n > HISTORY_WINDOW) revert UnknownBlock(n);
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(n));
        if (!ok || ret.length != 32) revert UnknownBlock(n);
        bh = abi.decode(ret, (bytes32));
    }

    function _anchoredHash(uint256 target, Anchor calldata a) internal view returns (bytes32) {
        Header memory ah = _header(a.header);
        bytes32 cp = checkpoints[ah.number];
        if (cp == 0 || cp != ah.hash) revert BadAnchor();
        if (target >= ah.number || ah.number - target > HISTORY_WINDOW) revert OutsideHistoryWindow(target, ah.number);

        bytes memory account =
            MerkleTrie.get(abi.encodePacked(keccak256(abi.encodePacked(HISTORY))), a.accountProof, ah.stateRoot);
        bytes32 storageRoot = bytes32(RLPReader.readBytes(RLPReader.readList(account)[2]));
        bytes memory slotValue = MerkleTrie.get(
            abi.encodePacked(keccak256(abi.encode(target % HISTORY_WINDOW))), a.storageProof, storageRoot
        );
        return bytes32(_toUint(RLPReader.readBytes(slotValue)));
    }

    // ---- 2. txs and signers

    function _proveAndRecover(Leg calldata leg, bytes32 txRoot) internal pure returns (address) {
        bytes memory value = MerkleTrie.get(_rlpIndex(leg.index), leg.txProof, txRoot);
        if (keccak256(value) != keccak256(leg.rawTx)) revert NotSandwich(8);
        return _recover(leg.rawTx, leg.index);
    }

    function _recover(bytes memory raw, uint256 index) internal pure returns (address signer) {
        bytes memory payload;
        uint256 yParity;
        bytes32 r;
        bytes32 s;
        if (uint8(raw[0]) >= 0xc0) {
            RLPReader.RLPItem[] memory it = RLPReader.readList(raw);
            uint256 v = _toUint(RLPReader.readBytes(it[6]));
            r = bytes32(_toUint(RLPReader.readBytes(it[7])));
            s = bytes32(_toUint(RLPReader.readBytes(it[8])));
            bytes memory body = _concatRaw(it, 6);
            if (v == 27 || v == 28) {
                yParity = v - 27;
            } else {
                uint256 chainId = (v - 35) / 2;
                yParity = (v - 35) % 2;
                body = bytes.concat(body, _rlpUint(chainId), hex"8080");
            }
            payload = _wrapList(body);
        } else {
            RLPReader.RLPItem[] memory it = RLPReader.readList(Bytes.slice(raw, 1));
            uint256 n = it.length;
            yParity = _toUint(RLPReader.readBytes(it[n - 3]));
            r = bytes32(_toUint(RLPReader.readBytes(it[n - 2])));
            s = bytes32(_toUint(RLPReader.readBytes(it[n - 1])));
            payload = bytes.concat(raw[0], _wrapList(_concatRaw(it, n - 3)));
        }
        signer = ecrecover(keccak256(payload), uint8(27 + yParity), r, s);
        if (signer == address(0)) revert BadSignature(index);
    }

    // ---- 3. receipts and Swap logs

    function _swapOf(Leg calldata leg, Claim calldata c, Header memory h) internal pure returns (Swap memory sw) {
        bytes memory value = MerkleTrie.get(_rlpIndex(leg.index), leg.receiptProof, h.receiptRoot);
        if (uint8(value[0]) < 0x80) value = Bytes.slice(value, 1); // typed receipt
        RLPReader.RLPItem[] memory rc = RLPReader.readList(value);
        if (_toUint(RLPReader.readBytes(rc[0])) != 1) revert TxFailed(leg.index);

        RLPReader.RLPItem[] memory logs = RLPReader.readList(rc[3]);
        if (leg.logIndex >= logs.length) revert NoSwapLog(leg.index);
        RLPReader.RLPItem[] memory lg = RLPReader.readList(logs[leg.logIndex]);
        if (address(bytes20(RLPReader.readBytes(lg[0]))) != c.pool) revert NoSwapLog(leg.index);
        RLPReader.RLPItem[] memory topics = RLPReader.readList(lg[1]);
        bytes memory data = RLPReader.readBytes(lg[2]);
        if (topics.length < 3) revert NoSwapLog(leg.index);

        bytes32 t0 = bytes32(RLPReader.readBytes(topics[0]));
        if (c.v4) {
            if (t0 != V4_SWAP || bytes32(RLPReader.readBytes(topics[1])) != c.poolId) revert NoSwapLog(leg.index);
            sw.trader = address(uint160(uint256(bytes32(RLPReader.readBytes(topics[2])))));
            (int128 a0, int128 a1) = abi.decode(data, (int128, int128));
            // v4 emits swapper-side deltas (negative = paid in); convert to the v3 pool-side convention
            sw.amount0 = -int256(a0);
            sw.amount1 = -int256(a1);
        } else {
            if (t0 != V3_SWAP) revert NoSwapLog(leg.index);
            sw.trader = address(uint160(uint256(bytes32(RLPReader.readBytes(topics[2])))));
            (sw.amount0, sw.amount1) = abi.decode(data, (int256, int256));
        }
    }

    // ---- 4. predicate

    /// @return z true if the attacker starts (and profits) in token0
    function _predicate(Swap memory f, Swap memory v, Swap memory b)
        internal
        pure
        returns (bool z, uint256 profit, uint256 frontIn)
    {
        z = f.amount0 > 0; // front pays token0 into the pool
        if ((v.amount0 > 0) != z) revert NotSandwich(1); // victim trades the same direction
        if ((b.amount0 > 0) == z) revert NotSandwich(1); // back trades the opposite direction
        if (f.trader != b.trader || f.trader == v.trader) revert NotSandwich(4);

        // tokens the front leg bought vs. what the back leg sold
        uint256 bought = uint256(-(z ? f.amount1 : f.amount0));
        uint256 sold = uint256(z ? b.amount1 : b.amount0);
        uint256 diff = bought > sold ? bought - sold : sold - bought;
        if (diff * 10_000 > bought * CLOSE_TOLERANCE_BPS) revert NotSandwich(2);

        int256 spent = z ? f.amount0 : f.amount1;
        int256 got = -(z ? b.amount0 : b.amount1);
        if (spent <= 0 || got <= spent) revert NotSandwich(3);
        profit = uint256(got - spent);
        frontIn = uint256(spent);
    }

    // ---- RLP helpers

    function _toUint(bytes memory b) internal pure returns (uint256 x) {
        require(b.length <= 32, "uint");
        for (uint256 i; i < b.length; i++) x = (x << 8) | uint8(b[i]);
    }

    function _rlpUint(uint256 x) internal pure returns (bytes memory) {
        if (x == 0) return hex"80";
        if (x < 0x80) return abi.encodePacked(uint8(x));
        bytes memory be = _bigEndian(x);
        return bytes.concat(bytes1(uint8(0x80 + be.length)), be);
    }

    function _rlpIndex(uint256 i) internal pure returns (bytes memory) {
        return _rlpUint(i);
    }

    function _bigEndian(uint256 x) internal pure returns (bytes memory out) {
        uint256 n;
        for (uint256 t = x; t != 0; t >>= 8) n++;
        out = new bytes(n);
        for (uint256 i; i < n; i++) out[n - 1 - i] = bytes1(uint8(x >> (8 * i)));
    }

    function _concatRaw(RLPReader.RLPItem[] memory items, uint256 count) internal pure returns (bytes memory body) {
        for (uint256 i; i < count; i++) body = bytes.concat(body, RLPReader.readRawBytes(items[i]));
    }

    function _wrapList(bytes memory body) internal pure returns (bytes memory) {
        uint256 len = body.length;
        if (len < 56) return bytes.concat(bytes1(uint8(0xc0 + len)), body);
        bytes memory be = _bigEndian(len);
        return bytes.concat(bytes1(uint8(0xf7 + be.length)), be, body);
    }
}
