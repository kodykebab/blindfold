import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mnemonicToAccount } from 'viem/accounts'
import { openBackup, readBackupFile, sealBackup, writeBackup } from '../backup.mjs'
import { TEST_MNEMONIC } from '../lib.mjs'

const dep = { chainId: 31337, settlement: `0x${'AB'.repeat(20)}` }
const wallet = (i) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i })
const me = wallet(10)
const text = JSON.stringify({ commitments: [{ hash: '0x01', salt: '0x02' }] })

test('a backup opens with the same wallet on another device, and only for its own deployment and owner', async () => {
  const b = await sealBackup({ dep, owner: me.address, account: me, text })
  assert.doesNotMatch(JSON.stringify(b), /0x02/, 'salts are not in the clear')
  // a fresh account object from the same wallet: what a new device would have
  assert.equal(await openBackup(b, { dep, owner: me.address, account: wallet(10) }), text)
  await assert.rejects(openBackup(b, { dep, owner: me.address, account: wallet(11) }), /does not decrypt/)
  await assert.rejects(openBackup(b, { dep, owner: wallet(11).address, account: wallet(11) }), /belongs to/)
  await assert.rejects(openBackup(b, { dep: { ...dep, chainId: 1 }, owner: me.address, account: me }), /another chain/)
  await assert.rejects(openBackup({ ...b, kind: 'x' }, { dep, owner: me.address, account: me }), /not a Blindfold backup/)
})

test('any change to the ciphertext or its header makes a backup fail to decrypt', async () => {
  const b = await sealBackup({ dep, owner: me.address, account: me, text })
  const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1)
  for (const changed of [
    { ...b, tag: flip(b.tag) },
    { ...b, iv: flip(b.iv) },
    { ...b, salt: flip(b.salt) },
    { ...b, ciphertext: Buffer.from(Buffer.from(b.ciphertext, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64') },
  ]) await assert.rejects(openBackup(changed, { dep, owner: me.address, account: me }), /does not decrypt/)
})

test('a passphrase can replace the wallet key', async () => {
  const b = await sealBackup({ dep, owner: me.address, account: me, text, passphrase: 'correct horse' })
  assert.equal(b.kdf, 'scrypt')
  assert.equal(await openBackup(b, { dep, owner: me.address, account: wallet(11), passphrase: 'correct horse' }), text)
  await assert.rejects(openBackup(b, { dep, owner: me.address, account: me, passphrase: 'wrong' }), /does not decrypt/)
  await assert.rejects(openBackup(b, { dep, owner: me.address, account: me }), /CLIENT_BACKUP_PASSPHRASE/)
})

test('the backup file is written atomically with owner-only permissions', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'blindfold-backup-')), 'nested')
  try {
    const path = await writeBackup({ dep, owner: me.address, account: me, text, dir })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(await openBackup(readBackupFile(path), { dep, owner: me.address, account: me }), text)
    // a second write replaces the first in place
    assert.equal(await writeBackup({ dep, owner: me.address, account: me, text: '{}', dir }), path)
    assert.equal(await openBackup(readBackupFile(path), { dep, owner: me.address, account: me }), '{}')
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }) }
})
