import { KeeperHubClient } from '@blackbox/core';
import { privateKeyToAccount } from 'viem/accounts';
const account = privateKeyToAccount(process.env.CHAOS_SIGNER_PRIVATE_KEY);
console.error('address', account.address);
const kh = new KeeperHubClient();
const r = await kh.login({ address: account.address, signMessage: (m) => account.signMessage({ message: m }) });
console.log(r.cookie);
